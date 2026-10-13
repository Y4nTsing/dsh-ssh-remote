/*
 * Regression test: a foreground ssh_bash call must be ended by ITS OWN timeout
 * and by the caller's interrupt — never by the remote command's lifetime.
 *
 * Background: ssh2 emits a channel's `close` only when the PEER sends
 * CHANNEL_CLOSE, and OpenSSH keeps a session channel open for as long as the
 * exec'd child runs (it still owes an exit-status later) and ignores the SSH
 * "signal" request. Before the fix in plugin/index.js::remoteExec(), a hung
 * remote command therefore decided when the tool call ended: the per-call
 * timeout and the user's interrupt were both no-ops and the whole turn stayed
 * stuck until the command happened to finish.
 *
 * The peer below reproduces exactly that behaviour (withhold CHANNEL_CLOSE
 * while the child is alive, ignore signal requests) and drives the REAL
 * remoteExec, extracted from the plugin source — nothing is hand-copied.
 *
 *   node test/foreground-exec-settle.test.mjs
 *   DSH_SSH_REMOTE_PLUGIN=/path/to/plugin/index.js node test/foreground-exec-settle.test.mjs
 */
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, resolve as pathResolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const requireFrom = (base) => createRequire(base)

let ssh2
try {
  ssh2 = requireFrom(import.meta.url)('ssh2')
} catch {
  // running outside the repo (e.g. straight from a dsh profile)
  ssh2 = requireFrom(pathResolve(homedir(), '.dsh/profiles/web/node_modules/'))('ssh2')
}
const { Client, Server } = ssh2

const PLUGIN = process.env.DSH_SSH_REMOTE_PLUGIN ?? pathResolve(here, '../plugin/index.js')
const GRACE_MS = Number(process.env.DSH_SSH_KILL_SETTLE_GRACE_MS) || 5_000
const REMOTE_CMD_MS = 20_000 // the remote command outlives every deadline below

const connections = new Map()
const closeConnection = (agentId) => {
  const conn = connections.get(agentId)
  if (conn === undefined) return
  connections.delete(agentId)
  try {
    conn.client.end()
  } catch {}
}

/** Pull the real remoteExec (and its numeric knobs) out of the plugin source. */
function extractRemoteExec(file) {
  const s = readFileSync(file, 'utf8')
  const names = ['STREAM_CAP_CHARS', 'DEFAULT_EXEC_TIMEOUT_MS', 'EXEC_NO_RESPONSE_GRACE_MS', 'KILL_SETTLE_GRACE_MS']
  const values = names.map((n) => {
    const m = new RegExp(`^const ${n} = (.+)$`, 'm').exec(s)
    return m === null ? 0 : eval(m[1]) // eslint-disable-line no-eval
  })
  const start = s.indexOf('function remoteExec(')
  let paren = 0
  let i = s.indexOf('(', start)
  for (; i < s.length; i += 1) {
    if (s[i] === '(') paren += 1
    else if (s[i] === ')') { paren -= 1; if (paren === 0) break }
  }
  let depth = 0
  let end = -1
  for (i = s.indexOf('{', i); i < s.length; i += 1) {
    if (s[i] === '{') depth += 1
    else if (s[i] === '}') { depth -= 1; if (depth === 0) { end = i + 1; break } }
  }
  const factory = new Function('connections', 'closeConnection', ...names, `${s.slice(start, end)}; return remoteExec`)
  return factory(connections, closeConnection, ...values)
}

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
})

