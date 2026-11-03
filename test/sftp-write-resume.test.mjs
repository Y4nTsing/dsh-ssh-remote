/*
 * Regression test: writing a remote file must survive a path that swallows
 * SFTP WRITE packets, and must resume instead of rewriting from zero.
 *
 * Background: ssh_write / ssh_edit used ssh2's `createWriteStream()`, which
 * sends the whole content as ONE SSH_FXP_WRITE and waits for that reply. On a
 * real host every control request (open/fchmod/chmod/stat) answered in ~128ms
 * while a single 2 KiB WRITE was never answered at all — the call then failed
 * after 60s, retried, failed again after another 60s, and the connection was
 * dead afterwards. The same bytes written as 16 KiB chunks completed in ~800ms.
 *
 * The peer below reproduces that: it answers control requests immediately, and
 * swallows WRITE requests that carry more than CHUNK bytes (and every WRITE on
 * the first connection, modelling the "whole connection went bad" case). It then
 * records which offsets actually arrived, so the test can assert that the retry
 * resumed instead of starting over.
 *
 *   node test/sftp-write-resume.test.mjs
 *   DSH_SSH_REMOTE_PLUGIN=/path/to/preset/plugin/index.js node test/sftp-write-resume.test.mjs
 */
import { createRequire } from 'node:module'
import { generateKeyPairSync } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, posix, resolve as pathResolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const requireFrom = (base) => createRequire(base)

let ssh2
try {
  ssh2 = requireFrom(import.meta.url)('ssh2')
} catch {
  ssh2 = requireFrom(pathResolve(homedir(), '.dsh/profiles/web/node_modules/'))('ssh2')
}
const { Client, Server, utils: { sftp: { STATUS_CODE } } } = ssh2

const PLUGIN = process.env.DSH_SSH_REMOTE_PLUGIN ?? pathResolve(here, '../preset/plugin/index.js')

/** Bigger than one chunk, so at least two WRITE requests are needed. */
const CONTENT = `${'0123456789abcdef'.repeat(2048)}END`
const BLOCK_PAYLOAD = 16 * 1024
const FIRST_CONNECTION_WRITES_ALLOWED = 1 // then the whole connection is "dead"

/* ---------- pull the real implementation out of the plugin source ---------- */
function functionSource(src, name) {
  const match = new RegExp(`(async\\s+)?function ${name}\\(`).exec(src)
  if (match === null) throw new Error(`${name} not found in the plugin source`)
  const from = match.index
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

const connections = new Map()
const closeConnection = (agentId) => {
  const conn = connections.get(agentId)
  if (conn === undefined) return
  connections.delete(agentId)
  try {
    conn.client.end()
  } catch {}
}

function loadWriteLayer(file, port) {
  const src = readFileSync(file, 'utf8')
  const consts = {}
  const constNames = [
    'SFTP_OPEN_TIMEOUT_MS',
    'SFTP_OP_TIMEOUT_MS',
    'SFTP_CHUNK_SIZE',
    'SFTP_WRITE_CHUNK_BYTES',
    'SFTP_WRITE_CHUNK_TIMEOUT_MS',
    'SFTP_WRITE_ATTEMPTS',
    'SFTP_CLOSE_TIMEOUT_MS',
  ]
  const constValues = []
  for (const n of constNames) {
    const m = new RegExp(`^const ${n} = (.+)$`, 'm').exec(src)
    if (m === null) throw new Error(`missing ${n}`)
    // Resolve in declaration order so a later constant may reference an earlier
    // one (SFTP_WRITE_CHUNK_BYTES -> SFTP_CHUNK_SIZE); eval alone cannot see
    // object properties.
    const declared = Object.keys(consts)
    consts[n] = new Function(...declared, `return (${m[1]})`)(...declared.map((k) => consts[k]))
    constValues.push(consts[n])
  }
  const names = ['notConnectedError', 'withTimeout', 'isConnectionFailure', 'openFreshSftp', 'sftpOpenHandle', 'sftpWriteChunk', 'sftpCloseHandle', 'sftpWriteText']
  const fns = names.map((n) => functionSource(src, n)).join('\n')
  const factory = new Function(
    'connections', 'closeConnection', 'ensureAlive', ...constNames,
    `${fns}; return { sftpWriteText, consts: { SFTP_WRITE_CHUNK_BYTES, SFTP_WRITE_CHUNK_TIMEOUT_MS, SFTP_WRITE_ATTEMPTS } }`,
  )
  return factory(
    connections,
    closeConnection,
    async (agentId) => { if (!connections.has(agentId)) await connect(port, agentId) },
    ...constValues,
  )
}

/* ---------- a real SFTP server that swallows large WRITEs ---------- */
const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
})

