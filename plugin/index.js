// tool-ssh-remote: remote-Linux-only execution for the `ssh-remote` preset.
//
// Lives inside the preset directory and resolves `ssh2` from the preset's own
// node_modules (installed with `npm install --omit=optional --ignore-scripts`,
// pure-JS crypto via Node's built-in module). It deliberately imports NOTHING
// from the harness: tool definitions are plain `ToolDefinition` objects handed
// to the host `tools` registry, so no harness package resolution is needed.
//
// The plugin publishes no service; it only consumes the host `tools` registry,
// so it sits loose in the preset with no realm. Connections are keyed by the
// calling agent's SessionId inside this module, because a preset's standing
// mount is shared by every session that names it.

import { Client } from 'ssh2'
import { appendFileSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { appendFile, mkdir as fsMkdir, open as fsOpen, readFile, readdir, stat as fsStat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { posix } from 'node:path'
import { isAbsolute as pathIsAbsolute, relative as pathRelative, resolve as pathResolve } from 'node:path'

const HERE = fileURLToPath(new URL('.', import.meta.url))

const PLUGIN_NAME = 'tool-ssh-remote'
const INJECT = ['tools']

/** Workspaces that ever hosted an ssh-remote session — the panel reads the
 * .ssh-remote journal directories directly, so history survives restarts. */
const DSH_HOME = process.env.DSH_HOME ?? pathResolve(homedir(), '.dsh')
const WORKSPACE_REGISTRY = process.env.DSH_SSH_REMOTE_REGISTRY
  ?? pathResolve(DSH_HOME, 'ssh-remote-workspaces.json')

const CONNECT_TIMEOUT_MS = 20_000
const DEFAULT_EXEC_TIMEOUT_MS = 120_000
const MAX_EXEC_TIMEOUT_MS = 600_000
const STREAM_CAP_CHARS = 512 * 1024
const MAX_READ_BYTES = 8 * 1024 * 1024
const DEFAULT_READ_LIMIT = 2000
const KEEPALIVE_INTERVAL_MS = 15_000
const KEEPALIVE_COUNT_MAX = 6

/** One session's SSH connection state; keyed by the calling agent's id. */
const connections = new Map()

function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function notConnectedError() {
  return new Error(
    'SSH: this session has no active server connection. Call ssh_connect first '
    + '(if you do not have credentials yet, ask the user for host/port/username/password via ask_user_question). '
    + 'If the connection recently dropped, retry ssh_connect with the credentials you already have.',
  )
}

function requireAgentId(exec) {
  const id = exec?.agent?.id
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('SSH: no agent identity on this tool call; cannot key the connection.')
  }
  return id
}

/** Remote background jobs this plugin is currently observing, by agent. */
const activeJobs = new Set()

/** Close and forget one session's connection (idempotent). */
function closeConnection(agentId) {
  const conn = connections.get(agentId)
  if (conn === undefined) return
  connections.delete(agentId)
  conn.sftp = null
  for (const job of [...activeJobs]) {
    if (job.agentId !== agentId) continue
    try {
      job.stop()
    } catch {}
  }
  try {
    conn.client.end()
  } catch {
    // already gone
  }
}

function closeAllConnections() {
  for (const job of [...activeJobs]) {
    try {
      job.stop()
    } catch {}
  }
  for (const agentId of [...connections.keys()]) closeConnection(agentId)
}

const POLL_MARKER = '\u001e'

/**
 * Start one detached remote command and adapt it to the harness JobHooks
 * contract (`ctx.jobs`): the command runs on the server inside its own
 * session via `setsid`, so closing SSH channels never SIGHUPs it. Output
 * appends to `<dir>/output.log` while the wrapper records its pid and final
 * exit status beside it; a poll loop tails the log (base64 for byte-exact
 * UTF-8 deltas) and settles `done` once the process exits.
 *
 * Managed jobs are cancelled by `job_kill` and by agent disposal. Anything
 * the model starts itself through plain foreground ssh_bash calls (nohup,
 * screen, tmux) is not tracked and survives this session by design.
 */
function startRemoteBackgroundJob(agentId, command, transcript = null, meta = null) {
  const dir = `/tmp/.dsh-jobs/${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const startedAt = new Date()
  const decoder = new TextDecoder()
  // Per-job full-output log on the local side (transcript B+D hybrid).
  const jobFile = transcript === null ? null
    : pathResolve(transcript.jobsDir, `job-${fileStamp(startedAt)}-${Math.random().toString(36).slice(2, 6)}.log`)
  const jobFileRel = jobFile === null ? null
    : `${TRANSCRIPT_DIR}/${pathRelative(transcript.baseDir, jobFile).split('\\').join('/')}`
  if (meta !== null) {
    meta.jobFile = jobFile
    meta.jobFileRel = jobFileRel
  }
  let jobFileBytes = 0
  let jobFileCapped = false
  let recent = ''
  const wrapper = `umask 077 && mkdir -p -- ${shQuote(dir)}; `
    + `printf %s "$$" > ${shQuote(`${dir}/pid`)}; `
    + `{ ${command}\n} > ${shQuote(`${dir}/output.log`)} 2>&1 < /dev/null; `
    + `printf %s "$?" > ${shQuote(`${dir}/status`)}`
  // Background `setsid` directly (not an AND-list): the forked child calls
  // setsid() before anything else, so sshd tearing down the exec channel's
  // process group the instant the shell exits cannot reach the wrapper.
  const launch = `setsid sh -c ${shQuote(wrapper)} < /dev/null > /dev/null 2>&1 &`
  const pollCommand = (cursor) => `D=${shQuote(dir)}; `
    + 'if [ -f "$D/status" ]; then printf S; cat "$D/status"; '
    + 'elif [ ! -f "$D/pid" ]; then printf P; '
    + 'elif kill -0 "$(cat "$D/pid")" 2>/dev/null; then printf R; '
    + 'else printf D; fi; '
    + `printf '${POLL_MARKER}'; `
    + (cursor > 0
      ? `[ -f "$D/output.log" ] && tail -c +${cursor + 1} "$D/output.log" 2>/dev/null`
      : `cat "$D/output.log" 2>/dev/null`)
    + ` | base64 | tr -d '\\n'`
  const killCommand = `D=${shQuote(dir)}; if [ -f "$D/pid" ]; then kill -- -"$(cat "$D/pid")" 2>/dev/null; kill "$(cat "$D/pid")" 2>/dev/null; fi; true`

  let cursor = 0
  let pending = ''
  let cancelled = false
  let finished = false
  let timer = null
  let failures = 0
  let pendingTicks = 0
  let resolveDone
  const done = new Promise((resolve) => {
    resolveDone = resolve
  })

  const job = {
    agentId,
    stop: () => {},
  }

  /** Stream one decoded delta into the local job log (byte-capped). */
  const journalDelta = (text) => {
    recent = (recent + text).slice(-TRANSCRIPT_JOB_TAIL_CHARS)
    if (meta !== null) meta.tail = recent
    if (jobFile === null || jobFileCapped || text.length === 0) return
    let chunk = text
    if (jobFileBytes + chunk.length > TRANSCRIPT_JOB_FILE_CAP) {
      chunk = text.slice(0, Math.max(0, TRANSCRIPT_JOB_FILE_CAP - jobFileBytes))
      jobFileCapped = true
    }
    transcript.chain = transcript.chain.then(async () => {
      try {
        if (!transcript.ready) await fsMkdir(transcript.jobsDir, { recursive: true })
        transcript.ready = true
        if (chunk.length > 0) await appendFile(jobFile, chunk, 'utf8')
        if (jobFileCapped && text.length > chunk.length) {
          await appendFile(jobFile, `\n[job log reached its ${TRANSCRIPT_JOB_FILE_CAP}-byte cap; further output suppressed]\n`, 'utf8')
        }
      } catch {
        transcript.ready = false
      }
    })
    jobFileBytes += chunk.length
  }

  /** Completion block for the MAIN transcript (B+D hybrid settle record). */
  const journalSettle = (outcome) => {
    if (transcript === null) return
    const tail = recent.length > 0 ? `\n${capTranscriptStream(recent)}\n` : ''
    const pointer = jobFile === null ? '' : ` (full output: ${jobFileRel})`
    const idSuffix = meta !== null && meta.id !== null ? `job ${meta.id} ` : ''
    writeTranscript(transcript,
      `[${localStamp()}] (background ${idSuffix}${outcome.status}${outcome.detail !== undefined ? `, ${outcome.detail}` : ''} — started ${localStamp(startedAt)})${pointer}\n`
      + `${tail}`)
  }

  const finish = (outcome, cleanup) => {
    if (finished) return
    finished = true
    if (timer !== null) clearTimeout(timer)
    activeJobs.delete(job)
    if (meta !== null) {
      meta.status = outcome.status
      meta.detail = outcome.detail ?? ''
      meta.endedAt = Date.now()
    }
    journalSettle(outcome)
    if (cleanup) {
      remoteExec(agentId, `rm -rf -- ${shQuote(dir)}`, { timeoutMs: 10_000 }).catch(() => {})
    }
    resolveDone(outcome)
  }

  const poll = async () => {
    if (finished) return
    try {
      const result = await remoteExec(agentId, pollCommand(cursor), { timeoutMs: 15_000 })
      failures = 0
      const marker = result.stdout.indexOf(POLL_MARKER)
      if (marker < 0) throw new Error('malformed poll result')
      const state = result.stdout.slice(0, marker)
      const b64 = result.stdout.slice(marker + 1)
      if (b64.length > 0) {
        const bytes = Buffer.from(b64, 'base64')
        cursor += bytes.length
        const text = decoder.decode(bytes, { stream: true })
        journalDelta(text)
        pending += text
        if (pending.length > PENDING_CAP_CHARS) {
          pending = `[...earlier unread output dropped after ${PENDING_CAP_CHARS} chars; full copy in the job log...]\n${pending.slice(-PENDING_CAP_CHARS)}`
        }
      }
      if (state.startsWith('S')) {
        finish({ status: 'completed', detail: `exit code: ${state.slice(1).trim()}` }, true)
        return
      }
      if (state === 'D') {
        finish(cancelled
          ? { status: 'killed', detail: 'killed by request' }
          : { status: 'completed', detail: 'no exit code (process died without writing status)' }, true)
        return
      }
      if (state === 'P') {
        pendingTicks += 1
        if (pendingTicks >= 5) {
          finish({ status: 'failed', detail: 'the remote job never started (setsid or the wrapper shell may be missing on the server)' }, true)
        }
      }
    } catch {
      failures += 1
      if (cancelled && failures >= 2) {
        finish({ status: 'killed', detail: 'killed by request' }, true)
        return
      }
      if (failures >= 3) {
        finish({ status: 'failed', detail: 'lost the SSH connection while the remote job was running; the remote process may still be alive' }, true)
        return
      }
    }
    if (!finished) timer = setTimeout(poll, 1500)
  }

  const cancel = () => {
    if (finished || cancelled) return
    cancelled = true
    remoteExec(agentId, killCommand, { timeoutMs: 10_000 }).catch(() => {})
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(poll, 400)
  }

  // Connection teardown observer: settle without touching the remote again.
  job.stop = () => finish(
    { status: 'failed', detail: 'the SSH connection or plugin was torn down; the remote process may still be alive' },
    false,
  )

  activeJobs.add(job)
  if (transcript !== null) {
    writeTranscript(transcript,
      `[${localStamp(startedAt)}] $ (background) ${command}\n`
      + `${jobFileRel !== null ? `[${localStamp(startedAt)}] # job output streams to ${jobFileRel}\n` : ''}`)
  }
  remoteExec(agentId, launch, { timeoutMs: 15_000 }).catch(() => {})
    .finally(() => {
      if (!finished) timer = setTimeout(poll, 250)
    })

  return {
    cancel,
    done,
    readOutput() {
      const delta = pending
      pending = ''
      return delta
    },
  }
}

/**
 * Open one SSH connection with password auth (plus keyboard-interactive
 * fallback for servers that disallow plain password requests).
 */
function openConnection({ host, port, username, password, timeoutMs }, signal) {
  return new Promise((resolve, reject) => {
    const client = new Client()
    let settled = false
    const settle = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      fn(value)
    }
    const failWith = (error) => settle(reject, new Error(
      `SSH connect to ${username}@${host}:${port} failed: ${error?.message ?? String(error)}`,
      { cause: error },
    ))
    const timer = setTimeout(() => {
      try {
        client.end()
      } catch {}
      settle(reject, new Error(`SSH connect to ${username}@${host}:${port} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    const onAbort = () => {
      try {
        client.end()
      } catch {}
      settle(reject, new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    client.on('ready', () => settle(resolve, client))
    client.on('error', (error) => failWith(error))
    client.on('close', () => {
      if (!settled) failWith(new Error('connection closed during handshake'))
    })
    client.on('keyboard-interactive', (_name, _instructions, _lang, prompts, finish) => {
      finish(prompts.map(() => password))
    })
    client.connect({
      host,
      port,
      username,
      password,
      readyTimeout: timeoutMs,
      keepaliveInterval: KEEPALIVE_INTERVAL_MS,
      keepaliveCountMax: KEEPALIVE_COUNT_MAX,
    })
  })
}

/**
 * Run one command on the session's connection. Fresh shell per call; output
 * streams keep their tail under STREAM_CAP_CHARS with a truncated flag.
 */
function remoteExec(agentId, command, { timeoutMs = DEFAULT_EXEC_TIMEOUT_MS, signal } = {}) {
  const conn = connections.get(agentId)
  if (conn === undefined) return Promise.reject(notConnectedError())
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let outLen = 0
    let errLen = 0
    let outTruncated = false
    let errTruncated = false
    let timedOut = false
    let settled = false
    conn.client.exec(command, (err, stream) => {
      if (err) return reject(err)
      let timer = null
      const kill = (byTimeout) => {
        if (timedOut) return
        timedOut = byTimeout === true
        try {
          stream.signal('KILL')
        } catch {}
        stream.close()
      }
      if (timeoutMs > 0) timer = setTimeout(() => kill(true), timeoutMs)
      const onAbort = () => kill(false)
      signal?.addEventListener('abort', onAbort, { once: true })
      const finish = () => {
        if (settled) return
        settled = true
        if (timer !== null) clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
      }
      stream.stdout.setEncoding('utf8')
      stream.stderr.setEncoding('utf8')
      stream.stdout.on('data', (chunk) => {
        outLen += chunk.length
        if (outLen > STREAM_CAP_CHARS) outTruncated = true
        stdout = (stdout + chunk).slice(-STREAM_CAP_CHARS)
      })
      stream.stderr.on('data', (chunk) => {
        errLen += chunk.length
        if (errLen > STREAM_CAP_CHARS) errTruncated = true
        stderr = (stderr + chunk).slice(-STREAM_CAP_CHARS)
      })
      stream.on('error', (error) => {
        finish()
        reject(error)
      })
      stream.on('close', (exitCode, signalName) => {
        finish()
        if (signal?.aborted) return reject(new Error('aborted'))
        resolve({
          exitCode: typeof exitCode === 'number' ? exitCode : null,
          signal: typeof signalName === 'string' ? signalName : null,
          timedOut,
          timeoutMs,
          stdout,
          stderr,
          stdoutTruncated: outTruncated,
          stderrTruncated: errTruncated,
        })
      })
    })
  })
}

