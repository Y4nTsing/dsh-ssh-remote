/*
 * Regression test: a transfer in flight (SFTP) must be stoppable.
 *
 * `sftp_upload` / `sftp_download` / `ssh_read` / `ssh_write` / `ssh_edit` all go
 * through sftpCall(), which used to accept no cancellation signal at all: once a
 * transfer had started, the user's interrupt was a no-op and the tool call only
 * ended on the transfer's own hard timeout (60s op / 180s transfer, and a
 * connection-flavoured failure retried it once — so up to twice that).
 *
 * The peer below is a REAL SFTP server over ssh2 that trickles data (one 32 KiB
 * chunk every 200ms) for /slow.bin, i.e. a transfer that is genuinely still
 * progressing when the interrupt arrives. The test drives the REAL sftpCall /
 * sftpFastGet / sftpFastPut extracted from plugin/index.js.
 *
 *   node test/sftp-interrupt.test.mjs
 *   DSH_SSH_REMOTE_PLUGIN=/path/to/plugin/index.js node test/sftp-interrupt.test.mjs
 */
import { createRequire } from 'node:module'
import { generateKeyPairSync } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve as pathResolve } from 'node:path'
import { posix } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const requireFrom = (base) => createRequire(base)

let ssh2
try {
  ssh2 = requireFrom(import.meta.url)('ssh2')
} catch {
  ssh2 = requireFrom(pathResolve(homedir(), '.dsh/profiles/web/node_modules/'))('ssh2')
}
const { Client, Server, utils: { sftp: { STATUS_CODE } } } = ssh2

const PLUGIN = process.env.DSH_SSH_REMOTE_PLUGIN ?? pathResolve(here, '../plugin/index.js')