const seen = []            // every write request that the server answered
let connectionCount = 0

function startPeer() {
  return new Promise((resolvePeer) => {
    const server = new Server({ hostKeys: [privateKey] }, (client) => {
      connectionCount += 1
      const connectionIndex = connectionCount
      client.on('authentication', (ctx) => ctx.accept())
      client.on('ready', () => {
        client.on('session', (accept) => {
          const session = accept()
          session.on('sftp', (acceptSftp) => {
            const sftp = acceptSftp()
            let writesAnswered = 0
            sftp.on('REALPATH', (reqid, p) => sftp.name(reqid, [{ filename: p, longname: p, attrs: { mode: 0o100644, uid: 0, gid: 0, size: 0, atime: 0, mtime: 0 } }]))
            sftp.on('OPEN', (reqid) => {
              const handle = Buffer.alloc(4)
              handle.writeUInt32BE(1, 0, true)
              sftp.handle(reqid, handle)
            })
            sftp.on('FSTAT', (reqid) => sftp.attrs(reqid, { mode: 0o100644, uid: 0, gid: 0, size: 0, atime: 0, mtime: 0 }))
            sftp.on('WRITE', (reqid, handle, offset, data) => {
              // A path-level black hole: the request is simply never answered.
              const tooBig = data.length > BLOCK_PAYLOAD
              const connectionDead = connectionIndex === 1 && writesAnswered >= FIRST_CONNECTION_WRITES_ALLOWED
              if (tooBig || connectionDead) return
              writesAnswered += 1
              seen.push({ connection: connectionIndex, offset, length: data.length })
              sftp.status(reqid, STATUS_CODE.OK)
            })
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

const { server, port } = await startPeer()
const layer = loadWriteLayer(PLUGIN, port)
console.log(`chunk=${layer.consts.SFTP_WRITE_CHUNK_BYTES}B chunkTimeout=${layer.consts.SFTP_WRITE_CHUNK_TIMEOUT_MS}ms attempts=${layer.consts.SFTP_WRITE_ATTEMPTS}`)

const results = []
const record = (name, pass, detail) => results.push({ name, pass, detail })

// The first connection answers one small WRITE, then goes silent; the retry has
// to reconnect and resume from the acknowledged offset.
{
  const r = await bounded(async () => {
    await connect(port, 'resume')
    await layer.sftpWriteText('resume', '/resume.txt', CONTENT)
    return 'ok'
  }, 30_000)
  record('write completes on a fresh connection after the first one went silent',
    r.outcome === 'resolved' && r.value === 'ok',
    JSON.stringify(r))

  // Every byte must be accounted for exactly once: the resumed attempt may not
  // rewrite the acknowledged prefix, and no offset may be missing.
  const covered = new Set()
  let overlap = 0
  for (const w of seen) {
    for (let i = 0; i < w.length; i += 1) {
      if (covered.has(w.offset + i)) overlap += 1
      covered.add(w.offset + i)
    }
  }
  record('the retry resumed instead of rewriting from zero',
    overlap === 0 && seen.length >= 3,
    `writes=${seen.length} connections=${connectionCount} overlapBytes=${overlap}`)
  record('every byte of the file was written',
    covered.size === Buffer.byteLength(CONTENT, 'utf8'),
    `covered=${covered.size} expected=${Buffer.byteLength(CONTENT, 'utf8')}`)
  record('no request carried more than one chunk',
    seen.every((w) => w.length <= BLOCK_PAYLOAD),
    `max=${Math.max(...seen.map((w) => w.length))}`)
}

server.close()
for (const r of results) console.log(`${r.pass ? 'ok  ' : 'FAIL'} ${r.name}${r.pass ? '' : `  -> ${r.detail}`}`)
const failed = results.filter((r) => !r.pass)
console.log(failed.length === 0 ? '\nPASS' : `\n${failed.length} FAILED`)
process.exit(failed.length === 0 ? 0 : 1)