/** Lazily opened SFTP channel for one session's connection. */
async function getSftp(agentId) {
  const conn = connections.get(agentId)
  if (conn === undefined) throw notConnectedError()
  if (conn.sftp === null) {
    conn.sftp = new Promise((resolve, reject) => {
      conn.client.sftp((error, sftp) => {
        if (error) {
          conn.sftp = null
          reject(error)
        } else {
          resolve(sftp)
        }
      })
    })
  }
  return conn.sftp
}

async function sftpCall(agentId, operation) {
  const sftp = await getSftp(agentId)
  try {
    return await operation(sftp)
  } catch (error) {
    // The channel is suspect after any failure; reopen it on the next call.
    const conn = connections.get(agentId)
    if (conn !== undefined) conn.sftp = null
    throw error
  }
}

function sftpStat(agentId, remotePath) {
  return sftpCall(agentId, (sftp) => new Promise((resolve, reject) => {
    sftp.stat(remotePath, (error, stats) => (error ? reject(error) : resolve(stats)))
  }))
}

function sftpReadText(agentId, remotePath, maxBytes) {
  return sftpCall(agentId, (sftp) => new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    let truncated = false
    const stream = sftp.createReadStream(remotePath, { encoding: 'utf8' })
    stream.on('data', (chunk) => {
      total += chunk.length
      if (total > maxBytes) {
        truncated = true
        stream.destroy(new Error(`file exceeds ${maxBytes} bytes`))
        return
      }
      chunks.push(chunk)
    })
    stream.on('error', reject)
    stream.on('end', () => resolve({ text: chunks.join(''), truncated }))
  }))
}

function sftpWriteText(agentId, remotePath, content) {
  return sftpCall(agentId, (sftp) => new Promise((resolve, reject) => {
    const stream = sftp.createWriteStream(remotePath, { encoding: 'utf8' })
    stream.on('error', reject)
    stream.on('close', () => resolve())
    stream.end(content)
  }))
}

async function sftpEnsureRemoteDir(agentId, remotePath) {
  const parent = posix.dirname(remotePath)
  if (parent === '' || parent === '.' || parent === remotePath) return
  await remoteExec(agentId, `mkdir -p -- ${shQuote(parent)}`).catch(() => {})
}

function sftpFastPut(agentId, localPath, remotePath) {
  return sftpCall(agentId, (sftp) => new Promise((resolve, reject) => {
    sftp.fastPut(localPath, remotePath, (error) => (error ? reject(error) : resolve()))
  }))
}

function sftpFastGet(agentId, remotePath, localPath) {
  return sftpCall(agentId, (sftp) => new Promise((resolve, reject) => {
    sftp.fastGet(remotePath, localPath, (error) => (error ? reject(error) : resolve()))
  }))
}

/** Local-side guard: resolve within the session workspace and reject escapes. */
function resolveLocalWithinWorkspace(exec, localPath) {
  const cwd = exec?.agent?.session?.header?.cwd
  if (typeof cwd !== 'string' || cwd.length === 0) {
    throw new Error('SFTP transfer: this session has no local workspace set; local file transfer is unavailable.')
  }
  const resolved = pathIsAbsolute(localPath) ? pathResolve(localPath) : pathResolve(cwd, localPath)
  const rel = pathRelative(cwd, resolved)
  if (rel.startsWith('..') || pathIsAbsolute(rel)) {
    throw new Error(`SFTP transfer: local path escapes the session workspace (${cwd}): ${localPath}. Local file access in this mode is limited to the session workspace.`)
  }
  return resolved
}

