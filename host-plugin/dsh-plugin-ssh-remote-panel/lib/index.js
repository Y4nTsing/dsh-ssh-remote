/*
 * dsh-plugin-ssh-remote-panel — host-plane panel backend for the ssh-remote
 * preset.
 *
 * Why this exists: since DSH 0.1.5, preset compositions no longer resolve the
 * host's listening webServer — a preset row's ctx.get('webServer') returns an
 * instance whose route table never reaches port 3080 (verified live: preset
 * registration logged OK while the route 404'd; a host-plane registration on
 * the same port answered 200). The panel backend therefore moved to the HOST
 * composition (this plugin, wired through the profile's cordis.patch.yml),
 * where webServer is the real listener. The panel's live per-session state
 * (connections, journal writers, managed-job metadata) still lives in the
 * preset plugin's module — same process — and is published as
 * `globalThis.__dsrSshRemotePanel = { transcripts, connections, panelJobs }`.
 * Everything else (journal files, jobs history) is disk-backed and read here
 * independently, so the panel also works before the preset ever mounts and
 * after it unmounts.
 *
 * Routes (prefix /ssh-remote-panel, same contract the preset used to serve):
 *   GET  /            standalone full-page terminal
 *   GET  /panel.js /panel.css   panel assets (served from the preset dir)
 *   GET  /sessions?titleHint=&all=
 *   GET  /transcript?file=&offset= | ?agent=&offset=
 *   GET  /jobs[?agent=&titleHint=&all=]
 *   GET  /job?id=&agent=&offset=
 *   POST /job-kill    {id}
 *   POST /diag        browser diagnostics (appended to panel-debug.log)
 */
