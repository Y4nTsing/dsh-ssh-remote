/*
 * Regression test: background jobs must register an owner the harness accepts.
 *
 * JobSpec.owner is a SESSION ID (dsh-jobs types: "Owning session ... the owner's
 * live Agent must be the one currently registered under that id"), and
 * dsh-jobs-local resolves it with agents.get(owner). Passing the Agent OBJECT
 * makes that lookup miss and throws:
 *
 *   session "[object Object]" has no live agent (background job owner must be live)
 *
 * The same field-shape mistake applied to JobRegistry.kill(id, caller), whose
 * caller is also a SessionId.
 *
 * This test extracts the REAL ssh_bash ToolDefinition from plugin/index.js and
 * drives its run_in_background path against a jobs service that reproduces the
 * harness's owner resolution, so the pre-fix code fails with the exact error
 * above and the fixed code registers normally.
 *
 *   node test/background-job-owner.test.mjs
 *   DSH_SSH_REMOTE_PLUGIN=/path/to/plugin/index.js node test/background-job-owner.test.mjs
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, resolve as pathResolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const PLUGIN = process.env.DSH_SSH_REMOTE_PLUGIN ?? pathResolve(here, '../plugin/index.js')
const source = readFileSync(PLUGIN, 'utf8')

/* ---------- extract the real tool definition ---------- */
function extractToolDefinition(src, toolName) {
  const marker = `ctx.tools.register({\n    name: '${toolName}',`
  const start = src.indexOf(marker)
  if (start < 0) throw new Error(`registration of ${toolName} not found`)
  const end = src.indexOf('\n  })', start)
  if (end < 0) throw new Error(`end of ${toolName} registration not found`)
  const expr = src.slice(start, end + '\n  })'.length)
  if (!expr.includes('run_in_background')) throw new Error('extracted block does not look like ssh_bash')
  return expr
}

/* ---------- a jobs service faithful to the harness contract ---------- */
const liveAgents = new Map([['session-live', { id: 'session-live' }]])
const started = []
/** The registry hands this to spec.run(); it is what `job_output` reads. */
const ring = []
const jobHandle = { id: 'ssh-1', append: (text) => ring.push(text), updateProgress: () => {} }
let producerHandle = null
const jobs = {
  start(spec) {
    // dsh-jobs-local: resolveOwner(session) -> agents.get(session) -> throw
    if (spec.owner !== undefined) {
      const owner = liveAgents.get(spec.owner)
      if (owner === undefined) {
        throw new Error(`session "${spec.owner}" has no live agent (background job owner must be live)`)
      }
    }
    started.push(spec)
    const hooks = spec.run(jobHandle) // the real registry invokes the producer
    if (hooks === undefined || typeof hooks.cancel !== 'function') throw new Error('producer did not return JobHooks')
    return 'ssh-1'
  },
  kill(id, caller) {
    if (caller !== undefined && !liveAgents.has(caller)) {
      throw new Error(`job ${id} is not visible to session "${caller}"`)
    }
    return 'requested'
  },
}

/** Read one module-level numeric constant straight out of the plugin source. */
function constValue(src, name) {
  const m = new RegExp(`^const ${name} = (.+)$`, 'm').exec(src)
  return m === null ? 0 : eval(m[1]) // eslint-disable-line no-eval
}

function loadTool() {
  const expr = extractToolDefinition(source, 'ssh_bash')
  const missing = []
  const stub = (name) => (...args) => {
    missing.push(name)
    throw new Error(`stub ${name} was called unexpectedly`)
  }
  const factory = new Function(
    'ctx', 'requireAgentId', 'parsePositiveInt', 'ensureAlive', 'remoteExec',
    'transcriptForExec', 'writeTranscript', 'transcriptNote', 'panelJobs', 'trimPanelJobs',
    'startRemoteBackgroundJob', 'renderExecResult', 'NULLABLE',
    'MAX_EXEC_TIMEOUT_MS', 'DEFAULT_EXEC_TIMEOUT_MS',
    `return ${expr}`,
  )
  let captured = null
  const ctx = {
    get: (key) => (key === 'jobs' ? jobs : undefined),
    tools: { register: (def) => { captured = def; return () => {} } },
  }
  const panelJobs = new Map()
  const definition = factory(
    ctx,
    (exec) => {
      const id = exec?.agent?.id
      if (typeof id !== 'string' || id.length === 0) throw new Error('SSH: no agent identity on this tool call; cannot key the connection.')
      return id
    },
    (value, fallback) => (value === undefined || value === null ? fallback : Math.floor(Number(value))),
    async () => {},                       // ensureAlive
    stub('remoteExec'),
    () => null,                           // transcriptForExec: no transcript in this test
    () => {},                             // writeTranscript
    (text) => text,                       // transcriptNote
    panelJobs,
    () => {},                             // trimPanelJobs
    (agentId, command, transcript, meta, handle) => {
      producerHandle = handle
      return { done: Promise.resolve({ status: 'running' }), cancel: () => {}, readOutput: () => '' }
    },
    () => '',                             // renderExecResult
    (type) => ({ oneOf: [{ type: 'null' }, { type }] }),
    constValue(source, 'MAX_EXEC_TIMEOUT_MS'),
    constValue(source, 'DEFAULT_EXEC_TIMEOUT_MS'),
  )
  if (captured === null) throw new Error('tool definition was not registered')
  return { definition: captured, panelJobs }
}