function renderExecResult(value) {
  const parts = []
  if (value.stdout.length > 0) parts.push(value.stdout)
  if (value.stderr.length > 0) {
    if (parts.length > 0 && !parts[parts.length - 1].endsWith('\n')) parts.push('\n')
    parts.push(`[stderr]\n${value.stderr}`)
  }
  let body = parts.join('')
  if (body.length === 0) body = '(no output)'
  const markers = []
  if (value.stdoutTruncated) markers.push('[stdout truncated; kept the last 512KB of output]')
  if (value.stderrTruncated) markers.push('[stderr truncated; kept the last 512KB of output]')
  if (value.timedOut) markers.push(`[timed out after ${value.timeoutMs}ms]`)
  if (value.signal !== null) markers.push(`[killed by signal: ${value.signal}]`)
  else if (value.exitCode !== 0) {
    if (value.exitCode !== null) markers.push(`[exit code: ${value.exitCode}]`)
    else if (!value.timedOut) markers.push('[no exit code — the connection may have dropped; reconnect with ssh_connect if needed]')
  }
  if (markers.length === 0) return body
  if (!body.endsWith('\n')) body += '\n'
  return body + markers.join('\n')
}

// ── local session transcript ─────────────────────────────────────────────────
// Every remote command, file operation, and transfer is journaled into a
// terminal-style transcript under <workspace>/.ssh-remote/, one append-only
// file per session in time order. Managed background jobs (B+D hybrid):
// a "started" marker lands in the main transcript immediately, the full
// output streams into .ssh-remote/jobs/<job>.log (byte-capped), and a
// completion block (start/end times, exit status, capped tail, pointer to
// the job file) is appended when the job settles — including kills.
// Transcript failures never fail a tool call.

const TRANSCRIPT_DIR = '.ssh-remote'
const TRANSCRIPT_JOBS_DIR = 'jobs'
const TRANSCRIPT_STREAM_CAP = 8 * 1024
const TRANSCRIPT_JOB_TAIL_CHARS = 4 * 1024
const TRANSCRIPT_JOB_FILE_CAP = 2 * 1024 * 1024
const PENDING_CAP_CHARS = 512 * 1024

/** Per-session transcript state, keyed by agent id (resume appends on). */
const transcripts = new Map()

function pad2(value) {
  return String(value).padStart(2, '0')
}

function localStamp(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} `
    + `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
}

function fileStamp(date = new Date()) {
  return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}`
    + `-${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`
}

function safeId(id) {
  return String(id).replace(/[^a-zA-Z0-9-]/g, '').slice(-24) || 'session'
}

/** Deterministic per-session journal name: one file per session across
 * reconnects and host restarts (appended, never re-created). Session ids
 * already start with "session-", so no extra prefix is glued on. */
function sanitizeFullId(id) {
  const s = String(id).replace(/[^a-zA-Z0-9-]/g, '')
  if (s.length <= 64) return s || 'session'
  return `${s.slice(0, 64)}-${createHash('md5').update(String(id)).digest('hex').slice(0, 8)}`
}

function sessionFileName(agentId) {
  return `dsr-${sanitizeFullId(agentId)}.log`
}

/** One-time migration: merge every earlier journal segment for this session
 * (legacy timestamp-named files and earlier deterministic names) into the
 * deterministic file, in chronological order. */
function adoptLegacyJournal(baseDir, agentId, targetFile) {
  try {
    const targetName = baseName(targetFile)
    const fullId = sanitizeFullId(agentId)
    const segments = []
    for (const name of readdirSync(baseDir)) {
      if (!name.endsWith('.log') || name === targetName) continue
      if (name.startsWith('job-') || name.startsWith('dsr-')) continue
      let tail = name.slice(0, -'.log'.length)
      if (!tail.startsWith('session-')) continue
      tail = tail.slice('session-'.length).replace(/^\d{8}-\d{6}-/, '')
      if (tail.length < 8 || tail === 'session') continue
      if (fullId.endsWith(tail)) segments.push(name)
    }
    if (segments.length === 0) return
    segments.sort()
    const parts = []
    for (const name of segments) {
      try {
        parts.push(readFileSync(pathResolve(baseDir, name), 'utf8'))
      } catch {}
    }
    let existing = ''
    try {
      existing = readFileSync(targetFile, 'utf8')
    } catch {}
    writeFileSync(targetFile, parts.join('') + existing, 'utf8')
    for (const name of segments) {
      try {
        unlinkSync(pathResolve(baseDir, name))
      } catch {}
    }
  } catch {}
}

function transcriptState(agentId, workspace) {
  let state = transcripts.get(agentId)
  if (state === undefined) {
    const baseDir = pathResolve(workspace, TRANSCRIPT_DIR)
    const file = pathResolve(baseDir, sessionFileName(agentId))
    adoptLegacyJournal(baseDir, agentId, file)
    state = {
      workspace,
      baseDir,
      file,
      jobsDir: pathResolve(baseDir, TRANSCRIPT_JOBS_DIR),
      ready: false,
      chain: Promise.resolve(),
    }
    transcripts.set(agentId, state)
    registerWorkspace(workspace)
  }
  return state
}

/** Remember a workspace so the panel can discover its journals after restarts. */
function registerWorkspace(workspace) {
  let list = []
  try {
    list = JSON.parse(readFileSync(WORKSPACE_REGISTRY, 'utf8'))
  } catch {}
  if (Array.isArray(list) && list.includes(workspace)) return
  const next = [...(Array.isArray(list) ? list : []), workspace]
  try {
    writeFileSync(WORKSPACE_REGISTRY, JSON.stringify(next, null, 2), 'utf8')
  } catch {}
}

async function knownWorkspaces(ctx = null) {
  const out = []
  const add = (ws) => {
    if (typeof ws === 'string' && ws.length > 0 && !out.includes(ws)) out.push(ws)
  }
  try {
    const list = JSON.parse(await readFile(WORKSPACE_REGISTRY, 'utf8'))
    if (Array.isArray(list)) list.forEach(add)
  } catch {}
  // The host's durable workspace registry is the authoritative discovery
  // source: journals written before this plugin tracked workspaces (and
  // workspaces whose session never reconnected) are still found through it.
  if (ctx !== null) {
    const registry = ctx.get('workspaceRegistry')
    if (registry !== undefined) {
      try {
        const workspaces = await registry.list()
        if (Array.isArray(workspaces)) {
          for (const ws of workspaces) add(typeof ws?.path === 'string' ? ws.path : undefined)
        }
      } catch {}
    }
  }
  return out
}

/** True when `file` resolves strictly inside `dir`. */
function underDir(dir, file) {
  const rel = pathRelative(pathResolve(dir), pathResolve(file))
  return rel !== '' && !rel.startsWith('..') && !pathIsAbsolute(rel)
}

function baseName(file) {
  return String(file).split(/[\\/]/).pop() ?? ''
}

/** A readable journal file under some known workspace's .ssh-remote dir. */
async function validJournalFile(file, { jobs = false } = {}, ctx = null) {
  if (typeof file !== 'string' || file.length === 0) return false
  const name = baseName(file)
  if (!name.endsWith('.log')) return false
  const prefixOk = jobs
    ? name.startsWith('job-')
    : (name.startsWith('session-') || name.startsWith('dsr-'))
  if (!prefixOk) return false
  for (const ws of await knownWorkspaces(ctx)) {
    const dir = pathResolve(ws, TRANSCRIPT_DIR, jobs ? TRANSCRIPT_JOBS_DIR : '')
    if (underDir(dir, file)) {
      const stats = await fsStat(file).catch(() => null)
      return stats !== null && stats.isFile()
    }
  }
  return false
}

/** Short-lived caches so the panel's sub-second conversation-switch polling
 * stays cheap: disk discovery and title resolution repeat identical work
 * almost every call, and nothing on disk or in the title folds changes
 * within a second. */
const DISCOVERY_TTL_MS = 1200
const discoveryCache = new Map()

/** Sessions discovered purely from journal files on disk (post-restart view). */
async function discoverDiskSessions(ctx = null) {
  const workspaces = await knownWorkspaces(ctx)
  const now = Date.now()
  const fresh = []
  const stale = []
  for (const ws of workspaces) {
    const hit = discoveryCache.get(ws)
    if (hit !== undefined && hit.expires > now) fresh.push([ws, hit.rows])
    else stale.push(ws)
  }
  if (stale.length > 0) {
    const found = await Promise.all(stale.map((ws) => discoverWorkspaceSessions(ws)))
    stale.forEach((ws, i) => {
      discoveryCache.set(ws, { expires: now + DISCOVERY_TTL_MS, rows: found[i] })
      fresh.push([ws, found[i]])
    })
  }
  return fresh.flatMap(([, rows]) => rows)
}

async function discoverWorkspaceSessions(ws) {
  const rows = []
  const dir = pathResolve(ws, TRANSCRIPT_DIR)
  let names
  try {
    names = await readdir(dir)
  } catch {
    return rows
  }
  for (const name of names) {
    if (!name.endsWith('.log')) continue
    // dsr-<fullSanitizedId> is the current deterministic form (agentId is
    // exact); session-<stamp>-<tail> and session-<fullId> are legacy forms.
    let agentId = null
    if (name.startsWith('dsr-')) {
      agentId = name.slice('dsr-'.length, -'.log'.length)
    } else if (name.startsWith('session-')) {
      agentId = name.slice('session-'.length, -'.log'.length).replace(/^\d{8}-\d{6}-/, '')
    }
    if (agentId === null || agentId.length === 0) continue
    const file = pathResolve(dir, name)
    const stats = await fsStat(file).catch(() => null)
    if (stats === null) continue
    let userAtHost = ''
    try {
      const fh = await fsOpen(file, 'r')
      const buf = Buffer.alloc(4096)
      const { bytesRead } = await fh.read(buf, 0, 4096, 0)
      await fh.close()
      const m = /connected (\S+@\S+:\d+)/.exec(buf.subarray(0, bytesRead).toString('utf8'))
      if (m !== null) userAtHost = m[1]
    } catch {}
    rows.push({
      agentId: agentId || name,
      workspace: ws,
      transcriptFile: file,
      size: stats.size,
      lastWrite: stats.mtimeMs,
      userAtHost,
      connected: false,
      historical: true,
    })
  }
  return rows
}

/** Serialize one append onto the session's chain; failures are swallowed. */
function writeTranscript(state, text) {
  state.chain = state.chain.then(async () => {
    try {
      if (!state.ready) await fsMkdir(state.jobsDir, { recursive: true })
      state.ready = true
      await appendFile(state.file, text, 'utf8')
    } catch {
      state.ready = false
    }
  })
  return state.chain
}

/** Transcript state for a tool call's exec, or null when journaling is off. */
function transcriptForExec(exec) {
  const workspace = exec?.agent?.session?.header?.cwd
  if (typeof workspace !== 'string' || workspace.length === 0) return null
  try {
    return transcriptState(requireAgentId(exec), workspace)
  } catch {
    return null
  }
}

function capTranscriptStream(text) {
  if (text.length <= TRANSCRIPT_STREAM_CAP) return text
  return `${text.slice(-TRANSCRIPT_STREAM_CAP)}\n[transcript keeps the last ${TRANSCRIPT_STREAM_CAP} chars of a ${text.length}-char stream]\n`
}

/** Terminal-style foreground command entry (command + rendered result). */
function transcriptCommandEntry({ hostLabel, workdir, command, value, error }) {
  const head = `[${localStamp()}] ${hostLabel}${workdir !== undefined ? ` ${workdir}` : ''}\n$ ${command}\n`
  if (error !== undefined) return `${head}[error] ${error.message === 'aborted' ? '[aborted]' : error.message}\n`
  return `${head}${capTranscriptStream(renderExecResult(value))}\n`
}

/** One terse comment line for file operations and transfers. */
function transcriptNote(text) {
  return `[${localStamp()}] # ${text}\n`
}

