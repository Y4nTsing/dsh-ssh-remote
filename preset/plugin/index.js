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
import { readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { appendFile, mkdir as fsMkdir, stat as fsStat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { posix } from 'node:path'
import { isAbsolute as pathIsAbsolute, relative as pathRelative, resolve as pathResolve } from 'node:path'

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
const KEEPALIVE_INTERVAL_MS = Number(process.env.DSH_SSH_KEEPALIVE_INTERVAL_MS) || 15_000
const KEEPALIVE_COUNT_MAX = Number(process.env.DSH_SSH_KEEPALIVE_COUNT_MAX) || 6
/** Extra wait after the exec timeout before declaring the connection dead
 * (covers the gap where ssh2's callback never fires at all). */
const EXEC_NO_RESPONSE_GRACE_MS = Number(process.env.DSH_SSH_EXEC_GRACE_MS) || 5_000
/** How long a liveness probe (a no-op `true`) may take before the connection
 * is treated as dead and re-established. */
const PROBE_TIMEOUT_MS = Number(process.env.DSH_SSH_PROBE_TIMEOUT_MS) || 10_000
/**
 * After a timeout kills a foreground command, how long it may still report its
 * own result before the call is settled locally anyway (the session's
 * connection is dropped at that point). Bounded because ssh2 emits `close` only
 * when the PEER closes the channel, and OpenSSH keeps a session channel open for
 * as long as the exec'd child runs — a wedged command must never decide when a
 * tool call ends. Env-overridable for tests.
 */
const KILL_SETTLE_GRACE_MS = Number(process.env.DSH_SSH_KILL_SETTLE_GRACE_MS) || 5_000

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

/** Close and forget one session's connection (idempotent). Background jobs are
 * NOT stopped here: a transient drop must not kill a detached remote job —
 * the polling loop reconnects on its own and resumes it. Jobs are stopped
 * explicitly by stopAgentJobs (agent disposal) and closeAllConnections. */
function closeConnection(agentId) {
  const conn = connections.get(agentId)
  if (conn === undefined) return
  connections.delete(agentId)
  conn.sftp = null
  try {
    conn.client.end()
  } catch {
    // already gone
  }
}

/** Stop every managed remote job observed for one agent. */
function stopAgentJobs(agentId) {
  for (const job of [...activeJobs]) {
    if (job.agentId !== agentId) continue
    try {
      job.stop()
    } catch {}
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
function startRemoteBackgroundJob(agentId, command, transcript = null, meta = null, handle = null) {
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
    // Feed the harness output ring (JobHandle.append): this is what `job_output`
    // reads, and its own retention/spill policy applies. The plugin's extra
    // `readOutput()` is not part of the harness contract and nothing calls it.
    if (handle !== null && text.length > 0) {
      try {
        handle.append(text)
      } catch {}
    }
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
      // Transparent auto-reconnect on every poll: a dropped connection no
      // longer kills a still-running remote job — the detached setsid process
      // survives the disconnect and polling simply resumes on a fresh channel.
      await ensureAlive(agentId)
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

/** In-memory credentials per session for TRANSPARENT AUTO-RECONNECT: the
 * connection to cloud servers drops every few idle minutes (NAT/sshd
 * policies), and with the credentials already in memory the next tool call
 * can simply re-establish instead of erroring until the model re-runs
 * ssh_connect. Same trust boundary as before: memory only, never on disk. */
const lastCreds = new Map()
const reconnectInFlight = new Map()

/** Establish (or re-establish) the connection entry for one session. */
async function establishConnection(agentId, creds, signal) {
  const client = await openConnection(creds, signal)
  const conn = {
    client,
    info: { host: creds.host, port: creds.port, username: creds.username },
    sftp: null,
  }
  client.on('error', onLost)
  client.on('close', onLost)
  try {
    client.sock?.setKeepAlive?.(true, 45_000)
  } catch {}
  connections.set(agentId, conn)
  return conn

  function onLost() {
    // Only tear down the map entry when it still points at THIS client: a
    // late error/close from a superseded connection must not delete the
    // replacement that is already live.
    const current = connections.get(agentId)
    if (current !== undefined && current.client === client) closeConnection(agentId)
  }
}

/** Make sure a live connection exists, reconnecting with stored credentials
 * when a previous one dropped. Concurrent callers share one reconnect. */
async function ensureConnected(agentId, signal) {
  if (connections.has(agentId)) return
  const creds = lastCreds.get(agentId)
  if (creds === undefined) throw notConnectedError()
  let pending = reconnectInFlight.get(agentId)
  if (pending === undefined) {
    pending = (async () => {
      closeConnection(agentId)
      const conn = await establishConnection(agentId, creds, signal)
      const st = transcripts.get(agentId)
      if (st !== undefined) {
        writeTranscript(st, transcriptNote(`auto-reconnected to ${creds.username}@${creds.host}:${creds.port} after connection loss`))
      }
      return conn
    })()
      .finally(() => reconnectInFlight.delete(agentId))
    reconnectInFlight.set(agentId, pending)
  }
  try {
    await pending
  } catch (error) {
    throw new Error(
      `SSH: the connection dropped and automatic reconnect to ${creds.username}@${creds.host}:${creds.port} failed: ${error?.message ?? String(error)}. `
      + 'Retry ssh_connect with fresh credentials (ask the user via ask_user_question if the password may have changed).',
      { cause: error },
    )
  }
}

/** Make sure the session has a LIVE connection before a remote operation.
 * `connections.has()` alone is not enough: a silently dropped TCP connection
 * can linger in the map until ssh2's keepalive notices (up to ~90s), which is
 * exactly the window where SFTP operations used to hang and time out. A
 * cheap no-op exec probe (bounded by PROBE_TIMEOUT_MS, plus the exec outer
 * guard) detects that stale entry immediately and routes through the normal
 * auto-reconnect path, then re-probes once. Returns once the probe answers. */
async function ensureAlive(agentId, signal) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await ensureConnected(agentId, signal)
    try {
      const probe = await remoteExec(agentId, 'true', { timeoutMs: PROBE_TIMEOUT_MS, signal })
      if (probe.timedOut) throw new Error('probe timed out')
      if (probe.exitCode !== 0) throw new Error(`probe exited ${probe.exitCode}: ${probe.stderr.trim().slice(0, 200)}`)
      return
    } catch (error) {
      // A cancelled tool call must abort immediately, never look like a
      // connection failure. Everything else means the transport is not
      // answering (stale entry or wedged channel): force a reconnect.
      if (signal?.aborted || (error?.message ?? '') === 'aborted') throw error
      closeConnection(agentId)
    }
  }
  throw new Error('SSH: connection probe failed twice — the server is not answering. Run ssh_connect again.')
}

/**
 * Run one command on the session's connection. Fresh shell per call; output
 * streams keep their tail under STREAM_CAP_CHARS with a truncated flag.
 */
function remoteExec(agentId, command, { timeoutMs = DEFAULT_EXEC_TIMEOUT_MS, signal, settleOnExitMarker = false } = {}) {
  // A signal that aborted before this call started never fires 'abort' again;
  // without this the call would wait for the peer's CHANNEL_CLOSE like the
  // timeout/abort cases below.
  if (signal?.aborted) return Promise.reject(new Error('aborted'))
  const conn = connections.get(agentId)
  if (conn === undefined) return Promise.reject(notConnectedError())
  // settleOnExitMarker appends a sentinel printf to the command: OpenSSH keeps
  // a session channel open while any child of the shell still lives (for
  // example a setsid nohup job left running in the background), so waiting for
  // CHANNEL_CLOSE would block the call until its timeout even though the
  // foreground part already finished. The marker lets the call settle as soon
  // as the shell is done; the channel is then left open so the detached child
  // keeps running.
  const exitMarker = settleOnExitMarker ? '__DSH_SSH_EXIT__' : null
  const wireCommand = exitMarker === null
    ? command
    : command + "\nprintf '\\n" + exitMarker + "%s\\n' \"$?\""
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let outLen = 0
    let errLen = 0
    let outTruncated = false
    let errTruncated = false
    let timedOut = false
    let settled = false
    let started = false
    // Outer guard: on a half-open/dead connection the exec callback may never
    // fire (the inner timer only starts once a stream exists), which would
    // hang this promise forever. Bound it, forget the suspect connection, and
    // let the caller's self-heal reconnect.
    const outer = setTimeout(() => {
      if (settled || started) return
      settled = true
      closeConnection(agentId)
      reject(new Error(
        `SSH: no response from the server within ${timeoutMs + EXEC_NO_RESPONSE_GRACE_MS}ms — the connection is probably dead`
        + (lastCreds.has(agentId)
          ? ' and will be re-established automatically on the next operation.'
          : '; run ssh_connect again.'),
      ))
    }, timeoutMs + EXEC_NO_RESPONSE_GRACE_MS)
    conn.client.exec(wireCommand, (err, stream) => {
      if (settled) return
      started = true
      if (err) {
        clearTimeout(outer)
        reject(err)
        return
      }
      let timer = null
      let settleTimer = null
      /** End the call without waiting for the peer: drop the session's
       * connection so the abandoned channel cannot poison the next operation —
       * the next call re-establishes from the stored credentials (the same
       * recover-and-reconnect philosophy the SFTP timeouts use). */
      const settleLocally = (byTimeout) => {
        if (settled) return
        settled = true
        if (timer !== null) clearTimeout(timer)
        clearTimeout(outer)
        signal?.removeEventListener('abort', onAbort)
        closeConnection(agentId)
        if (byTimeout === true) {
          resolve({
            exitCode: null,
            signal: null,
            timedOut: true,
            timeoutMs,
            stdout,
            stderr,
            stdoutTruncated: outTruncated,
            stderrTruncated: errTruncated,
          })
        } else {
          reject(new Error('aborted'))
        }
      }
      const kill = (byTimeout) => {
        if (timedOut) return
        timedOut = byTimeout === true
        // ssh2 `signal()` is a no-op against OpenSSH (its session channels have
        // no handler for the SSH "signal" request) and `close()` only SENDS
        // CHANNEL_CLOSE — it never emits a local `close`. So neither action can
        // settle this call on its own against a peer that keeps the channel
        // open while its child runs.
        try {
          stream.signal('KILL')
        } catch {}
        try {
          stream.close()
        } catch {}
        // An explicit interrupt frees the turn at once; a timeout keeps a short
        // grace so a command that is already finishing can still report its
        // real output and exit code.
        if (byTimeout === true) settleTimer = setTimeout(() => settleLocally(true), KILL_SETTLE_GRACE_MS)
        else settleLocally(false)
      }
      if (timeoutMs > 0) timer = setTimeout(() => kill(true), timeoutMs)
      const onAbort = () => kill(false)
      signal?.addEventListener('abort', onAbort, { once: true })
      const finish = () => {
        if (settled) return
        settled = true
        if (timer !== null) clearTimeout(timer)
        if (settleTimer !== null) clearTimeout(settleTimer)
        clearTimeout(outer)
        signal?.removeEventListener('abort', onAbort)
      }
      let markerExitCode = null
      const settleFromMarker = () => {
        if (settled) return
        settled = true
        finish()
        if (signal?.aborted) return reject(new Error('aborted'))
        resolve({
          exitCode: markerExitCode,
          signal: null,
          timedOut: false,
          timeoutMs,
          stdout,
          stderr,
          stdoutTruncated: outTruncated,
          stderrTruncated: errTruncated,
        })
      }
      stream.stdout.setEncoding('utf8')
      stream.stderr.setEncoding('utf8')
      stream.stdout.on('data', (chunk) => {
        outLen += chunk.length
        if (outLen > STREAM_CAP_CHARS) outTruncated = true
        stdout = (stdout + chunk).slice(-STREAM_CAP_CHARS)
        if (exitMarker !== null && settled === false) {
          const at = stdout.lastIndexOf(exitMarker)
          if (at !== -1) {
            const rest = stdout.slice(at + exitMarker.length)
            const eol = rest.indexOf('\n')
            if (eol !== -1) {
              const raw = rest.slice(0, eol).trim()
              if (/^-?\d+$/.test(raw)) {
                markerExitCode = Number(raw)
                stdout = stdout.slice(0, at).replace(/\r?\n$/, '') + rest.slice(eol + 1)
                settleFromMarker()
              }
            }
          }
        }
      })
      stream.stderr.on('data', (chunk) => {
        errLen += chunk.length
        if (errLen > STREAM_CAP_CHARS) errTruncated = true
        stderr = (stderr + chunk).slice(-STREAM_CAP_CHARS)
      })
      stream.on('error', (error) => {
        if (settled) return
        finish()
        reject(error)
      })
      stream.on('close', (exitCode, signalName) => {
        if (settled) return
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
/** Hard timeouts for every SFTP wait. ssh2 callbacks on a dead connection
 * or a wedged channel simply never fire, and a cached channel promise that
 * never settles would hang every subsequent SFTP call forever ("卡死");
 * racing a timer converts that into a recoverable error. Env-overridable for
 * tests. */
const SFTP_OPEN_TIMEOUT_MS = Number(process.env.DSH_SFTP_OPEN_TIMEOUT_MS) || 20_000
const SFTP_OP_TIMEOUT_MS = Number(process.env.DSH_SFTP_OP_TIMEOUT_MS) || 60_000
/** A TRANSFER has no wall-clock cap: it fails only when no chunk makes progress
 * for this long. ssh2 reports every acknowledged chunk through the `step`
 * callback of fastPut/fastGet (both directions), so a slow-but-moving link is
 * never killed while a wedged one still is. Env-overridable for tests. */
const SFTP_STALL_TIMEOUT_MS = Number(process.env.DSH_SFTP_STALL_TIMEOUT_MS) || 60_000
/** How many 32 KiB chunks one transfer keeps in flight. ssh2's default (64, a
 * 2 MiB pre-read window) delays the FIRST progress signal by the time the whole
 * window needs on the wire — on a slow link that alone can look like a stall and
 * would false-fire the guard below. 16 chunks (512 KiB) keeps the first signal
 * within ~512 KiB of transfer while still allowing ~5 MB/s at 100ms RTT; raise
 * it on fast, high-latency links. Env-overridable. */
const SFTP_TRANSFER_CONCURRENCY = Number(process.env.DSH_SFTP_TRANSFER_CONCURRENCY) || 16
/** Harness-side budget for one transfer tool call (`ToolDefinition.timeoutMs`,
 * enforced by dsh-tool-call-timeout-policy). Deliberately generous: duration is
 * no longer capped by the plugin, so this is only the outer backstop. */
const TRANSFER_TOOL_TIMEOUT_MS = Number(process.env.DSH_SFTP_TOOL_TIMEOUT_MS) || 3_600_000

function withTimeout(promise, ms, label, signal) {
  return new Promise((resolve, reject) => {
    let timer = null
    let onAbort = null
    const done = () => {
      if (timer !== null) clearTimeout(timer)
      if (onAbort !== null) signal?.removeEventListener('abort', onAbort)
    }
    // A caller cancellation ends the wait at once. The operation itself is torn
    // down by sftpCall (fresh channel closed + connection dropped), so waiting
    // for the peer to answer would only delay the turn.
    if (signal?.aborted) {
      reject(new Error('aborted'))
      return
    }
    onAbort = () => {
      done()
      reject(new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    // ms <= 0: no wall-clock deadline — the caller guards progress itself
    // (transfers use withStallTimeout below).
    if (ms > 0) {
      timer = setTimeout(() => {
        done()
        reject(new Error(`${label} timed out after ${ms}ms — the SFTP channel or the SSH connection is probably dead. Retry after ssh_connect.`))
      }, ms)
    }
    promise.then((value) => {
      done()
      resolve(value)
    }, (error) => {
      done()
      reject(error)
    })
  })
}

/** Is this error caused by a dead/wedged transport as opposed to a normal
 * remote error (no such file, permission denied, ...)? Matched on message
 * text because ssh2 surfaces connection failures as plain Error objects. */
function isConnectionFailure(error) {
  const msg = String(error?.message ?? '')
  return /timed out|probably dead|no response|socket|channel|ECONN|ETIMEDOUT|connection (lost|closed|reset|refused)|closed by remote|read ECONN/i.test(msg)
}

/** Open a FRESH SFTP channel for one operation, then close it. No channel is
 * reused across operations (a wedged channel from a dead connection can no
 * longer poison the next call), and the open itself is hard-timeout-bounded. */
async function openFreshSftp(agentId, signal) {
  const conn = connections.get(agentId)
  if (conn === undefined) throw notConnectedError()
  return withTimeout(new Promise((resolve, reject) => {
    conn.client.sftp((error, sftp) => {
      if (error) reject(error)
      else resolve(sftp)
    })
  }), SFTP_OPEN_TIMEOUT_MS, 'opening the SFTP channel', signal)
}

/**
 * The caller's cancellation is NOT a transport failure and is never retried:
 * it settles the call at once, closes the channel the operation rides on (so a
 * transfer in flight really stops instead of running to its hard timeout) and
 * drops the connection, which the next call re-establishes on demand.
 *
 * Run one SFTP operation on a fresh channel with a hard timeout and ONE
 * automatic retry: if the operation (or the channel open) fails for a
 * connection-caused reason, tear the connection down, reconnect via
 * ensureAlive, and run the operation once more on a brand-new channel. This
 * is what makes a silently dropped SSH connection invisible to the model —
 * the call succeeds on the retry instead of erroring after a 60s hang.
 *
 * The caller's cancellation is NOT a transport failure and is never retried:
 * it settles the call at once, closes the channel the operation rides on (so a
 * transfer in flight really stops instead of running to its hard timeout) and
 * drops the connection, which the next call re-establishes on demand. */
async function sftpCall(agentId, operation, timeoutMs = SFTP_OP_TIMEOUT_MS, signal = undefined) {
  if (signal?.aborted) throw new Error('aborted')
  let attempt = 0
  for (;;) {
    let sftp
    try {
      sftp = await openFreshSftp(agentId, signal)
      return await withTimeout(operation(sftp), timeoutMs, 'SFTP operation', signal)
    } catch (error) {
      if (signal?.aborted === true || error?.message === 'aborted') {
        closeConnection(agentId)
        throw new Error('aborted')
      }
      if (!isConnectionFailure(error) || attempt >= 1) throw error
      attempt += 1
      closeConnection(agentId)
      await ensureAlive(agentId)
    } finally {
      if (sftp !== undefined) {
        try {
          sftp.end()
        } catch {}
      }
    }
  }
}

function sftpStat(agentId, remotePath, signal) {
  return sftpCall(agentId, (sftp) => new Promise((resolve, reject) => {
    sftp.stat(remotePath, (error, stats) => (error ? reject(error) : resolve(stats)))
  }), 30_000, signal)
}

function sftpReadText(agentId, remotePath, maxBytes, signal) {
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
  }), SFTP_OP_TIMEOUT_MS, signal)
}

function sftpWriteText(agentId, remotePath, content, signal) {
  return sftpCall(agentId, (sftp) => new Promise((resolve, reject) => {
    const stream = sftp.createWriteStream(remotePath, { encoding: 'utf8' })
    stream.on('error', reject)
    stream.on('close', () => resolve())
    stream.end(content)
  }), SFTP_OP_TIMEOUT_MS, signal)
}

async function sftpEnsureRemoteDir(agentId, remotePath, signal) {
  const parent = posix.dirname(remotePath)
  if (parent === '' || parent === '.' || parent === remotePath) return
  await remoteExec(agentId, `mkdir -p -- ${shQuote(parent)}`, { timeoutMs: 15_000, signal }).catch(() => {})
}

/** Race one transfer against a PROGRESS-driven guard: every acknowledged chunk
 * (the `bump` handler handed to the operation) pushes the deadline back, so a
 * transfer may run as long as it keeps moving while a stalled link still fails
 * after `stallMs` without progress. */
function withStallTimeout(operation, stallMs, label, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'))
      return
    }
    let timer = null
    let onAbort = null
    const done = () => {
      if (timer !== null) clearTimeout(timer)
      if (onAbort !== null) signal?.removeEventListener('abort', onAbort)
    }
    const bump = () => {
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(() => {
        done()
        reject(new Error(`${label} made no progress for ${stallMs}ms — the SFTP channel or the SSH connection is probably dead. Retry after ssh_connect.`))
      }, stallMs)
    }
    onAbort = () => {
      done()
      reject(new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    bump()
    operation(bump).then((value) => {
      done()
      resolve(value)
    }, (error) => {
      done()
      reject(error)
    })
  })
}

/** Transfers run under withStallTimeout, so sftpCall gets no wall-clock budget
 * (0): the only thing that kills a transfer is a stall, an interrupt/abort, or
 * the harness's own ToolDefinition.timeoutMs backstop. */
function sftpFastPut(agentId, localPath, remotePath, signal) {
  return sftpCall(agentId, (sftp) => withStallTimeout((bump) => new Promise((resolve, reject) => {
    sftp.fastPut(localPath, remotePath, { concurrency: SFTP_TRANSFER_CONCURRENCY, step: () => bump() }, (error) => (error ? reject(error) : resolve()))
  }), SFTP_STALL_TIMEOUT_MS, 'SFTP upload', signal), 0, signal)
}

function sftpFastGet(agentId, remotePath, localPath, signal) {
  return sftpCall(agentId, (sftp) => withStallTimeout((bump) => new Promise((resolve, reject) => {
    sftp.fastGet(remotePath, localPath, { concurrency: SFTP_TRANSFER_CONCURRENCY, step: () => bump() }, (error) => (error ? reject(error) : resolve()))
  }), SFTP_STALL_TIMEOUT_MS, 'SFTP download', signal), 0, signal)
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

function baseName(file) {
  return String(file).split(/[\\/]/).pop() ?? ''
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

/** Head line of a foreground command, written BEFORE the call settles so the
 * SSH terminal panel shows a running command instead of staying empty until
 * the remote command finishes. */
function transcriptCommandStart({ hostLabel, workdir, command }) {
  return '[' + localStamp() + '] ' + hostLabel + (workdir !== undefined ? ' ' + workdir : '') + '\n$ ' + command + '\n'
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

/** Panel-visible managed-job metadata, keyed by harness job id. */
const panelJobs = new Map()

/** Host-plane panel bridge: the panel backend lives in this package's
 * lib/index.js (host composition) because DSH 0.1.5 no longer lets preset rows
 * resolve the listening webServer. It reads this plugin's live state — same
 * process — through this shared object; module scope runs once per process, so
 * the maps stay stable across mount generations. */
try {
  globalThis.__dsrSshRemotePanel = { transcripts, connections, panelJobs }
} catch {}

/** Keep the live job map bounded: drop the oldest settled entries once it grows. */
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
      const creds = { host, port, username, password: String(args.password), timeoutMs }
      closeConnection(agentId)
      lastCreds.set(agentId, creds)
      await establishConnection(agentId, creds, exec.signal)
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
      await ensureAlive(agentId, exec.signal)
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
          // Durable lifecycle identity, same shape the stock bash tool passes.
          toolCall: { callId: exec.callId, rootCallId: exec.rootCallId },
          // `owner` is a SESSION ID, not the Agent object: JobRegistry resolves
          // it with agents.get(owner) and refuses a spec whose owner has no live
          // agent — an Agent object stringifies to "[object Object]" there.
          ...exec.agent !== undefined ? { owner: exec.agent.id } : {},
          run: (handle) => startRemoteBackgroundJob(agentId, fullCommand, transcriptForExec(exec), meta, handle),
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
      if (state !== null) {
        writeTranscript(state, transcriptCommandStart({ hostLabel, workdir, command }))
      }
      let value
      try {
        value = await remoteExec(agentId, fullCommand, { timeoutMs, signal: exec.signal, settleOnExitMarker: true })
      } catch (error) {
        if (state !== null) {
          writeTranscript(state, '[error] ' + (error.message === 'aborted' ? '[aborted]' : error.message) + '\n')
        }
        throw error
      }
      if (state !== null) {
        writeTranscript(state, capTranscriptStream(renderExecResult(value)) + '\n')
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
    timeoutMs: 300_000,
    async execute(args, exec) {
      const agentId = requireAgentId(exec)
      await ensureAlive(agentId, exec.signal)
      const path = String(args.path)
      const offset = parsePositiveInt(args.offset, 1)
      const limit = parsePositiveInt(args.limit, DEFAULT_READ_LIMIT)
      const stats = await sftpStat(agentId, path, exec.signal).catch((error) => {
        throw new Error(`cannot read remote file ${path}: ${error.message}`)
      })
      if (stats.size > MAX_READ_BYTES) {
        throw new Error(`remote file ${path} is ${stats.size} bytes (above the ${MAX_READ_BYTES} byte limit); read it in windows via ssh_bash (e.g. sed -n) instead`)
      }
      const { text } = await sftpReadText(agentId, path, MAX_READ_BYTES, exec.signal).catch((error) => {
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
    timeoutMs: 300_000,
    async execute(args, exec) {
      const agentId = requireAgentId(exec)
      await ensureAlive(agentId, exec.signal)
      const path = String(args.path)
      const content = String(args.content)
      await sftpEnsureRemoteDir(agentId, path, exec.signal)
      try {
        await sftpWriteText(agentId, path, content, exec.signal)
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
    timeoutMs: 300_000,
    async execute(args, exec) {
      const agentId = requireAgentId(exec)
      await ensureAlive(agentId, exec.signal)
      const path = String(args.path)
      const oldString = String(args.old_string)
      const newString = String(args.new_string)
      if (oldString.length === 0) throw new Error('invalid old_string: expected a non-empty string')
      const stats = await sftpStat(agentId, path, exec.signal).catch((error) => {
        throw new Error(`cannot read remote file ${path}: ${error.message}`)
      })
      if (stats.size > MAX_READ_BYTES) throw new Error(`remote file ${path} is too large to edit (${stats.size} bytes; limit ${MAX_READ_BYTES})`)
      const { text } = await sftpReadText(agentId, path, MAX_READ_BYTES, exec.signal).catch((error) => {
        throw new Error(`cannot read remote file ${path}: ${error.message}`)
      })
      const count = text.split(oldString).length - 1
      if (count === 0) throw new Error(`old_string not found in ${path}. Read the file again and copy the exact text, including whitespace and indentation.`)
      if (count > 1 && args.replace_all !== true) {
        throw new Error(`old_string appears ${count} times in ${path}. Make it unique (add surrounding context) or pass replace_all: true.`)
      }
      const next = args.replace_all === true ? text.split(oldString).join(newString) : text.replace(oldString, newString)
      await sftpEnsureRemoteDir(agentId, path, exec.signal)
      try {
        await sftpWriteText(agentId, path, next, exec.signal)
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
    timeoutMs: TRANSFER_TOOL_TIMEOUT_MS,
    async execute(args, exec) {
      const agentId = requireAgentId(exec)
      const localPath = resolveLocalWithinWorkspace(exec, String(args.local_path))
      const remotePath = String(args.remote_path)
      await ensureAlive(agentId, exec.signal)
      const stats = await fsStat(localPath).catch(() => {
        throw new Error(`local file not found: ${localPath}`)
      })
      await sftpEnsureRemoteDir(agentId, remotePath, exec.signal)
      try {
        await sftpFastPut(agentId, localPath, remotePath, exec.signal)
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
    timeoutMs: TRANSFER_TOOL_TIMEOUT_MS,
    async execute(args, exec) {
      const agentId = requireAgentId(exec)
      const remotePath = String(args.remote_path)
      const localPath = resolveLocalWithinWorkspace(exec, String(args.local_path))
      await ensureAlive(agentId, exec.signal)
      const stats = await sftpStat(agentId, remotePath, exec.signal).catch((error) => {
        throw new Error(`cannot stat remote file ${remotePath}: ${error.message}`)
      })
      try {
        await sftpFastGet(agentId, remotePath, localPath, exec.signal)
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
      stopAgentJobs(id)
      closeConnection(id)
      lastCreds.delete(id)
      reconnectInFlight.delete(id)
    }
  })

  // The panel backend lives on the HOST composition (this package's
  // lib/index.js, mounted by the same bundle's cordis.patch.yml) because DSH
  // 0.1.5 preset scopes no longer resolve the listening webServer. This plugin
  // only publishes its live state through globalThis.__dsrSshRemotePanel —
  // module scope, so the maps stay stable across mount generations.

  // Plugin teardown: no SSH connection this plugin opened outlives it.
  ctx.effect(() => () => closeAllConnections(), `${PLUGIN_NAME}.closeAll`)
}

export { PLUGIN_NAME as name, INJECT as inject, apply }