const CHUNK = 32 * 1024
const SLOW_SIZE = 4 * 1024 * 1024
const TRICKLE_CHUNKS = 45 // ~4.5s at RATE_MS, i.e. 3x the guard below
const TRICKLE_SIZE = TRICKLE_CHUNKS * CHUNK
const STALL_AFTER_CHUNKS = 3
const RATE_MS = 100 // global trickle: one 32 KiB chunk / 100ms regardless of pipelining
// The guard must comfortably exceed the time to the FIRST progress signal,
// which is bounded by the pre-read window (concurrency x 32 KiB). 20 chunks
// worth of the 100ms trickle, with the interrupt well inside that.
const GUARD_MS = 2000 // DSH_SFTP_STALL_TIMEOUT_MS (new) / DSH_SFTP_TRANSFER_TIMEOUT_MS (old)
const INTERRUPT_AFTER_MS = 800 // well before the guard, well into a ~13s transfer
let LOCAL_DIR = join(tmpdir(), `dsh-sftp-interrupt-${process.pid}`)
try {
  mkdirSync(LOCAL_DIR, { recursive: true })
} catch {
  LOCAL_DIR = join(here, '.tmp-sftp') // sandboxed tmpdir
  mkdirSync(LOCAL_DIR, { recursive: true })
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

/* ---------- pull the real implementation out of the plugin source ---------- */
function functionSource(src, name) {
  const match = new RegExp(`(async\\s+)?function ${name}\\(`).exec(src)
  if (match === null) return '' // absent in the pre-fix source, which is fine
  const from = match.index // keeps a leading `async ` when present
  let paren = 0
  let i = src.indexOf('(', from)
  for (; i < src.length; i += 1) {
    if (src[i] === '(') paren += 1
    else if (src[i] === ')') { paren -= 1; if (paren === 0) break }
  }
  let depth = 0
  for (i = src.indexOf('{', i); i < src.length; i += 1) {
    if (src[i] === '{') depth += 1
    else if (src[i] === '}') { depth -= 1; if (depth === 0) return src.slice(from, i + 1) }
  }
  throw new Error(`unbalanced braces in ${name}`)
}

function loadSftpLayer(file) {
  const src = readFileSync(file, 'utf8')
  const constNames = ['SFTP_OPEN_TIMEOUT_MS', 'SFTP_OP_TIMEOUT_MS', 'SFTP_TRANSFER_TIMEOUT_MS', 'SFTP_STALL_TIMEOUT_MS', 'SFTP_TRANSFER_CONCURRENCY']
  const constValues = constNames.map((n) => {
    const m = new RegExp(`^const ${n} = (.+)$`, 'm').exec(src)
    return m === null ? 0 : eval(m[1]) // eslint-disable-line no-eval
  })
  const names = ['notConnectedError', 'withTimeout', 'isConnectionFailure', 'openFreshSftp', 'withStallTimeout', 'sftpCall', 'sftpFastGet', 'sftpFastPut']
  const fns = names.map((n) => functionSource(src, n)).filter((t) => t !== '').join('\n')
  const factory = new Function(
    'connections', 'closeConnection', 'ensureAlive', 'remoteExec', 'posix', 'shQuote',
    ...constNames,
    `${fns}
     ; return { sftpCall, sftpFastGet, sftpFastPut }`,
  )
  return factory(
    connections,
    closeConnection,
    async (agentId) => {
      // Like the real ensureAlive: re-establish from the stored credentials.
      if (!connections.has(agentId)) await connect(port, agentId)
    },
    async () => {}, // remoteExec (only used by sftpEnsureRemoteDir, not exercised)
    posix,
    (v) => `'${String(v).replace(/'/g, `'\\''`)}'`,
    ...constValues,
  )
}

/* ---------- a real SFTP server that trickles ---------- */
const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
})

function startPeer() {
  return new Promise((resolvePeer) => {
    const server = new Server({ hostKeys: [privateKey] }, (client) => {
      client.on('authentication', (ctx) => ctx.accept())
      client.on('ready', () => {
        client.on('session', (accept) => {
          const session = accept()
          session.on('sftp', (acceptSftp) => {
            const sftp = acceptSftp()
            const handles = new Map()
            let handleCount = 0
            // One transfer-wide budget: ssh2 pipelines up to 64 read requests,
            // so a per-request delay would not model a slow link at all.
            let nextSlotAt = 0
            const reserveSlot = () => {
              const now = Date.now()
              const at = Math.max(now, nextSlotAt)
              nextSlotAt = at + RATE_MS
              return at - now
            }
            const attrsFor = (size) => ({ mode: 0o100644, uid: 0, gid: 0, size, atime: 0, mtime: 0 })
            const newHandle = () => {
              const handle = Buffer.alloc(4)
              handle.writeUInt32BE(handleCount, 0, true)
              handles.set(handleCount, { path: null })
              handleCount += 1
              return handle
            }
            sftp.on('REALPATH', (reqid, p) => sftp.name(reqid, [{ filename: p, longname: p, attrs: attrsFor(0) }]))
            sftp.on('OPEN', (reqid, filename, flags) => {
              const handle = newHandle()
              handles.get(handle.readUInt32BE(0, true)).path = filename
              sftp.handle(reqid, handle)
            })
            const sizeOf = (p) => (p === '/slow.bin' ? SLOW_SIZE : p === '/trickle.bin' ? TRICKLE_SIZE : p === '/stall.bin' ? SLOW_SIZE : 4096)
            const trickles = (p) => p === '/slow.bin' || p === '/trickle.bin'
            const statReply = (reqid, handle) => {
              const state = handles.get(handle.readUInt32BE(0, true))
              sftp.attrs(reqid, attrsFor(sizeOf(state?.path)))
            }
            sftp.on('FSTAT', (reqid, handle) => statReply(reqid, handle))
            sftp.on('STAT', (reqid) => sftp.attrs(reqid, attrsFor(SLOW_SIZE)))
            sftp.on('LSTAT', (reqid) => sftp.attrs(reqid, attrsFor(SLOW_SIZE)))
            sftp.on('READ', (reqid, handle, offset, length) => {
              const state = handles.get(handle.readUInt32BE(0, true))
              const path = state?.path
              const size = sizeOf(path)
              if (offset >= size) return sftp.status(reqid, STATUS_CODE.EOF)
              // A wedged link: answer the first chunks, then never reply again.
              if (path === '/stall.bin' && offset >= STALL_AFTER_CHUNKS * CHUNK) return
              const n = Math.min(length, CHUNK, size - offset)
              const send = () => sftp.data(reqid, Buffer.alloc(n, 0x41))
              if (trickles(path)) setTimeout(send, reserveSlot())
              else send()
            })
            sftp.on('WRITE', (reqid) => setTimeout(() => sftp.status(reqid, STATUS_CODE.OK), reserveSlot()))
            sftp.on('CLOSE', (reqid) => sftp.status(reqid, STATUS_CODE.OK))
            sftp.on('FSETSTAT', (reqid) => sftp.status(reqid, STATUS_CODE.OK))
            sftp.on('SETSTAT', (reqid) => sftp.status(reqid, STATUS_CODE.OK))
          })
        })
      })
    })
    server.listen(0, '127.0.0.1', () => resolvePeer({ server, port: server.address().port }))
  })
}

function connect(port, id) {
  return new Promise((resolveClient, reject) => {
    const client = new Client()
    client.on('ready', () => {
      connections.set(id, { client, info: {} })
      resolveClient(client)
    }).on('error', reject)
    client.connect({ host: '127.0.0.1', port, username: 'test', password: 'x', readyTimeout: 10_000 })
  })
}

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

// One knob, two implementations: the progress-driven stall guard reads the
// first, the retired wall-clock transfer cap the second. Same 300ms value, so
// the same scenario shows the difference.
process.env.DSH_SFTP_STALL_TIMEOUT_MS = String(GUARD_MS)
process.env.DSH_SFTP_TRANSFER_TIMEOUT_MS = String(GUARD_MS)

const { sftpFastGet, sftpFastPut } = loadSftpLayer(PLUGIN)
const { server, port } = await startPeer()
const results = []

/* A: download interrupted mid-transfer */
{
  await connect(port, 'get')
  const ctrl = new AbortController()
  setTimeout(() => ctrl.abort(), INTERRUPT_AFTER_MS)
  const local = join(LOCAL_DIR, 'slow.bin')
  const r = await bounded(() => sftpFastGet('get', '/slow.bin', local, ctrl.signal), 12_000)
  results.push({
    name: 'sftp_download interrupt stops the transfer',
    ...r,
    pass: r.outcome === 'rejected' && r.error === 'aborted' && r.ms <= 2500,
    detail: `rejects with aborted right after the interrupt at ${INTERRUPT_AFTER_MS}ms (transfer itself needs ~13s)`,
  })
}

/* B: upload interrupted mid-transfer */
{
  await connect(port, 'put')
  const local = join(LOCAL_DIR, 'upload.bin')
  writeFileSync(local, Buffer.alloc(SLOW_SIZE, 0x42))
  const ctrl = new AbortController()
  setTimeout(() => ctrl.abort(), INTERRUPT_AFTER_MS)
  const r = await bounded(() => sftpFastPut('put', local, '/upload.bin', ctrl.signal), 12_000)
  results.push({
    name: 'sftp_upload interrupt stops the transfer',
    ...r,
    pass: r.outcome === 'rejected' && r.error === 'aborted' && r.ms <= 2500,
    detail: `rejects with aborted right after the interrupt at ${INTERRUPT_AFTER_MS}ms`,
  })
}

/* D: slow but progressing — must NOT be killed (no wall-clock cap) */
{
  await connect(port, 'trickle')
  const local = join(LOCAL_DIR, 'trickle.bin')
  const r = await bounded(() => sftpFastGet('trickle', '/trickle.bin', local, undefined), 12_000)
  const bytes = r.outcome === 'resolved' ? readFileSync(local).length : -1
  results.push({
    name: 'slow-but-progressing transfer is not killed',
    ...r,
    pass: r.outcome === 'resolved' && bytes === TRICKLE_SIZE && r.ms > GUARD_MS,
    detail: `completes ${TRICKLE_SIZE} bytes over ~${(TRICKLE_CHUNKS * RATE_MS / 1000).toFixed(1)}s, i.e. OUTLIVES the ${GUARD_MS}ms guard budget because it keeps making progress`,
  })
}

/* E: a wedged link must still fail, and say why */
{
  await connect(port, 'stall')
  const local = join(LOCAL_DIR, 'stall.bin')
  const r = await bounded(() => sftpFastGet('stall', '/stall.bin', local, undefined), 8000)
  results.push({
    name: 'wedged transfer still fails',
    ...r,
    pass: r.outcome === 'rejected' && /no progress|timed out after/.test(String(r.error)) && r.ms <= 8000,
    detail: `fails on stalls (${GUARD_MS}ms budget), never hangs`,
  })
}

/* C: control — a small transfer still completes normally */
{
  await connect(port, 'small')
  const local = join(LOCAL_DIR, 'small.bin')
  const r = await bounded(() => sftpFastGet('small', '/small.bin', local, undefined), 8000)
  const bytes = r.outcome === 'resolved' ? readFileSync(local).length : -1
  results.push({
    name: 'ordinary transfer unaffected',
    ...r,
    pass: r.outcome === 'resolved' && bytes === 4096,
    detail: 'downloads 4096 bytes as before',
  })
}

server.close()
rmSync(LOCAL_DIR, { recursive: true, force: true })

for (const r of results) {
  const got = r.outcome === 'resolved'
    ? `resolved after ${r.ms}ms`
    : r.outcome === 'rejected' ? `rejected after ${r.ms}ms [${r.error}]` : `STILL RUNNING after ${r.ms}ms`
  console.log(`${r.pass ? 'ok  ' : 'FAIL'} ${r.name}: ${got}  — expected ${r.detail}`)
}
const failed = results.filter((r) => !r.pass)
console.log(failed.length === 0 ? '\nPASS' : `\n${failed.length} FAILED`)
process.exit(failed.length === 0 ? 0 : 1)