function startPeer() {
  return new Promise((resolvePeer) => {
    const server = new Server({ hostKeys: [privateKey] }, (client) => {
      const suppressed = new Set()
      client.on('authentication', (ctx) => ctx.accept())
      client.on('ready', () => {
        const proto = client._protocol
        const origClose = proto.channelClose.bind(proto)
        proto.channelClose = (chan) => {
          if (suppressed.has(chan)) return // OpenSSH: child still owns the channel
          return origClose(chan)
        }
        client.on('session', (accept) => {
          const session = accept()
          session.on('signal', () => {}) // OpenSSH ignores these
          session.on('exec', (accept, _reject, info) => {
            const stream = accept()
            const chanId = stream.outgoing.id
            suppressed.add(chanId)
            const child = spawn('/bin/sh', ['-c', info.command])
            child.stdout.on('data', (d) => stream.write(d))
            child.stderr.on('data', (d) => stream.stderr.write(d))
            child.on('exit', (code) => {
              suppressed.delete(chanId)
              try { stream.exit(code ?? 0) } catch {}
              try { stream.end() } catch {}
              try { origClose(chanId) } catch {}
            })
          })
        })
      })
    })
    server.listen(0, '127.0.0.1', () => resolvePeer({ server, port: server.address().port }))
  })
}

function connect(port) {
  return new Promise((resolveClient, reject) => {
    const client = new Client()
    client.on('ready', () => resolveClient(client)).on('error', reject)
    client.connect({ host: '127.0.0.1', port, username: 'test', password: 'x', readyTimeout: 10_000 })
  })
}

/** Never let the test itself hang: report an unsettled call. */
function bounded(thunk, ms) {
  return new Promise((resolveRun) => {
    const t = Date.now()
    let done = false
    const watchdog = setTimeout(() => {
      if (done) return
      done = true
      resolveRun({ outcome: 'pending', ms: Date.now() - t })
    }, ms)
    thunk().then(
      (v) => { if (!done) { done = true; clearTimeout(watchdog); resolveRun({ outcome: 'resolved', ms: Date.now() - t, value: v }) } },
      (e) => { if (!done) { done = true; clearTimeout(watchdog); resolveRun({ outcome: 'rejected', ms: Date.now() - t, error: e.message }) } },
    )
  })
}

const remoteExec = extractRemoteExec(PLUGIN)
const { server, port } = await startPeer()
const results = []

{
  const client = await connect(port)
  connections.set('timeout-case', { client, info: {} })
  const r = await bounded(
    () => remoteExec('timeout-case', `sleep ${REMOTE_CMD_MS / 1000}; echo DONE`, { timeoutMs: 3000 }),
    12_000,
  )
  results.push({
    name: 'timeout ends the call',
    ...r,
    pass: r.outcome === 'resolved' && r.value.timedOut === true && r.ms <= 3000 + GRACE_MS + 1500,
    detail: 'resolved with timedOut=true within timeoutMs + settle grace',
  })
}

{
  const client = await connect(port)
  connections.set('abort-case', { client, info: {} })
  const ctrl = new AbortController()
  setTimeout(() => ctrl.abort(), 1500)
  const r = await bounded(
    () => remoteExec('abort-case', `sleep ${REMOTE_CMD_MS / 1000}; echo DONE`, { timeoutMs: 60_000, signal: ctrl.signal }),
    12_000,
  )
  results.push({
    name: 'interrupt ends the call',
    ...r,
    pass: r.outcome === 'rejected' && r.error === 'aborted' && r.ms <= 2500,
    detail: 'rejects with aborted right after the abort fires',
  })
}

{
  const client = await connect(port)
  connections.set('control-case', { client, info: {} })
  const r = await bounded(() => remoteExec('control-case', 'echo hi', { timeoutMs: 3000 }), 5000)
  results.push({
    name: 'ordinary call is unaffected',
    ...r,
    pass: r.outcome === 'resolved' && r.value.stdout === 'hi\n' && r.ms <= 2000,
    detail: 'returns stdout as before',
  })
}

server.close()
for (const r of results) {
  const got = r.outcome === 'resolved'
    ? `resolved after ${r.ms}ms${r.value.timedOut === true ? ' (timedOut)' : ''}`
    : r.outcome === 'rejected' ? `rejected after ${r.ms}ms [${r.error}]` : `STILL PENDING after ${r.ms}ms`
  console.log(`${r.pass ? 'ok  ' : 'FAIL'} ${r.name}: ${got}  — expected ${r.detail}`)
}
const failed = results.filter((r) => !r.pass)
console.log(failed.length === 0 ? '\nPASS' : `\n${failed.length} FAILED`)
process.exit(failed.length === 0 ? 0 : 1)
