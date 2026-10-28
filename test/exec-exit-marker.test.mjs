/*
 * Regression test: a foreground ssh_bash command that leaves a child running
 * (e.g. `setsid nohup … &`) must settle when the SHELL is done, not when the
 * peer finally closes the session channel.
 *
 * Background: OpenSSH keeps a session channel open while any child of the
 * shell is still alive, so remoteExec() — which used to settle only on the
 * channel's `close` — waited for its own timeout even though the foreground
 * command had already finished (measured live: 120.6s for a `sleep 30`
 * command, 180.6s for a `sleep 110` one). remoteExec() now takes
 * `settleOnExitMarker`: the command gets a trailing printf sentinel and the
 * call settles as soon as the shell prints it, leaving the channel open so the
 * detached child survives.
 *
 * This drives the REAL remoteExec extracted from the plugin source against a
 * fake channel that never emits `close`, so it needs no SSH server and runs on
 * Windows too.
 *
 *   node test/exec-exit-marker.test.mjs
 *   DSH_SSH_REMOTE_PLUGIN=/path/to/preset/plugin/index.js node test/exec-exit-marker.test.mjs
 */
import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, resolve as pathResolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const PLUGIN = process.env.DSH_SSH_REMOTE_PLUGIN ?? pathResolve(here, '../preset/plugin/index.js')

/** Pull the real remoteExec (and its numeric knobs) out of the plugin source. */
function extractRemoteExec(file) {
  const s = readFileSync(file, 'utf8')
  const names = ['STREAM_CAP_CHARS', 'DEFAULT_EXEC_TIMEOUT_MS', 'EXEC_NO_RESPONSE_GRACE_MS', 'KILL_SETTLE_GRACE_MS']
  const values = names.map((n) => {
    const m = new RegExp(`^const ${n} = (.+)$`, 'm').exec(s)
    return m === null ? 0 : eval(m[1]) // eslint-disable-line no-eval
  })
  const start = s.indexOf('function remoteExec(')
  if (start === -1) throw new Error(`remoteExec not found in ${file}`)
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

const connections = new Map()
const closeConnection = (agentId) => {
  const conn = connections.get(agentId)
  if (conn === undefined) return
  connections.delete(agentId)
  try {
    conn.client.end()
  } catch {}
}

/** A channel stand-in: real streams, no SSH, and `close` never emitted. */
function fakeChannel() {
  const channel = new EventEmitter()
  channel.stdout = new PassThrough()
  channel.stderr = new PassThrough()
  channel.closed = false
  channel.close = () => { channel.closed = true }
  channel.signal = () => {}
  return channel
}

function serve(id, channel, seen) {
  connections.set(id, {
    client: {
      exec: (command, cb) => { if (seen !== undefined) seen.push(command); cb(null, channel) },
      end: () => {},
    },
    info: {},
  })
}

const remoteExec = extractRemoteExec(PLUGIN)
const results = []
const report = (name, pass, detail) => results.push({ name, pass, detail })

// 1. The marker settles the call while the channel stays open.
{
  const seen = []
  const channel = fakeChannel()
  serve('marker', channel, seen)
  const started = Date.now()
  const pending = remoteExec('marker', 'sleep 30; echo out', { timeoutMs: 5000, settleOnExitMarker: true })
  setTimeout(() => {
    channel.stdout.write('out\n')
    channel.stdout.write('\n__DSH_SSH_EXIT__0\n')
  }, 10)
  const value = await pending
  const ms = Date.now() - started
  report('marker settles the call while the channel is still open',
    value.exitCode === 0 && value.timedOut === false && value.stdout === 'out\n' && ms < 1000,
    JSON.stringify({ ms, value }))
  report('wire command appends the printf sentinel',
    seen.length === 1 && seen[0].includes('printf \'\\n__DSH_SSH_EXIT__%s\\n\' "$?"'),
    JSON.stringify(seen))
  report('marker settle leaves the channel open (detached child survives)',
    channel.closed === false, `closed=${channel.closed}`)
}

// 2. No marker: the old timeout path still ends the call.
{
  const channel = fakeChannel()
  serve('timeout', channel)
  const started = Date.now()
  const value = await remoteExec('timeout', 'sleep 300', { timeoutMs: 150, settleOnExitMarker: true })
  const ms = Date.now() - started
  report('timeout still ends a command that never prints the marker',
    value.timedOut === true && ms >= 150 && ms < 150 + 5000 + 1000,
    JSON.stringify({ ms, timedOut: value.timedOut }))
}

// 3. Exit code comes from the marker; the sentinel line is stripped from stdout.
{
  const channel = fakeChannel()
  serve('code', channel)
  const pending = remoteExec('code', 'echo hi', { timeoutMs: 5000, settleOnExitMarker: true })
  setTimeout(() => channel.stdout.write('hi\n\n__DSH_SSH_EXIT__3\n'), 10)
  const value = await pending
  report('exit code comes from the marker and stdout keeps its content',
    value.exitCode === 3 && value.stdout === 'hi\n', JSON.stringify(value))
}

// 4. With the option off, behaviour is unchanged: settle on close, marker text is ordinary output.
{
  const channel = fakeChannel()
  serve('off', channel)
  const pending = remoteExec('off', 'x', { timeoutMs: 5000 })
  setTimeout(() => {
    channel.stdout.write('__DSH_SSH_EXIT__0\n')
    channel.stdout.end()
    channel.emit('close', 0)
  }, 10)
  const value = await pending
  report('option off keeps the close-driven path',
    value.exitCode === 0 && value.stdout === '__DSH_SSH_EXIT__0\n', JSON.stringify(value))
}

for (const r of results) console.log(`${r.pass ? 'ok  ' : 'FAIL'} ${r.name}${r.pass ? '' : `  -> ${r.detail}`}`)
const failed = results.filter((r) => !r.pass)
console.log(failed.length === 0 ? '\nPASS' : `\n${failed.length} FAILED`)
process.exit(failed.length === 0 ? 0 : 1)