function parsePositiveInt(value, fallback, { max } = {}) {
  if (value === undefined || value === null) return fallback
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n) || n <= 0) throw new Error(`invalid ${JSON.stringify(value)}: expected a positive integer`)
  if (max !== undefined && n > max) throw new Error(`invalid ${JSON.stringify(value)}: exceeds the maximum of ${max}`)
  return n
}

function contentText(result) {
  const block = result?.content?.[0]
  return block !== undefined && block.type === 'text' ? block.text : undefined
}

const NULLABLE = (type) => ({ oneOf: [{ type }, { type: 'null' }] })

// ── web panel: right-side terminal replay inside the GUI ─────────────────────
// A preset cannot ship a built client bundle (client modules are host-
// composition loader entries), but the host `webServer` service is consumable
// from a preset row exactly like the tools registry: one prefix route serves
// the panel assets plus a small JSON API over this plugin's in-memory session
// state, and one tapIndex injects the asset tags into the GUI's index page.
// Same-origin and loopback-bound with the GUI itself; registrations are owned
// by this plugin fiber and disappear when the preset unmounts. A duplicate
// (kind, path) — another stacked generation of this preset in the same
// process — degrades to "no panel for this generation" instead of failing the
// whole row.

const PANEL_BASE = '/ssh-remote-panel'
const PANEL_TAIL_CAP = 512 * 1024

function sendJson(res, status, value) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(value))
}

function shortLabel(id) {
  const s = String(id).replace(/[^a-zA-Z0-9-]/g, '')
  return s.slice(0, 8) || 'session'
}

/** Best-effort "which conversation is the user looking at": the GUI header
 * breadcrumb shows the session title, and the host can resolve titles back to
 * session ids. The session+title catalog is cached briefly so the panel's
 * fast conversation-switch polling does not re-query the fold every call. */
let titleCatalog = { expires: 0, entries: [] }

async function sessionTitleCatalog(ctx) {
  if (titleCatalog.expires > Date.now()) return titleCatalog.entries
  const query = ctx.get('sessionQuery')
  if (query === undefined) return null
  try {
    const records = await query.listSessions()
    if (!Array.isArray(records)) return null
    const entries = []
    for (const record of records) {
      const id = record?.header?.id
      if (typeof id !== 'string' || id.length === 0) continue
      entries.push({ id, preset: record.header.agentPreset ?? '', live: record.live === true, title: '' })
    }
    if (entries.length === 0) return null
    const observations = await query.readTitleSnapshots(entries.map((e) => e.id)).catch(() => [])
    for (const obs of Array.isArray(observations) ? observations : []) {
      if (obs?.status !== 'fulfilled') continue
      const title = obs?.value?.title?.title
      if (typeof title !== 'string') continue
      const entry = entries.find((e) => e.id === obs.sessionId)
      if (entry !== undefined) entry.title = title
    }
    titleCatalog = { expires: Date.now() + DISCOVERY_TTL_MS, entries }
    return entries
  } catch {
    return null
  }
}

async function resolveCurrentSessionId(ctx, hint) {
  if (typeof hint !== 'string' || hint.trim().length === 0) return null
  const entries = await sessionTitleCatalog(ctx)
  if (entries === null || entries.length === 0) return null
  try {
    const needle = hint.trim()
    let pool = entries.filter((e) => e.title === needle)
    if (pool.length === 0) pool = entries.filter((e) => e.title !== '' && (needle.includes(e.title) || e.title.includes(needle)))
    if (pool.length === 0) return null
    pool.sort((a, b) => (Number(b.live) - Number(a.live)))
    return { id: pool[0].id }
  } catch {
    return null
  }
}

/** Authoritative "is this session RUNNING on the ssh-remote preset": the
 * roster's live composition binding, not the durable header (which this
 * deployment stamps as the default at creation regardless of selection). */
function sessionRunsSshRemote(ctx, sessionId) {
  const agents = ctx.get('agents')
  const presets = ctx.get('agentPresets')
  if (agents === undefined || presets === undefined) return false
  try {
    const agent = agents.get(sessionId)
    if (agent === undefined) return false
    return presets.composedPreset(agent.ctx) === 'ssh-remote'
  } catch {
    return false
  }
}

/** Live ssh-remote sessions: journal + connection state merged per agent. */
async function panelSessions(ctx = null, titleHint = '') {
  const rows = new Map()
  // Disk discovery first: every journal file that ever existed, including
  // sessions from before a restart and sessions whose connection is gone.
  for (const disk of await discoverDiskSessions(ctx)) {
    rows.set(disk.transcriptFile, disk)
  }
  // Live state wins for the same file: it knows the connection.
  for (const [agentId, st] of transcripts) {
    const row = rows.get(st.file) ?? {
      agentId,
      workspace: st.workspace,
      transcriptFile: st.file,
      connected: false,
      userAtHost: '',
      size: 0,
      lastWrite: 0,
      historical: false,
    }
    row.historical = false
    rows.set(st.file, row)
  }
  for (const [agentId, conn] of connections) {
    let matched = false
    for (const row of rows.values()) {
      if (row.agentId === agentId && row.historical === false) {
        row.connected = true
        row.userAtHost = `${conn.info.username}@${conn.info.host}:${conn.info.port}`
        matched = true
      }
    }
    if (!matched) {
      rows.set(`live:${agentId}`, {
        agentId,
        workspace: null,
        transcriptFile: null,
        connected: true,
        userAtHost: `${conn.info.username}@${conn.info.host}:${conn.info.port}`,
        size: 0,
        lastWrite: Date.now(),
        historical: false,
      })
    }
  }
  const list = [...rows.values()]
  await Promise.all(list.map(async (row) => {
    if (typeof row.transcriptFile !== 'string') return
    try {
      const stats = await fsStat(row.transcriptFile)
      row.size = stats.size
      if (row.lastWrite === 0) row.lastWrite = stats.mtimeMs
    } catch {}
  }))
  for (const row of list) {
    const who = row.userAtHost !== '' ? row.userAtHost : shortLabel(row.agentId)
    const size = row.size > 0 ? ` · ${Math.max(1, Math.round(row.size / 1024))}KB` : ''
    row.label = `${row.connected ? '● ' : '○ '}${who}${size}${row.historical ? ' · 历史' : ''}`
  }
  list.sort((a, b) => (Number(b.connected) - Number(a.connected)) || (b.lastWrite - a.lastWrite))
  const capped = list.slice(0, 40)
  // "Current conversation" resolution — PRECISE ONLY: the GUI breadcrumb title
  // resolves to a session id, and the LIVE composition binding confirms that
  // session runs the ssh-remote preset. No global fallback: "any connected
  // ssh session" would show the tab in every conversation. An unmatched
  // breadcrumb (blank conversation, non-ssh conversation) means hidden.
  const matched = await resolveCurrentSessionId(ctx, titleHint)
  let currentId = matched !== null ? matched.id : null
  let currentIsSsh = currentId !== null && sessionRunsSshRemote(ctx, currentId)
  if (currentId !== null && !currentIsSsh) currentId = null
  if (currentId !== null) {
    const currentTag = safeId(currentId)
    const currentFull = sanitizeFullId(currentId)
    for (const row of capped) {
      if (row.agentId === currentId || row.agentId === currentTag || row.agentId === currentFull) {
        row.current = true
        row.label = `${row.label} · 当前会话`
      }
    }
  }
  return { rows: capped, currentIsSsh }
}