const { definition, panelJobs } = loadTool()
const results = []

/* A: run_in_background must register with a live session-id owner */
{
  const exec = {
    agent: { id: 'session-live' },
    callId: 'call_1',
    rootCallId: 'call_1',
    signal: new AbortController().signal,
  }
  let r
  try {
    r = await definition.execute(
      { command: 'sleep 30', description: 'background job ownership test', run_in_background: true },
      exec,
    )
    results.push({ name: 'run_in_background starts a job', pass: r?.kind === 'background' && r?.jobId === 'ssh-1', detail: `got ${JSON.stringify(r)}` })
  } catch (error) {
    results.push({ name: 'run_in_background starts a job', pass: false, detail: error.message })
  }
  const spec = started[0]
  results.push({
    name: 'owner is the session id (not the Agent object)',
    pass: spec !== undefined && typeof spec.owner === 'string' && spec.owner === 'session-live',
    detail: spec === undefined ? 'no spec was registered' : `owner=${typeof spec.owner} ${JSON.stringify(spec.owner)}`,
  })
  results.push({
    name: 'toolCall carries the invocation identity',
    pass: spec !== undefined && spec.toolCall?.callId === 'call_1' && spec.toolCall?.rootCallId === 'call_1',
    detail: spec === undefined ? 'no spec was registered' : `toolCall=${JSON.stringify(spec.toolCall)}`,
  })
  const meta = panelJobs.get('ssh-1')
  results.push({
    name: 'panel job meta keys on the session id',
    pass: meta !== undefined && meta.agentId === 'session-live',
    detail: meta === undefined ? 'panel meta missing' : `agentId=${meta.agentId}`,
  })
}

/* B: the registry's JobHandle must reach the producer, so the output ring that
 * `job_output` reads actually gets fed (the plugin's own readOutput() is not
 * part of the harness contract and nothing calls it). */
{
  results.push({
    name: 'producer receives the registry JobHandle',
    pass: producerHandle === jobHandle,
    detail: producerHandle === jobHandle ? 'run(handle) -> startRemoteBackgroundJob(..., handle)' : 'handle did not reach the producer',
  })
  const appendCount = source.match(/handle\.append\(text\)/g)?.length ?? 0
  results.push({
    name: 'producer appends output to the ring',
    pass: appendCount === 1 && /handle !== null && text\.length > 0/.test(source),
    detail: `handle.append(text) occurrences: ${appendCount}`,
  })
}

/* C: the panel's job-kill route must pass a SessionId caller too. Source-shape
 * check: the route needs the whole panel handler (fs, HTTP, session queries) to
 * run, which is out of scope here — the argument shape is what regressed. */
{
  const good = /jobs\.kill\(meta\.id, meta\.agentId, 'panel request'\)/.test(source)
  const bad = /jobs\.kill\(meta\.id, meta\.agent,/.test(source)
  results.push({
    name: 'panel job-kill passes a session-id caller',
    pass: good && !bad,
    detail: good && !bad ? 'jobs.kill(meta.id, meta.agentId, …)' : `source check failed (good=${good}, bad=${bad})`,
  })
}

for (const r of results) console.log(`${r.pass ? 'ok  ' : 'FAIL'} ${r.name}  — ${r.detail}`)
const failed = results.filter((r) => !r.pass)
console.log(failed.length === 0 ? '\nPASS' : `\n${failed.length} FAILED`)
process.exit(failed.length === 0 ? 0 : 1)
