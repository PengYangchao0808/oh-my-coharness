/**
 * WP07 — cache-affinity capability probe (0.5.0-alpha.2).
 *
 * Zero-model part (default): boots the real installed host with an isolated
 * .ops profile, registers a synthetic provider adapter, and verifies the
 * session-identity facts the affinity design depends on:
 *
 *   1. the same child keeps ONE sessionId across turns AND across a retry;
 *   2. a new child gets a distinct sessionId at the same boundary;
 *   3. the orchestrator and its child never share an identity;
 *   4. the built-in adapters send no per-session header today (static check),
 *      so affinity cannot be claimed for them without a host-side seam.
 *
 * Real-usage part (--real): NOT executed by default. It would dispatch real
 * requests through an actual provider to reconcile the returned cache buckets
 * and cost (A22); run it only with an explicit budget:
 *
 *   ELECTRON_RUN_AS_NODE=1 "DeepSeek Harness.exe" --expose-internals \
 *     scripts/cache-affinity-check.mjs --real --out docs/evidence/alpha.2/cache-affinity.json
 *
 * Same env contract as scripts/host-live-check.cjs (DSH_HOST_ANCHOR,
 * DSH_PROFILE_DIR under this checkout's .ops/).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { isAbsolute, join, resolve, dirname, basename } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const outPath = argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : null
const realMode = flag('--real')

const PROVIDER = 'omc-affinity-probe'
const MODEL = 'affinity-1'

let ctx
const facts = {
  adapterSessionIds: [],   // every stream() boundary observation
  requestWaterfalls: 0,
  requestErrors: 0,
}
const watchdog = setTimeout(() => { console.error('OMC_CACHE_AFFINITY_TIMEOUT'); process.exit(1) }, 60000)

function assert(ok, message) {
  if (!ok) throw new Error('probe assertion failed: ' + message)
}

try {
  const anchor = process.env.DSH_HOST_ANCHOR
  const profileDirRaw = process.env.DSH_PROFILE_DIR
  assert(anchor && isAbsolute(anchor), 'DSH_HOST_ANCHOR must be the installed absolute host entry')
  assert(profileDirRaw && isAbsolute(profileDirRaw), 'DSH_PROFILE_DIR must name an isolated test profile')
  const profileDir = resolve(profileDirRaw)
  assert(profileDir.startsWith(root + '\\.ops\\') || profileDir.startsWith(root + '/.ops/'), 'the probe only accepts a workspace .ops profile')
  process.argv[1] = anchor
  process.env.DSH_HOME = dirname(dirname(profileDir))
  const requireHost = createRequire(anchor)
  const hostImport = (name) => import(pathToFileURL(requireHost.resolve(name)).href)
  const hostBase = pathToFileURL(anchor).href

  const { boot, readProfilePatches } = await hostImport('@deepseek-ai/dsh-app-boot')
  const { provideCmdline } = await hostImport('@deepseek-ai/dsh-cmdline')
  const profileContext = { home: process.env.DSH_HOME, dir: profileDir, patchPath: join(profileDir, 'cordis.patch.yml'),
    installAnchor: anchor, name: basename(profileDir), startedBundles: [],
    bundles: JSON.parse(readFileSync(join(profileDir, 'package.json'))).dsh.profile.bundles, overlays: [] }
  const patches = readProfilePatches(profileContext.name, profileContext)
  const requirePackage = createRequire(join(root, 'package.json'))
  const anchorRows = (rows) => {
    for (const row of rows) {
      if (row.name?.startsWith('@deepseek-ai/')) row.name = pathToFileURL(requireHost.resolve(row.name)).href
      if (row.name?.startsWith('oh-my-coharness')) row.name = pathToFileURL(requirePackage.resolve(row.name)).href
      if (row.insert) anchorRows(row.insert)
      if (row.group && Array.isArray(row.config)) anchorRows(row.config)
      if (row.id === 'directory-picker' || row.id === 'hmr' || row.id === 'session-title-llm') row.disabled = true
      if (row.id === 'web-runtime') row.config = { ...row.config, printUrl: false }
    }
  }
  anchorRows(patches)
  ctx = await boot(profileContext.name, join(profileDir, 'cordis.yml'), patches, (rootCtx) => {
    rootCtx.provide('profileContext', profileContext)
    provideCmdline(rootCtx, { args: ['--host', '127.0.0.1', '--port', '0', '--no-open'], exit: (code) => { throw new Error('unexpected app exit ' + code) } })
    rootCtx.get('loader').config.bareModuleBaseUrl = hostBase
  }, pathToFileURL(join(profileDir, 'package.json')).href)
  const hostVersion = requireHost('@deepseek-ai/dsh/package.json').version

  // Static fact: do the built-in LLM adapters expose a per-session header seam?
  let builtinHeaderSeam = 'unknown'
  try {
    const asar = process.env.DSH_DESKTOP_ASAR
      ?? join(process.env.LocalAppData ?? '', 'Programs', 'DeepSeek Harness', 'resources', 'app.asar')
    if (existsSync(asar)) {
      const text = readFileSync(join(asar, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-llm', 'lib', 'index.js'), 'utf8')
      builtinHeaderSeam = /x-opencode-session|opencode-session/.test(text)
        ? 'present'
        : 'absent (only attribution headers; no per-session identity header)'
    }
  } catch {
    builtinHeaderSeam = 'unreadable'
  }

  // 1. Synthetic adapter: records sessionId per stream() call; first stream of
  //    agent A fails once so the retry identity is observable.
  const llm = ctx.get('llm')
  assert(llm, 'ctx.get("llm") is available')
  const { LlmAdapter, createUserMessage } = await hostImport('@deepseek-ai/dsh-llm')
  const callsPerSession = new Map()
  let firstSessionId = null
  class AffinityProbeAdapter extends LlmAdapter {
    providerInfo(provider) { return { id: provider, name: 'OMC affinity probe (synthetic)' } }
    async listModels(provider) { return [{ provider, id: MODEL, name: 'affinity probe model' }] }
    async resolveModel(provider, model) { return { provider, id: model, name: 'affinity probe model' } }
    async prepareCall(provider, model) {
      return { model: { provider, id: model, name: 'affinity probe model' }, stream: (options) => this.dispatch(options) }
    }
    async *dispatch(options) {
      const sessionId = options.sessionId ?? '(absent)'
      firstSessionId ??= sessionId
      const count = (callsPerSession.get(sessionId) ?? 0) + 1
      callsPerSession.set(sessionId, count)
      facts.adapterSessionIds.push({ sessionId, call: count })
      // Fail the FIRST dispatch of the FIRST agent once, so the retry path
      // and its session identity are observable. Keyed by session, not by
      // message text: the request's last message is a projection, not the
      // user's prompt.
      if (sessionId === firstSessionId && count === 1) {
        yield { type: 'finish', reason: { kind: 'error', failure: { message: 'affinity probe induced failure', code: 'OMC_AFFINITY_PROBE' } } }
        return
      }
      yield { type: 'text-delta', index: 0, text: 'affinity-ok' }
      yield { type: 'usage', usage: { inputTokens: 7, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  llm.registerAdapter([PROVIDER], new AffinityProbeAdapter())
  let retryGranted = false
  ctx.effect(() => ctx.on('agent/request', async (payload, next) => {
    facts.requestWaterfalls += 1
    return next()
  }, { global: true }), 'omc-affinity-probe: agent/request')
  ctx.effect(() => ctx.on('agent/request-error', async (payload, next) => {
    if (!retryGranted) { retryGranted = true; facts.requestErrors += 1; return { kind: 'retry' } }
    return next()
  }, { global: true }), 'omc-affinity-probe: agent/request-error')
  if (process.env.OMC_AFFINITY_DEBUG) {
    ctx.effect(() => ctx.on('session/event', (session, event) => {
      if (['turn/start', 'turn/end', 'request/header', 'assistant/message', 'assistant/attempt', 'agent/inbox/spliced'].includes(event.type)) {
        console.error('[affinity-dbg]', event.type, 'seq', event.seq, event.type === 'turn/end' ? JSON.stringify(event.data?.reason?.kind) : '')
      }
    }), 'omc-affinity-probe: debug events')
  }

  const agents = ctx.get('agents')
  const mk = async () => (await agents.create({
    sessionId: 'omc-affinity-' + randomUUID(),
    agentOptions: { provider: PROVIDER, model: MODEL },
    meta: { cwd: root },
    setup: async () => {},
  })).agent
  const prompt = (text) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })

  const childA = await mk()
  await childA.whenIdle()
  childA.followup(prompt('first turn'))          // fails once, retries, succeeds
  await childA.whenIdle()
  childA.followup(prompt('second-turn: reply ok')) // new turn, same session identity
  await childA.whenIdle()
  const childB = await mk()                       // a new child: distinct identity
  await childB.whenIdle()
  childB.followup(prompt('child B turn'))
  await childB.whenIdle()

  const a = facts.adapterSessionIds.filter((row) => row.sessionId === childA.session.id)
  const b = facts.adapterSessionIds.filter((row) => row.sessionId === childB.session.id)
  const verdicts = {
    sameChildStableAcrossTurnsAndRetries: {
      pass: a.length === 3 && a.every((row) => row.sessionId === childA.session.id),
      detail: `agent A produced ${a.length} stream dispatches (1 failed attempt + 1 retried + 1 second turn), all carrying one sessionId`,
    },
    newChildDistinctIdentity: {
      pass: b.length === 1 && b[0].sessionId === childB.session.id && childA.session.id !== childB.session.id,
      detail: `agent B carried a different sessionId (${b.length} dispatch)`,
    },
    retryKeepsIdentity: {
      pass: facts.requestErrors === 1 && a.length >= 2 && a[0].sessionId === a[1].sessionId,
      detail: 'the retried attempt re-entered the adapter with the same sessionId',
    },
    builtinAdapterHasNoSessionHeader: {
      pass: builtinHeaderSeam.startsWith('absent'),
      detail: `built-in dsh-llm header seam: ${builtinHeaderSeam}`,
    },
  }

  const matrix = {
    schemaVersion: 1,
    kind: 'cache-affinity-evidence',
    wp: 'WP07',
    targetVersion: '0.5.0-alpha.2',
    generatedAt: new Date().toISOString(),
    host: { version: hostVersion, source: 'booted installed host' },
    probe: { script: 'scripts/cache-affinity-check.mjs', modelCalls: 0 },
    identityVerdicts: verdicts,
    observedSessionIds: {
      childA: childA.session.id,
      childB: childB.session.id,
      dispatches: facts.adapterSessionIds,
      requestWaterfalls: facts.requestWaterfalls,
    },
    adapterDecision: {
      status: 'partial',
      seam: 'GenerateOptions.sessionId reaches every registered adapter\'s stream boundary; ctx.llm.registerAdapter allows a custom route',
      builtin: builtinHeaderSeam,
      decision: 'alpha.2 keeps provider-side affinity at the session-resume level (codex native sessions are the verified path); shipping an OMC session-affinity adapter would create a new billing/auth surface and is deferred until the host exposes a per-session header interface',
      boundary: 'no OMC adapter injects a per-session header in this release; do not list any protocol as cache-optimised',
    },
    realUsageReconciliation: realMode
      ? { status: 'not-implemented-in-probe', note: '--real was requested; the real-dispatch harness is part of WP09 benchmark tooling' }
      : { status: 'not-run', note: 'A22 needs real provider calls; run scripts/efficiency-benchmark.mjs (WP09) with an explicit budget, then record the returned cache buckets and cost here' },
  }

  if (outPath) {
    mkdirSync(dirname(resolve(outPath)), { recursive: true })
    writeFileSync(resolve(outPath), JSON.stringify(matrix, null, 2) + '\n', 'utf8')
  }
  console.log(JSON.stringify(matrix, null, 2))
  const failed = Object.entries(verdicts).filter(([, v]) => !v.pass).map(([k]) => k)
  console.error(`OMC_CACHE_AFFINITY_${failed.length ? 'FAILED:' + failed.join(',') : 'PASS'}`)
  process.exitCode = failed.length ? 1 : 0
} catch (error) {
  console.error('OMC_CACHE_AFFINITY_FAILED', error.stack)
  process.exitCode = 1
} finally {
  clearTimeout(watchdog)
  if (ctx) await ctx.fiber.dispose()
}