/** Transcript tail by character offset; the panel keeps its own cursor. */
async function panelTranscript(agentId, offset) {
  const st = transcripts.get(agentId)
  if (st === undefined) {
    if (connections.has(agentId)) return { length: 0, text: '', note: 'connected but nothing journaled yet' }
    return null
  }
  let text
  try {
    text = await readFile(st.file, 'utf8')
  } catch {
    return { length: 0, text: '', note: 'transcript not readable yet' }
  }
  const length = text.length
  if (offset > length) return { length, text, reset: true }
  if (length - offset > PANEL_TAIL_CAP) {
    return { length, text: text.slice(-PANEL_TAIL_CAP), skipped: length - offset - PANEL_TAIL_CAP }
  }
  return { length, text: text.slice(offset) }
}

/** Transcript by journal FILE path (validated against known workspaces), so
 * the panel can read sessions that predate this process. */
async function panelTranscriptFile(file, offset, ctx = null) {
  if (!(await validJournalFile(file, {}, ctx))) return null
  const text = await readFile(file, 'utf8').catch(() => null)
  if (text === null) return { length: 0, text: '' }
  const length = text.length
  if (offset > length) return { length, text, reset: true }
  if (length - offset > PANEL_TAIL_CAP) {
    return { length, text: text.slice(-PANEL_TAIL_CAP), skipped: length - offset - PANEL_TAIL_CAP }
  }
  return { length, text: text.slice(offset) }
}

function panelIndexHtml() {
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1.0">'
    + '<title>SSH Remote · 终端</title>'
    + `<link rel="stylesheet" href="${PANEL_BASE}/panel.css">`
    + `<script defer src="${PANEL_BASE}/panel.js"></script>`
    + '<style>html,body{margin:0;height:100%;background:#0d1117;}</style>'
    + '</head><body></body></html>'
}

/** Panel-visible managed-job metadata, keyed by harness job id. */
const panelJobs = new Map()

function trimPanelJobs() {
  if (panelJobs.size <= 150) return
  const settled = [...panelJobs.entries()]
    .filter(([, meta]) => meta.status !== 'running')
    .sort((a, b) => a[1].startedAt - b[1].startedAt)
  for (const [id] of settled) {
    panelJobs.delete(id)
    if (panelJobs.size <= 120) break
  }
}

function panelJobRows(liveOnly) {
  const rows = []
  for (const meta of panelJobs.values()) {
    if (liveOnly !== null && meta.agentId !== liveOnly) continue
    rows.push({
      id: meta.id,
      agentId: meta.agentId,
      label: meta.label,
      status: meta.status,
      detail: meta.detail,
      startedAt: meta.startedAt,
      endedAt: meta.endedAt,
      jobFileRel: meta.jobFileRel,
      tail: meta.status === 'running' ? meta.tail : '',
      historical: false,
    })
  }
  rows.sort((a, b) => b.startedAt - a.startedAt)
  return rows
}

/** Jobs rebuilt by parsing a session journal file — survives restarts. */
const historyCache = new Map()

function parseTranscriptTs(line) {
  const m = /^\[(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\]/.exec(line)
  if (m === null) return null
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime()
}

const BG_START_RE = /^\[[^\]]*\] \$ \(background\) (.*)$/
const STREAMS_RE = /^\[[^\]]*\] # job output streams to (\S+)$/
const ATTACH_RE = /^\[[^\]]*\] # job (ssh-[a-zA-Z0-9-]+) started \(managed\)$/
const SETTLE_RE = /^\[[^\]]*\] \(background job (ssh-[a-zA-Z0-9-]+) (completed|killed|failed)(?:, ([^—]*))? — started/

async function historicalJobs(row) {
  const stats = await fsStat(row.transcriptFile).catch(() => null)
  if (stats === null) return []
  const cached = historyCache.get(row.transcriptFile)
  if (cached !== undefined && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
    return cached.rows
  }
  const text = await readFile(row.transcriptFile, 'utf8').catch(() => '')
  const rows = []
  let pending = null
  for (const line of text.split('\n')) {
    let m = BG_START_RE.exec(line)
    if (m !== null) {
      pending = { label: m[1], jobFileRel: null, startedAt: parseTranscriptTs(line) }
      continue
    }
    m = STREAMS_RE.exec(line)
    if (m !== null && pending !== null) {
      pending.jobFileRel = m[1]
      continue
    }
    m = ATTACH_RE.exec(line)
    if (m !== null) {
      rows.push({
        id: m[1],
        agentId: row.agentId,
        label: pending !== null ? pending.label : '(unknown)',
        status: 'running',
        detail: '',
        startedAt: pending !== null ? pending.startedAt : parseTranscriptTs(line),
        endedAt: null,
        jobFileRel: pending !== null ? pending.jobFileRel : null,
        workspace: row.workspace,
        historical: true,
      })
      pending = null
      continue
    }
    m = SETTLE_RE.exec(line)
    if (m !== null) {
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        if (rows[i].id === m[1]) {
          rows[i].status = m[2]
          rows[i].detail = (m[3] ?? '').trim()
          rows[i].endedAt = parseTranscriptTs(line)
          break
        }
      }
    }
  }
  const entry = { mtimeMs: stats.mtimeMs, size: stats.size, rows }
  historyCache.set(row.transcriptFile, entry)
  return rows
}

/** Merged job rows: live registry first, then history for unseen ids. */
async function allJobRows(ctx, agentFilter) {
  const rows = panelJobRows(agentFilter)
  const seen = new Set(rows.map((r) => r.id))
  const { rows: sessions } = await panelSessions(ctx)
  for (const session of sessions.slice(0, 15)) {
    if (typeof session.transcriptFile !== 'string') continue
    for (const h of await historicalJobs(session)) {
      if (seen.has(h.id)) continue
      if (agentFilter !== null && h.agentId !== agentFilter) continue
      seen.add(h.id)
      rows.push(h)
    }
  }
  rows.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
  return rows.slice(0, 100)
}

/** Resolve a historical job's output file from its session journal. */
async function historicalJobFile(jobId, agentFilter, ctx = null) {
  const { rows: sessions } = await panelSessions(ctx)
  for (const session of sessions.slice(0, 15)) {
    if (typeof session.transcriptFile !== 'string') continue
    if (agentFilter !== null && session.agentId !== agentFilter) continue
    for (const h of await historicalJobs(session)) {
      if (h.id !== jobId) continue
      if (typeof h.jobFileRel !== 'string' || typeof session.workspace !== 'string') return null
      const file = pathResolve(session.workspace, h.jobFileRel)
      return (await validJournalFile(file, { jobs: true }, ctx)) ? file : null
    }
  }
  return null
}

/** Incremental job output from the job's local log file (char-offset cursor,
 * same contract as /transcript). Falls back to the in-memory tail when the
 * file is not available yet. Never touches the registry's consuming cursor. */
async function panelJobOutput(jobId, offset, agentFilter = null, ctx = null) {
  const meta = panelJobs.get(jobId)
  if (meta !== undefined && (agentFilter === null || meta.agentId === agentFilter)) {
    if (typeof meta.jobFile === 'string') {
      const text = await readFile(meta.jobFile, 'utf8').catch(() => null)
      if (text !== null) {
        const length = text.length
        if (offset > length) return { length, text, reset: true }
        if (length - offset > PANEL_TAIL_CAP) {
          return { length, text: text.slice(-PANEL_TAIL_CAP), skipped: length - offset - PANEL_TAIL_CAP }
        }
        return { length, text: text.slice(offset) }
      }
    }
    const tail = meta.tail ?? ''
    return { length: tail.length, text: offset > tail.length ? '' : tail.slice(offset) }
  }
  const file = await historicalJobFile(jobId, agentFilter, ctx)
  if (file === null) return null
  const text = await readFile(file, 'utf8').catch(() => null)
  if (text === null) return { length: 0, text: '' }
  const length = text.length
  if (offset > length) return { length, text, reset: true }
  if (length - offset > PANEL_TAIL_CAP) {
    return { length, text: text.slice(-PANEL_TAIL_CAP), skipped: length - offset - PANEL_TAIL_CAP }
  }
  return { length, text: text.slice(offset) }
}

/** Read one small JSON request body (job kill). */
function readJsonBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(new Error(`invalid JSON body: ${error.message}`))
      }
    })
    req.on('error', reject)
  })
}