import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { open as fsOpen, readdir, readFile, stat as fsStat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute as pathIsAbsolute, relative as pathRelative, resolve as pathResolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const name = 'ssh-remote-panel'
const inject = ['webServer']

const PANEL_BASE = '/ssh-remote-panel'
const PANEL_TAIL_CAP = 512 * 1024
const TRANSCRIPT_DIR = '.ssh-remote'
const TRANSCRIPT_JOBS_DIR = 'jobs'

const DSH_HOME = process.env.DSH_HOME ?? pathResolve(homedir(), '.dsh')
const WORKSPACE_REGISTRY = process.env.DSH_SSH_REMOTE_REGISTRY
  ?? pathResolve(DSH_HOME, 'ssh-remote-workspaces.json')
/** The preset directory still owns panel.js / panel.css and the debug log —
 * single source of truth, editable without touching this plugin. */
const PRESET_PLUGIN_DIR = process.env.DSH_SSH_REMOTE_PRESET_DIR
  ?? pathResolve(DSH_HOME, '.agent-presets', 'ssh-remote', 'plugin')

/* ---------- live state published by the preset plugin (same process) ----- */

function liveState() {
  const st = globalThis.__dsrSshRemotePanel
  if (st === undefined || st === null) {
    return { transcripts: new Map(), connections: new Map(), panelJobs: new Map() }
  }
  return {
    transcripts: st.transcripts instanceof Map ? st.transcripts : new Map(),
    connections: st.connections instanceof Map ? st.connections : new Map(),
    panelJobs: st.panelJobs instanceof Map ? st.panelJobs : new Map(),
  }
}

/* ---------- small helpers ------------------------------------------------ */

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

function safeId(id) {
  return String(id).replace(/[^a-zA-Z0-9-]/g, '').slice(-24) || 'session'
}

function sanitizeFullId(id) {
  const s = String(id).replace(/[^a-zA-Z0-9-]/g, '')
  if (s.length <= 64) return s || 'session'
  return `${s.slice(0, 64)}-${createHash('md5').update(String(id)).digest('hex').slice(0, 8)}`
}

function baseName(file) {
  return String(file).split(/[\\/]/).pop() ?? ''
}

/** True when `file` resolves strictly inside `dir`. */
function underDir(dir, file) {
  const rel = pathRelative(pathResolve(dir), pathResolve(file))
  return rel !== '' && !rel.startsWith('..') && !pathIsAbsolute(rel)
}

/** Offline diagnostics: same append-only file the preset wrote to. */
function panelDebug(line) {
  try {
    appendFileSync(pathResolve(PRESET_PLUGIN_DIR, 'panel-debug.log'), `[${new Date().toISOString()}] ${line}\n`, 'utf8')
  } catch {}
}

/* ---------- workspace + journal discovery (disk-backed) ------------------ */

async function knownWorkspaces(ctx = null) {
  const out = []
  const add = (ws) => {
    if (typeof ws === 'string' && ws.length > 0 && !out.includes(ws)) out.push(ws)
  }
  try {
    const list = JSON.parse(await readFile(WORKSPACE_REGISTRY, 'utf8'))
    if (Array.isArray(list)) list.forEach(add)
  } catch {}
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

/** A readable journal file under some known workspace's .ssh-remote dir. */
async function validJournalFile(file, { jobs = false } = {}, ctx = null) {
  if (typeof file !== 'string' || file.length === 0) return false
  const fileName = baseName(file)
  if (!fileName.endsWith('.log')) return false
  const prefixOk = jobs
    ? fileName.startsWith('job-')
    : (fileName.startsWith('session-') || fileName.startsWith('dsr-'))
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

/** Short-lived caches so the panel's conversation-switch polling stays
 * cheap. The TITLE catalog is the expensive one (sessionQuery listSessions +
 * readTitleSnapshots over every session — on 0.1.5 that fold is heavy and
 * must NOT run per poll; with the panel polling every 1.2s it starved the
 * whole app), so it lives much longer than the disk-discovery cache: titles
 * change rarely, journals change often. */
const TITLE_TTL_MS = 30_000
const DISCOVERY_TTL_MS = 5_000
const discoveryCache = new Map()

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
  for (const journalName of names) {
    if (!journalName.endsWith('.log')) continue
    let agentId = null
    if (journalName.startsWith('dsr-')) {
      agentId = journalName.slice('dsr-'.length, -'.log'.length)
    } else if (journalName.startsWith('session-')) {
      agentId = journalName.slice('session-'.length, -'.log'.length).replace(/^\d{8}-\d{6}-/, '')
    }
    if (agentId === null || agentId.length === 0) continue
    const file = pathResolve(dir, journalName)
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
      agentId: agentId || journalName,
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

/* ---------- current-conversation resolution ------------------------------ */

let titleCatalog = { expires: 0, entries: [] }
/** One refresh at a time: concurrent polls share the in-flight catalog load
 * instead of stacking listSessions+readTitleSnapshots calls. */
let titleCatalogLoading = null

async function sessionTitleCatalog(ctx) {
  if (titleCatalog.expires > Date.now()) return titleCatalog.entries
  if (titleCatalogLoading !== null) return titleCatalogLoading
  titleCatalogLoading = (async () => {
    const query = ctx.get('sessionQuery')
    if (query === undefined) return null
    try {
      const records = await query.listSessions()
      if (!Array.isArray(records)) return null
      const entries = []
      for (const record of records) {
        const id = record?.header?.id
        if (typeof id !== 'string' || id.length === 0) continue
        entries.push({ id, preset: record.header.agentPreset ?? '', live: record.live === true, cwd: record.header.cwd ?? null, title: '' })
      }
      if (entries.length === 0) {
        // Negative cache too: a failing/empty fold must not retry per poll.
        titleCatalog = { expires: Date.now() + TITLE_TTL_MS, entries: [] }
        return titleCatalog.entries
      }
      const observations = await query.readTitleSnapshots(entries.map((e) => e.id)).catch(() => [])
      for (const obs of Array.isArray(observations) ? observations : []) {
        if (obs?.status !== 'fulfilled') continue
        const title = obs?.value?.title?.title
        if (typeof title !== 'string') continue
        const entry = entries.find((e) => e.id === obs.sessionId)
        if (entry !== undefined) entry.title = title
      }
      titleCatalog = { expires: Date.now() + TITLE_TTL_MS, entries }
      return entries
    } catch {
      titleCatalog = { expires: Date.now() + 5_000, entries: [] }
      return titleCatalog.entries
    } finally {
      titleCatalogLoading = null
    }
  })()
  return titleCatalogLoading
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
    return { id: pool[0].id, cwd: pool[0].cwd }
  } catch {
    return null
  }
}

/** Authoritative "is this session RUNNING on the ssh-remote preset". */
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

/* ---------- session rows (disk + live merge) ------------------------------ */

/** A session id in the shapes journal filenames and the roster produce. */
function idVariants(sessionId) {
  const clean = String(sessionId).replace(/[^a-zA-Z0-9-]/g, '')
  return new Set([String(sessionId), clean, safeId(sessionId), sanitizeFullId(sessionId)])
}

/** Sessions rows scoped one of three ways, in priority order:
 *  - agent=<sessionId>: EXACT session identity (the official conversation
 *    view passes the current session id — no title matching, and gating is
 *    simply "a journal exists for this session");
 *  - titleHint: legacy breadcrumb-title resolution (standalone page);
 *  - all=1: the operator view. */
async function panelSessions(ctx, titleHint = '', scopeAll = false, agentParam = null) {
  const live = liveState()
  let matched = null
  let scopeWs = null
  let exactIds = null
  if (agentParam !== null && String(agentParam).length > 0) {
    exactIds = idVariants(agentParam)
    matched = { id: String(agentParam), cwd: null }
    // Scope to the workspace of this session's own journal, when known.
    for (const disk of await discoverDiskSessions(ctx)) {
      if (exactIds.has(disk.agentId)) {
        scopeWs = pathResolve(disk.workspace)
        break
      }
    }
  } else {
    matched = await resolveCurrentSessionId(ctx, titleHint)
  }
  if (!scopeAll && scopeWs === null && matched !== null && typeof matched.cwd === 'string' && matched.cwd.length > 0) {
    scopeWs = pathResolve(matched.cwd)
  }
  const inScope = (ws) => scopeWs === null || (typeof ws === 'string' && pathResolve(ws) === scopeWs)

  const rows = new Map()
  for (const disk of await discoverDiskSessions(ctx)) {
    if (!inScope(disk.workspace)) continue
    rows.set(disk.transcriptFile, disk)
  }
  for (const [agentId, st] of live.transcripts) {
    if (!inScope(st.workspace)) continue
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
  for (const [agentId, conn] of live.connections) {
    const st = live.transcripts.get(agentId)
    if (st !== undefined && !inScope(st.workspace)) continue
    let matchedRow = false
    for (const row of rows.values()) {
      if (row.agentId === agentId && row.historical === false) {
        row.connected = true
        row.userAtHost = `${conn.info.username}@${conn.info.host}:${conn.info.port}`
        matchedRow = true
      }
    }
    if (!matchedRow && (st === undefined || inScope(st.workspace))) {
      rows.set(`live:${agentId}`, {
        agentId,
        workspace: st !== undefined ? st.workspace : null,
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
  let currentId = matched !== null ? matched.id : null
  let currentIsSsh = currentId !== null && sessionRunsSshRemote(ctx, currentId)
  if (currentId !== null) {
    const variants = exactIds ?? idVariants(currentId)
    for (const row of capped) {
      if (variants.has(row.agentId)) {
        // A journal file for this exact session id is durable proof the
        // session runs the ssh-remote preset: DSH 0.1.5 resumes agents
        // lazily, so a merely VIEWED historical session has no live
        // composition binding to ask composedPreset about.
        currentIsSsh = true
        row.current = true
        row.label = `${row.label} · 当前会话`
      }
    }
  }
  return { rows: capped, currentIsSsh, scopeWorkspace: scopeWs }
}

/* ---------- transcript reads --------------------------------------------- */

async function panelTranscript(agentId, offset) {
  const live = liveState()
  const st = live.transcripts.get(agentId)
  if (st === undefined) {
    if (live.connections.has(agentId)) return { length: 0, text: '', note: 'connected but nothing journaled yet' }
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

/* ---------- jobs (live preset state + journal-parsed history) ------------- */

function panelJobRows(liveOnly) {
  const rows = []
  for (const meta of liveState().panelJobs.values()) {
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

async function allJobRows(ctx, agentFilter, titleHint = '', scopeAll = false) {
  const live = liveState()
  const { rows: sessions, scopeWorkspace } = await panelSessions(ctx, titleHint, scopeAll)
  const inWs = (agentId) => {
    if (scopeWorkspace === null) return true
    const st = live.transcripts.get(agentId)
    return st !== undefined && pathResolve(st.workspace) === scopeWorkspace
  }
  const rows = panelJobRows(agentFilter).filter((r) => inWs(r.agentId))
  const seen = new Set(rows.map((r) => `${r.agentId}/${r.id}`))
  for (const session of sessions.slice(0, 15)) {
    if (typeof session.transcriptFile !== 'string') continue
    for (const h of await historicalJobs(session)) {
      if (agentFilter !== null && h.agentId !== agentFilter) continue
      const key = `${h.agentId}/${h.id}`
      if (seen.has(key)) continue
      seen.add(key)
      rows.push(h)
    }
  }
  rows.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
  return rows.slice(0, 100)
}

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

async function panelJobOutput(jobId, offset, agentFilter = null, ctx = null) {
  const meta = liveState().panelJobs.get(jobId)
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

/* ---------- HTTP plumbing ------------------------------------------------ */

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

function panelIndexHtml() {
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1.0">'
    + '<title>SSH Remote · 终端</title>'
    + `<link rel="stylesheet" href="${PANEL_BASE}/panel.css">`
    + `<script defer src="${PANEL_BASE}/panel.js"></script>`
    + '<style>html,body{margin:0;height:100%;background:#0d1117;}</style>'
    + '</head><body></body></html>'
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
        const asset = await readFile(pathResolve(PRESET_PLUGIN_DIR, segment), 'utf8').catch(() => null)
        if (asset === null) return sendJson(res, 404, { error: `panel asset ${segment} is missing in ${PRESET_PLUGIN_DIR}` })
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
        const scopeAll = url.searchParams.get('all') === '1'
        const agent = url.searchParams.get('agent')
        const { rows, currentIsSsh, scopeWorkspace } = await panelSessions(
          ctx,
          hint,
          scopeAll,
          agent !== null && agent !== '' ? agent : null,
        )
        return sendJson(res, 200, { sessions: rows, currentIsSsh, scopeWorkspace })
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
        const hint = url.searchParams.get('titleHint') ?? ''
        const scopeAll = url.searchParams.get('all') === '1'
        return sendJson(res, 200, await allJobRows(ctx, agent === null || agent === '' ? null : agent, hint, scopeAll))
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
        const meta = liveState().panelJobs.get(String(body.id ?? ''))
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

function apply(ctx) {
  const web = ctx.webServer
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
  // NO tapIndex: the frontend is now an official client module (lib/client.js
  // registers the conversation.view "SSH 终端" tab through the slots system),
  // so nothing is injected into every page load. This route only serves the
  // JSON API, the panel assets, and the standalone page the view hosts.
  panelDebug(`host-plugin: routes registered on webServer (port=${web.port}, host=${web.host}, no tap)`)
  ctx.effect(() => () => {
    disposeRoute()
  }, 'ssh-remote-panel.routes')
}

export { name, inject, apply }