function makePanelHandler(ctx) {
  return async function panelHandler(req, res) {
    try {
      const url = new URL(req.url ?? '/', 'http://panel.local')
      const segment = url.pathname.slice(PANEL_BASE.length).replace(/^\/+/, '').split('/')[0]
      if (segment === '' || segment === 'index.html') {
        if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' })
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(panelIndexHtml())
        return
      }
      if (segment === 'panel.js' || segment === 'panel.css') {
        if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' })
        const asset = await readFile(pathResolve(HERE, segment), 'utf8').catch(() => null)
        if (asset === null) return sendJson(res, 404, { error: `panel asset ${segment} is missing in the preset directory` })
        res.writeHead(200, {
          'content-type': segment.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8',
          'cache-control': 'no-store',
        })
        res.end(asset)
        return
      }
      if (segment === 'sessions') {
        if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' })
        const hint = url.searchParams.get('titleHint') ?? ''
        const { rows, currentIsSsh } = await panelSessions(ctx, hint)
        return sendJson(res, 200, { sessions: rows, currentIsSsh })
      }
      if (segment === 'transcript') {
        if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' })
        const offset = Math.max(0, Number.parseInt(url.searchParams.get('offset') ?? '0', 10) || 0)
        const file = url.searchParams.get('file')
        if (file !== null && file !== '') {
          const data = await panelTranscriptFile(file, offset, ctx)
          if (data === null) return sendJson(res, 404, { error: 'unknown journal file' })
          return sendJson(res, 200, data)
        }
        const agent = url.searchParams.get('agent') ?? ''
        const data = await panelTranscript(agent, offset)
        if (data === null) return sendJson(res, 404, { error: 'unknown session' })
        return sendJson(res, 200, data)
      }
      if (segment === 'jobs') {
        if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' })
        const agent = url.searchParams.get('agent')
        return sendJson(res, 200, await allJobRows(ctx, agent === null || agent === '' ? null : agent))
      }
      if (segment === 'job') {
        if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' })
        const id = url.searchParams.get('id') ?? ''
        const agentParam = url.searchParams.get('agent')
        const offset = Math.max(0, Number.parseInt(url.searchParams.get('offset') ?? '0', 10) || 0)
        const data = await panelJobOutput(id, offset, agentParam === null || agentParam === '' ? null : agentParam, ctx)
        if (data === null) return sendJson(res, 404, { error: 'unknown job' })
        return sendJson(res, 200, data)
      }
      if (segment === 'job-kill') {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
        const body = await readJsonBody(req)
        const meta = panelJobs.get(String(body.id ?? ''))
        if (meta === undefined) return sendJson(res, 404, { error: 'unknown job' })
        if (meta.status !== 'running') return sendJson(res, 409, { error: `job already ${meta.status}` })
        const jobs = ctx.get('jobs')
        if (jobs === undefined) return sendJson(res, 503, { error: 'jobs service unavailable' })
        const result = jobs.kill(meta.id, meta.agent, 'panel request')
        return sendJson(res, 200, { result })
      }
      if (segment === 'diag') {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
        const body = await readJsonBody(req, 8192)
        let line = JSON.stringify(body)
        if (line.length > 2000) line = `${line.slice(0, 2000)}…`
        panelDebug(`diag ${line}`)
        return sendJson(res, 200, { ok: true })
      }
      sendJson(res, 404, { error: 'not found' })
    } catch (error) {
      sendJson(res, 500, { error: error?.message ?? String(error) })
    }
  }
}

/**
 * Register the panel against the host webServer when it exists (this
 * deployment always runs the web GUI; a headless one simply gets no panel).
 */
/** Offline diagnostics: the standing mount runs long before anyone can look;
 * a tiny append-only file in the preset dir says what actually happened. */
function panelDebug(line) {
  try {
    appendFileSync(pathResolve(HERE, 'panel-debug.log'), `[${new Date().toISOString()}] ${line}\n`, 'utf8')
  } catch {}
}

function registerPanel(ctx) {
  let settled = false
  const attempt = (phase) => {
    if (settled) return true
    panelDebug(`attempt(${phase}): looking up webServer`)
    const web = ctx.get('webServer')
    if (web === undefined) {
      panelDebug(`attempt(${phase}): webServer undefined`)
      return false
    }
    settled = true
    panelDebug(`attempt(${phase}): webServer found (${typeof web.register}/${typeof web.tapIndex})`)
    try {
      const handler = makePanelHandler(ctx)
      const disposeRoute = web.register({
        kind: 'prefix',
        path: PANEL_BASE,
        handler(req, res) {
          return Promise.resolve(handler(req, res)).catch((error) => {
            try {
              sendJson(res, 500, { error: error?.message ?? String(error) })
            } catch {}
          })
        },
      })
      const disposeTap = web.tapIndex((html) => (html.includes(`${PANEL_BASE}/panel.js`) ? html : html.replace(
        '</head>',
        `<link rel="stylesheet" href="${PANEL_BASE}/panel.css">\n<script defer src="${PANEL_BASE}/panel.js"></script>\n</head>`,
      )))
      ctx.effect(() => () => {
        disposeRoute()
        disposeTap()
      }, `${PLUGIN_NAME}.panel`)
      panelDebug(`attempt(${phase}): routes + tap registered OK`)
    } catch (error) {
      panelDebug(`attempt(${phase}): registration THREW: ${error?.message ?? String(error)}`)
      // Duplicate route from another stacked generation: no panel for this one.
    }
    return true
  }
  if (attempt('apply')) return
  const off = ctx.on('internal/service', (name) => {
    panelDebug(`internal/service event: ${String(name)}`)
    if (name === 'webServer') {
      if (attempt('event')) off()
    }
  })
  panelDebug('registered internal/service listener')
}

function apply(ctx) {
  ctx.tools.register({
    name: 'ssh_connect',
    description: 'Connect this session to a remote Linux server over SSH (password auth). Ask the user for host, port, username and password via ask_user_question when you do not have credentials yet, then call this tool once. The connection persists for the whole session; calling it again replaces the current connection. The password is kept in memory only and is never echoed back. Every other ssh_*/sftp_* tool requires this connection.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        host: { type: 'string', description: 'Hostname or IP of the remote server.' },
        port: { type: 'integer', description: 'SSH port. Defaults to 22.' },
        username: { type: 'string', description: 'Login username on the remote server.' },
        password: { type: 'string', description: 'Login password. Kept in memory only; never written to disk or echoed back.' },
        timeoutMs: { type: 'integer', description: 'Connect timeout in milliseconds. Defaults to 20000.' },
      },
      required: ['host', 'username', 'password'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          connected: { type: 'boolean', const: true },
          host: { type: 'string' },
          port: { type: 'integer' },
          username: { type: 'string' },
          homeDir: { type: 'string' },
          server: { type: 'string' },
        },
        required: ['connected', 'host', 'port', 'username', 'homeDir', 'server'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Connected to ${value.username}@${value.host}:${value.port} (home: ${value.homeDir})\n${value.server}`,
      }],
    },
    timeoutMs: CONNECT_TIMEOUT_MS + 10_000,
    async execute(args, exec) {
      const agentId = requireAgentId(exec)
      const host = String(args.host).trim()
      const username = String(args.username).trim()
      const port = parsePositiveInt(args.port, 22, { max: 65535 })
      const timeoutMs = parsePositiveInt(args.timeoutMs, CONNECT_TIMEOUT_MS, { max: 60_000 })
      if (host.length === 0) throw new Error('invalid host: expected a non-empty string')
      if (username.length === 0) throw new Error('invalid username: expected a non-empty string')
      closeConnection(agentId)
      const client = await openConnection({ host, port, username, password: String(args.password), timeoutMs }, exec.signal)
      const conn = {
        client,
        info: { host, port, username },
        sftp: null,
      }
      client.on('error', () => closeConnection(agentId))
      client.on('close', () => closeConnection(agentId))
      connections.set(agentId, conn)
      // Verify the channel actually executes commands and capture identity.
      const probe = await remoteExec(agentId, 'printf %s "$HOME"; printf "\\n"; uname -a', { timeoutMs: 15_000, signal: exec.signal })
      if (probe.exitCode !== 0) {
        closeConnection(agentId)
        throw new Error(`SSH connected but the verification command failed (exit ${probe.exitCode}): ${probe.stderr.trim()}`)
      }
      const lines = probe.stdout.split('\n')
      const homeDir = (lines[0] ?? '').trim() || '/'
      const server = probe.stdout.slice(probe.stdout.indexOf('\n') + 1).trim()
      const state = transcriptForExec(exec)
      if (state !== null) {
        writeTranscript(state, `=== [${localStamp()}] connected ${username}@${host}:${port} (home: ${homeDir}) — transcript starts ===\n`)
      }
      return { connected: true, host, port, username, homeDir, server }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `ssh_connect ${String(args.username ?? '')}@${String(args.host ?? '')}`,
      kind: 'fetch',
    }),
  })

  ctx.tools.register({
    name: 'ssh_bash',
    description: 'Execute a command on the connected remote Linux server over SSH and return stdout/stderr. Each call runs in a fresh remote shell: no state (cwd, variables, functions) persists between calls — use absolute paths, `cd <dir> && <cmd>`, or pass `workdir`. Non-zero exits are reported as `[exit code: N]` and are not tool failures. Long output is truncated to its tail. For long-running work, pass run_in_background to get a managed job (job_output/job_kill; killed when the session ends), or start the process yourself with nohup/screen/tmux to let it outlive the session. Local execution is unavailable in this session by design: every command must target the remote server. ssh_connect must have been called first.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        command: { type: 'string', description: 'The command to execute on the remote server. It does NOT need to be XML-escaped.' },
        description: { type: 'string', description: 'Clear, concise description of what this command does in active voice, 5-10 words (shown in the UI). Examples: "ls" → "List files in current directory"; "systemctl status nginx" → "Show nginx service status".' },
        timeoutMs: { type: 'integer', description: 'Timeout in milliseconds; the command is killed on expiry. Defaults to 120000, capped at 600000. Ignored for run_in_background (no timeout applies).' },
        workdir: { type: 'string', description: 'Remote working directory for this command; the call fails if it does not exist.' },
        run_in_background: { type: 'boolean', description: 'Run as a managed remote background job: the call returns a job id immediately, incremental output is read with job_output (wait: true blocks until completion), and the job stops with job_kill. The job and its process group are killed when this session ends — use nohup/screen/tmux in a normal foreground call instead when the process must outlive the session.' },
      },
      required: ['command', 'description'],
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', const: 'background' },
              jobId: { type: 'string' },
            },
            required: ['kind', 'jobId'],
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              exitCode: NULLABLE('integer'),
              signal: NULLABLE('string'),
              timedOut: { type: 'boolean' },
              timeoutMs: { type: 'integer' },
              stdout: { type: 'string' },
              stderr: { type: 'string' },
              stdoutTruncated: { type: 'boolean' },
              stderrTruncated: { type: 'boolean' },
            },
            required: ['exitCode', 'signal', 'timedOut', 'timeoutMs', 'stdout', 'stderr', 'stdoutTruncated', 'stderrTruncated'],
          },
        ],
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.kind === 'background'
          ? `started remote background job ${value.jobId}; read incremental output with job_output (wait: true blocks until it finishes), stop it with job_kill`
          : renderExecResult(value),
      }],
      presentationMeta: (_args, value) => {
        if (value.kind === 'background') return {}
        const meta = {}
        if (typeof value.exitCode === 'number') meta.exitCode = value.exitCode
        if (typeof value.signal === 'string') meta.signal = value.signal
        return meta
      },
    },
    timeoutMs: MAX_EXEC_TIMEOUT_MS + 30_000,
    async execute(args, exec) {
      const agentId = requireAgentId(exec)
      const command = String(args.command)
      if (command.trim().length === 0) throw new Error('invalid command: expected a non-empty string')
      const timeoutMs = parsePositiveInt(args.timeoutMs, DEFAULT_EXEC_TIMEOUT_MS, { max: MAX_EXEC_TIMEOUT_MS })
      let fullCommand = command
      if (args.workdir !== undefined && args.workdir !== null) {
        const workdir = String(args.workdir)
        if (workdir.trim().length === 0) throw new Error('invalid workdir: expected a non-empty string')
        fullCommand = `cd -- ${shQuote(workdir)} && ${command}`
      }
      if (args.run_in_background === true) {
        const jobs = ctx.get('jobs')
        if (jobs === undefined) throw new Error('background jobs unavailable: the jobs service is not mounted in this deployment')
        if (exec.signal.aborted) throw new Error('tool call aborted')
        // Panel-visible job metadata (the Jobs tab and job-jump links read
        // this; the harness registry keeps its own authoritative snapshot).
        const meta = {
          id: null,
          agentId,
          agent: exec.agent,
          label: command,
          startedAt: Date.now(),
          endedAt: null,
          status: 'running',
          detail: '',
          jobFile: null,
          jobFileRel: null,
          tail: '',
        }
        const jobId = jobs.start({
          kind: 'ssh',
          label: command,
          ...exec.agent !== undefined ? { owner: exec.agent } : {},
          run: () => startRemoteBackgroundJob(agentId, fullCommand, transcriptForExec(exec), meta),
        })
        meta.id = jobId
        panelJobs.set(jobId, meta)
        trimPanelJobs()
        const bgState = transcriptForExec(exec)
        if (bgState !== null) {
          writeTranscript(bgState, transcriptNote(`job ${jobId} started (managed)`))
        }
        return { kind: 'background', jobId }
      }
      const hostLabel = (() => {
        const info = connections.get(agentId)?.info
        return info === undefined ? 'ssh' : `${info.username}@${info.host}:${info.port}`
      })()
      const workdir = args.workdir !== undefined && args.workdir !== null ? String(args.workdir) : undefined
      const state = transcriptForExec(exec)
      let value
      try {
        value = await remoteExec(agentId, fullCommand, { timeoutMs, signal: exec.signal })
      } catch (error) {
        if (state !== null) {
          writeTranscript(state, transcriptCommandEntry({ hostLabel, workdir, command, error }))
        }
        throw error
      }
      if (state !== null) {
        writeTranscript(state, transcriptCommandEntry({ hostLabel, workdir, command, value }))
      }
      return value
    },
    presentCall: (args) => {
      if (args.run_in_background === true) {
        return {
          card: 'generic',
          title: String(args.command ?? ''),
          kind: 'execute',
          content: [{ type: 'text', text: String(args.description ?? '') }],
        }
      }
      return {
        card: 'terminal',
        title: String(args.command ?? ''),
        description: String(args.description ?? ''),
        ...args.workdir !== undefined ? { cwd: String(args.workdir) } : {},
      }
    },
    presentResult: (args, result) => {
      const text = contentText(result)
      if (text === undefined) return undefined
      if (args.run_in_background === true || result.isError) {
        return {
          card: 'generic',
          content: [{
            type: 'text',
            text: `\`\`\`console\n${text.replace(/\n+$/, '')}\n\`\`\``,
          }],
        }
      }
      const meta = result.meta ?? {}
      const view = { card: 'terminal', title: String(args.command ?? ''), output: text }
      if (typeof meta.exitCode === 'number') view.exitCode = meta.exitCode
      else if (typeof meta.signal === 'string') view.signal = meta.signal
      return view
    },
  })

  ctx.tools.register({
    name: 'ssh_read',
    description: 'Read a UTF-8 text file from the remote server over SFTP and return it with 1-based line numbers (the window keeps the file\'s own numbering). Use offset/limit for large files; default limit is 2000 lines. Files above 8MB are rejected — read those through ssh_bash (sed/grep) instead. ssh_connect must have been called first.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: 'Absolute path of the remote file to read.' },
        offset: { type: 'integer', description: '1-based first line to return. Defaults to 1.' },
        limit: { type: 'integer', description: 'Maximum number of lines to return. Defaults to 2000.' },
      },
      required: ['path'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string' },
          offset: { type: 'integer' },
          totalLines: { type: 'integer' },
          truncated: { type: 'boolean' },
          lines: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                number: { type: 'integer' },
                text: { type: 'string' },
              },
              required: ['number', 'text'],
            },
          },
        },
        required: ['path', 'offset', 'totalLines', 'truncated', 'lines'],
      },
      render: (_args, value) => {
        const body = value.lines.length === 0
          ? '(no lines in this window)'
          : value.lines.map((line) => `${String(line.number).padStart(6)}\t${line.text}`).join('\n')
        const footer = value.truncated
          ? `\n[showing lines ${value.offset}-${value.offset + value.lines.length - 1} of ${value.totalLines}; pass offset/limit to read more]`
          : ''
        return [{ type: 'text', text: `${body}${footer}` }]
      },
      presentationMeta: (_args, value) => ({ path: value.path, offset: value.offset, lines: value.lines, totalLines: value.totalLines }),
    },
    timeoutMs: 120_000,
    async execute(args, exec) {
      const agentId = requireAgentId(exec)
      const path = String(args.path)
      const offset = parsePositiveInt(args.offset, 1)
      const limit = parsePositiveInt(args.limit, DEFAULT_READ_LIMIT)
      const stats = await sftpStat(agentId, path).catch((error) => {
        throw new Error(`cannot read remote file ${path}: ${error.message}`)
      })
      if (stats.size > MAX_READ_BYTES) {
        throw new Error(`remote file ${path} is ${stats.size} bytes (above the ${MAX_READ_BYTES} byte limit); read it in windows via ssh_bash (e.g. sed -n) instead`)
      }
      const { text } = await sftpReadText(agentId, path, MAX_READ_BYTES).catch((error) => {
        throw new Error(`cannot read remote file ${path}: ${error.message}`)
      })
      const allLines = text.length === 0 ? [] : text.split('\n')
      if (allLines.length > 0 && allLines[allLines.length - 1] === '') allLines.pop()
      const start = Math.min(offset, allLines.length + 1)
      const window = allLines.slice(start - 1, start - 1 + limit)
      const state = transcriptForExec(exec)
      if (state !== null) {
        writeTranscript(state, transcriptNote(`ssh_read ${path} lines ${start}-${start + window.length - 1} of ${allLines.length}`))
      }
      return {
        path,
        offset: start,
        totalLines: allLines.length,
        truncated: start - 1 + window.length < allLines.length,
        lines: window.map((lineText, index) => ({ number: start + index, text: lineText })),
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `ssh_read ${String(args.path ?? '')}`,
      kind: 'read',
      locations: args.path !== undefined ? [{ path: String(args.path), ...(args.offset !== undefined ? { line: args.offset } : {}) }] : undefined,
    }),
    presentResult: (_args, result) => {
      const meta = result.meta
      if (meta === undefined || meta === null || typeof meta !== 'object') return undefined
      return {
        card: 'read',
        path: String(meta.path ?? ''),
        offset: typeof meta.offset === 'number' ? meta.offset : 1,
        lines: Array.isArray(meta.lines) ? meta.lines : [],
        totalLines: typeof meta.totalLines === 'number' ? meta.totalLines : 0,
        content: result.content,
      }
    },
  })

  ctx.tools.register({
    name: 'ssh_write',
    description: 'Create or overwrite a UTF-8 text file on the remote server over SFTP. Missing remote parent directories are created automatically. The file content is written verbatim. Read the existing file first (ssh_read) when unsure whether the path or content already exists. ssh_connect must have been called first.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: 'Absolute path of the remote file to write.' },
        content: { type: 'string', description: 'Full UTF-8 text content to write to the file.' },
      },
      required: ['path', 'content'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string' },
          bytes: { type: 'integer' },
        },
        required: ['path', 'bytes'],
      },
      render: (_args, value) => [{ type: 'text', text: `Wrote ${value.bytes} bytes to ${value.path}` }],
    },
    timeoutMs: 120_000,
    async execute(args, exec) {
      const agentId = requireAgentId(exec)
      const path = String(args.path)
      const content = String(args.content)
      await sftpEnsureRemoteDir(agentId, path)
      try {
        await sftpWriteText(agentId, path, content)
      } catch (error) {
        throw new Error(`cannot write remote file ${path}: ${error.message}`)
      }
      const bytes = Buffer.byteLength(content, 'utf8')
      const state = transcriptForExec(exec)
      if (state !== null) writeTranscript(state, transcriptNote(`ssh_write ${path} (${bytes} bytes)`))
      return { path, bytes }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `ssh_write ${String(args.path ?? '')}`,
      kind: 'edit',
      locations: args.path !== undefined ? [{ path: String(args.path) }] : undefined,
    }),
  })

  ctx.tools.register({
    name: 'ssh_edit',
    description: 'Edit a remote UTF-8 text file by replacing one exact literal string (SFTP). old_string must match the file byte-for-byte including whitespace and appear exactly once, unless replace_all is true. Empty new_string deletes the match. Read the file first (ssh_read) to copy the exact text. ssh_connect must have been called first.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: 'Absolute path of the remote file to edit.' },
        old_string: { type: 'string', description: 'Exact literal text to replace. Must be unique in the file unless replace_all is true.' },
        new_string: { type: 'string', description: 'Replacement text. Use an empty string to delete the match.' },
        replace_all: { type: 'boolean', description: 'Replace every occurrence of old_string. Defaults to false.' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string' },
          replacements: { type: 'integer' },
        },
        required: ['path', 'replacements'],
      },
      render: (_args, value) => [{ type: 'text', text: `Applied ${value.replacements} replacement(s) in ${value.path}` }],
    },
    timeoutMs: 120_000,
    async execute(args, exec) {
      const agentId = requireAgentId(exec)
      const path = String(args.path)
      const oldString = String(args.old_string)
      const newString = String(args.new_string)
      if (oldString.length === 0) throw new Error('invalid old_string: expected a non-empty string')
      const stats = await sftpStat(agentId, path).catch((error) => {
        throw new Error(`cannot read remote file ${path}: ${error.message}`)
      })
      if (stats.size > MAX_READ_BYTES) throw new Error(`remote file ${path} is too large to edit (${stats.size} bytes; limit ${MAX_READ_BYTES})`)
      const { text } = await sftpReadText(agentId, path, MAX_READ_BYTES).catch((error) => {
        throw new Error(`cannot read remote file ${path}: ${error.message}`)
      })
      const count = text.split(oldString).length - 1
      if (count === 0) throw new Error(`old_string not found in ${path}. Read the file again and copy the exact text, including whitespace and indentation.`)
      if (count > 1 && args.replace_all !== true) {
        throw new Error(`old_string appears ${count} times in ${path}. Make it unique (add surrounding context) or pass replace_all: true.`)
      }
      const next = args.replace_all === true ? text.split(oldString).join(newString) : text.replace(oldString, newString)
      await sftpEnsureRemoteDir(agentId, path)
      try {
        await sftpWriteText(agentId, path, next)
      } catch (error) {
        throw new Error(`cannot write remote file ${path}: ${error.message}`)
      }
      const replacements = args.replace_all === true ? count : 1
      const state = transcriptForExec(exec)
      if (state !== null) writeTranscript(state, transcriptNote(`ssh_edit ${path} (${replacements} replacement${replacements === 1 ? '' : 's'})`))
      return { path, replacements }
    },
    presentCall: (args) => ({
      card: 'diff',
      title: `ssh_edit ${String(args.path ?? '')}`,
      diffs: [{
        path: String(args.path ?? ''),
        oldText: String(args.old_string ?? ''),
        newText: String(args.new_string ?? ''),
      }],
      locations: args.path !== undefined ? [{ path: String(args.path) }] : undefined,
    }),
  })

  ctx.tools.register({
    name: 'sftp_upload',
    description: 'Upload one local file from this session\'s workspace to the remote server over SFTP (remote parent directories are created automatically). local_path must stay inside the session workspace — that is the only local filesystem access this mode allows. ssh_connect must have been called first.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        local_path: { type: 'string', description: 'Local path inside the session workspace (absolute, or relative to it).' },
        remote_path: { type: 'string', description: 'Absolute destination path on the remote server.' },
      },
      required: ['local_path', 'remote_path'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          localPath: { type: 'string' },
          remotePath: { type: 'string' },
          bytes: { type: 'integer' },
        },
        required: ['localPath', 'remotePath', 'bytes'],
      },
      render: (_args, value) => [{ type: 'text', text: `Uploaded ${value.bytes} bytes: ${value.localPath} -> ${value.remotePath}` }],
    },
    timeoutMs: 300_000,
    async execute(args, exec) {
      const agentId = requireAgentId(exec)
      const localPath = resolveLocalWithinWorkspace(exec, String(args.local_path))
      const remotePath = String(args.remote_path)
      const stats = await fsStat(localPath).catch(() => {
        throw new Error(`local file not found: ${localPath}`)
      })
      await sftpEnsureRemoteDir(agentId, remotePath)
      try {
        await sftpFastPut(agentId, localPath, remotePath)
      } catch (error) {
        throw new Error(`SFTP upload failed (${localPath} -> ${remotePath}): ${error.message}`)
      }
      const state = transcriptForExec(exec)
      if (state !== null) writeTranscript(state, transcriptNote(`sftp_upload ${localPath} -> ${remotePath} (${stats.size} bytes)`))
      return { localPath, remotePath, bytes: stats.size }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `sftp_upload ${String(args.local_path ?? '')} -> ${String(args.remote_path ?? '')}`,
      kind: 'move',
    }),
  })

  ctx.tools.register({
    name: 'sftp_download',
    description: 'Download one file from the remote server into this session\'s local workspace over SFTP (local parent directories are created automatically). local_path must stay inside the session workspace — that is the only local filesystem access this mode allows. ssh_connect must have been called first.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        remote_path: { type: 'string', description: 'Absolute source path on the remote server.' },
        local_path: { type: 'string', description: 'Local destination inside the session workspace (absolute, or relative to it).' },
      },
      required: ['remote_path', 'local_path'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          remotePath: { type: 'string' },
          localPath: { type: 'string' },
          bytes: { type: 'integer' },
        },
        required: ['remotePath', 'localPath', 'bytes'],
      },
      render: (_args, value) => [{ type: 'text', text: `Downloaded ${value.bytes} bytes: ${value.remotePath} -> ${value.localPath}` }],
    },
    timeoutMs: 300_000,
    async execute(args, exec) {
      const agentId = requireAgentId(exec)
      const remotePath = String(args.remote_path)
      const localPath = resolveLocalWithinWorkspace(exec, String(args.local_path))
      const stats = await sftpStat(agentId, remotePath).catch((error) => {
        throw new Error(`cannot stat remote file ${remotePath}: ${error.message}`)
      })
      try {
        await sftpFastGet(agentId, remotePath, localPath)
      } catch (error) {
        throw new Error(`SFTP download failed (${remotePath} -> ${localPath}): ${error.message}`)
      }
      const state = transcriptForExec(exec)
      if (state !== null) writeTranscript(state, transcriptNote(`sftp_download ${remotePath} -> ${localPath} (${stats.size} bytes)`))
      return { remotePath, localPath, bytes: stats.size }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `sftp_download ${String(args.remote_path ?? '')} -> ${String(args.local_path ?? '')}`,
      kind: 'move',
    }),
  })

  // Close a session's connection when its agent goes away, so finished
  // sessions do not leave SSH channels open for the life of the process.
  // (Scoped listeners and tool registrations unwind with the preset mount.)
  ctx.on('agent/disposed', (payload) => {
    const id = payload?.agent?.id
    if (typeof id === 'string') {
      const state = transcripts.get(id)
      if (state !== undefined) {
        writeTranscript(state, `=== [${localStamp()}] session ended; connection closed — transcript ends ===\n`)
      }
      closeConnection(id)
    }
  })

  // Right-side terminal replay panel inside the web GUI (see the panel
  // section above). No-op in a headless deployment without the webServer.
  registerPanel(ctx)

  // Plugin teardown: no SSH connection this plugin opened outlives it.
  ctx.effect(() => () => closeAllConnections(), `${PLUGIN_NAME}.closeAll`)
}

export { PLUGIN_NAME as name, INJECT as inject, apply }
