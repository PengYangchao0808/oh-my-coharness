/**
 * WP00 — host efficiency-capability probe (0.5.0-alpha.2).
 *
 * Two modes, one matrix:
 *
 *   static (default, any Node >= 20, no model calls, no host boot):
 *     node scripts/efficiency-capability-check.mjs
 *   Reads the installed Desktop app.asar directly and verifies the contract
 *   markers the efficiency plan depends on (per-step usage, per-attempt request
 *   gate, message projections, settlement events, adapter session identity).
 *
 *   live (boot the real installed host; zero model cost via a fake adapter):
 *     ELECTRON_RUN_AS_NODE=1 "<DeepSeek Harness.exe>" --expose-internals \
 *       scripts/efficiency-capability-check.mjs --live
 *   Same env contract as scripts/host-live-check.cjs: DSH_HOST_ANCHOR must be
 *   the installed <app.asar>/dsh/lib/bin.js and DSH_PROFILE_DIR an isolated
 *   profile under this checkout's .ops/. Registers a provider "omc-probe"
 *   adapter whose stream() is fully synthetic, then drives two agents to
 *   verify waterfall timing, retry re-entry, usage settlement, pre-step
 *   rejection and per-session identity at the adapter boundary.
 *
 * Output: the capability matrix JSON on stdout; --out <path> also writes it.
 * Exit 0 only when every essential check of the selected mode passed.
 *
 * This is developer tooling, excluded from the published runtime package.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { isAbsolute, join, resolve, dirname, basename } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const option = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback)
const mode = flag('--live') ? 'live' : 'static'
const outPath = option('--out', null)

// ── asar reading (static evidence source) ───────────────────────────────────

function readAsarHeader(archive) {
  // Under ELECTRON_RUN_AS_NODE the archive is already a virtual filesystem:
  // opening the archive file itself fails, but in-archive paths read natively.
  try {
    const probe = readFileSync(`${archive}/dsh/package.json`, 'utf8')
    if (probe) {
      return {
        read(virtualPath) {
          try {
            return readFileSync(`${archive}/${virtualPath}`, 'utf8')
          } catch {
            return null
          }
        },
      }
    }
  } catch {
    // fall through to the manual header parse for plain Node
  }
  const buffer = readFileSync(archive)
  const jsonStart = 16
  const window = buffer.subarray(jsonStart, jsonStart + 8 * 1024 * 1024).toString('latin1')
  let depth = 0
  let inString = false
  let escaped = false
  let end = -1
  for (let i = 0; i < window.length; i += 1) {
    const ch = window[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) { end = i + 1; break }
    }
  }
  if (end < 0) throw new Error('cannot parse the asar header')
  const headerText = buffer.subarray(jsonStart, jsonStart + end).toString('utf8')
  const header = JSON.parse(headerText)
  const baseOffset = jsonStart + Buffer.byteLength(headerText)
  return {
    read(virtualPath) {
      let node = { files: header.files }
      for (const part of virtualPath.split('/')) {
        if (!node.files || !node.files[part]) return null
        node = node.files[part]
      }
      if (!node.offset || node.size === undefined) return null
      return buffer.subarray(baseOffset + Number(node.offset), baseOffset + Number(node.offset) + node.size).toString('utf8')
    },
  }
}

function defaultAsarPath() {
  if (process.env.DSH_DESKTOP_ASAR) return process.env.DSH_DESKTOP_ASAR
  const local = process.env.LocalAppData ?? join(process.env.USERPROFILE ?? '', 'AppData', 'Local')
  return join(local, 'Programs', 'DeepSeek Harness', 'resources', 'app.asar')
}

// One static contract check: a literal or regex marker inside one installed
// host file. `absent: true` inverts the assertion (for proving a seam does NOT
// exist, which is itself an efficiency-relevant host fact).
const STATIC_CHECKS = [
  {
    id: 'gate:pre-step-waterfall',
    capability: 'requestGate',
    file: 'dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js',
    pattern: /waterfall\("agent\/pre-step"/,
    note: 'agent/pre-step runs once per proposed step and a listener may return kind:"reject"',
  },
  {
    id: 'gate:request-per-attempt',
    capability: 'requestGate',
    file: 'dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js',
    pattern: /waterfall\("agent\/request"/,
    note: 'agent/request resolves the config inside prepareRequest, which the attempt loop re-runs on every retry',
  },
  {
    id: 'gate:retry-reenters-prepare',
    capability: 'requestGate',
    file: 'dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js',
    pattern: /action\?\.kind !== "retry"/,
    note: 'agent/request-error with kind:"retry" continues the attempt loop; the next attempt re-enters agent/request before llm.stream',
  },
  {
    id: 'usage:settled-per-step',
    capability: 'perStepUsage',
    file: 'dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js',
    pattern: /live\.usage === void 0 \? \{\} : \{ usage: live\.usage \}/,
    note: 'assistant/message settles the usage chunk per completed step; usage===undefined is omitted, never zero-filled',
  },
  {
    id: 'usage:failed-attempt-recorded',
    capability: 'perStepUsage',
    file: 'dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js',
    pattern: /"assistant\/attempt"/,
    note: 'failed/aborted attempts append assistant/attempt (attempt identity without usage) — coverage must stay partial for those',
  },
  {
    id: 'usage:attempt-id-format',
    capability: 'identity',
    file: 'dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js',
    pattern: /LlmAttemptId\(`\$\{sessionId\}:\$\{attempt\}`\)/,
    note: 'host attempt identity is sessionId:attempt — OMC attemptId must not renumber retries as new tasks',
  },
  {
    id: 'view:message-projection-registration',
    capability: 'resultTextView',
    file: 'dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js',
    pattern: /registerMessageProjection\(/,
    note: 'plugin-owned message projections re-derive model-visible messages without rewriting logged events',
  },
  {
    id: 'view:derive-messages',
    capability: 'historyViewTransform',
    file: 'dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js',
    pattern: /deriveMessages\(/,
    note: 'request boundaries derive messages from the event log, so projections are replayable',
  },
  {
    id: 'view:request-header-reasons',
    capability: 'perStepUsage',
    file: 'dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js',
    pattern: /reason: "change"/,
    note: 'request/header events carry initial|resume|change|series reasons plus the full config — route changes are attributable',
  },
  {
    id: 'settle:child-lifecycle-events',
    capability: 'subtaskSettlement',
    file: 'dsh/node_modules/@deepseek-ai/dsh-tool-subagent/lib/index.js',
    pattern: /ctx\.on\("agent\/created"/,
    note: 'tool-subagent observes agent/created + agent/disposed; settlement facts live in each session log (turn/end reason)',
  },
  {
    id: 'head:adapter-registration',
    capability: 'dynamicSessionHead',
    file: 'dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js',
    pattern: /registerAdapter\(providers, adapter\)/,
    note: 'custom provider adapters can be registered at runtime — the seam a session-affinity adapter could use',
  },
  {
    id: 'head:session-id-at-boundary',
    capability: 'dynamicSessionHead',
    file: 'dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js',
    pattern: /sessionId: this\.session\.id/,
    note: 'GenerateOptions carries the real session id to the adapter stream boundary',
  },
  {
    id: 'head:no-opencode-session-header',
    capability: 'dynamicSessionHead',
    file: 'dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js',
    pattern: /x-opencode-session|opencode-session/,
    absent: true,
    note: 'built-in adapters send no per-session identity header today; affinity work must not assume one exists',
  },
  {
    id: 'usage:chunk-shape',
    capability: 'perStepUsage',
    file: 'dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js',
    pattern: /case "usage":\s*\n\s*this\._usage = chunk\.usage/,
    note: 'usage arrives as a stream chunk; adapters without a usage chunk leave usage undefined (unknown, not zero)',
  },
]

function runStaticChecks() {
  const asarPath = option('--asar', defaultAsarPath())
  if (!isAbsolute(asarPath) || !existsSync(asarPath)) {
    throw new Error(`the installed Desktop archive was not found at "${asarPath}"; pass --asar <path> or set DSH_DESKTOP_ASAR`)
  }
  const asar = readAsarHeader(asarPath)
  const dshPkg = asar.read('dsh/package.json')
  if (!dshPkg) throw new Error('dsh/package.json missing from the archive')
  const hostVersion = JSON.parse(dshPkg).version
  const results = []
  for (const check of STATIC_CHECKS) {
    const text = asar.read(check.file)
    if (text === null) {
      results.push({ ...check, ok: false, line: null, matched: 'file missing from archive' })
      continue
    }
    const match = text.match(check.pattern)
    const found = Boolean(match)
    const ok = check.absent ? !found : found
    let line = null
    if (found) {
      const before = text.slice(0, match.index)
      line = (before.match(/\n/g) ?? []).length + 1
    }
    results.push({ ...check, ok, line, matched: check.absent ? 'pattern absent as required' : String(match[0]).slice(0, 120) })
  }
  return { asarPath, hostVersion, results }
}

// ── live probe (boot the installed host, synthetic adapter, zero model cost) ─

async function runLiveProbe() {
  const assert = (await import('node:assert/strict')).default
  const anchor = process.env.DSH_HOST_ANCHOR
  const configuredProfileDir = process.env.DSH_PROFILE_DIR
  assert.ok(anchor && isAbsolute(anchor), 'DSH_HOST_ANCHOR must be an installed absolute host entry (see scripts/host-live-check.cjs)')
  assert.ok(configuredProfileDir && isAbsolute(configuredProfileDir), 'DSH_PROFILE_DIR must name an isolated test profile')
  const profileDir = resolve(configuredProfileDir)
  assert.ok(profileDir.startsWith(root + '\\.ops\\' + '') || profileDir.startsWith(root + '/.ops/'), 'the probe only accepts a workspace .ops profile')
  process.argv[1] = anchor
  process.env.DSH_HOME = dirname(dirname(profileDir))
  const requireHost = createRequire(anchor)
  const hostImport = (name) => import(pathToFileURL(requireHost.resolve(name)).href)
  const hostBase = pathToFileURL(anchor).href

  const PROVIDER = 'omc-probe'
  const MODEL = 'probe-1'
  const SUCCESS_USAGE = Object.freeze({ inputTokens: 123, cacheReadTokens: 40, cacheWriteTokens: 0, outputTokens: 7 })

  const facts = {
    booted: false,
    hostVersion: null,
    requestWaterfalls: [],      // {agent, turn, step, provider, model, attemptIndexPerAgentTurn}
    requestErrors: [],          // {agent, turn, step, failure code, action}
    preSteps: [],               // {agent, turn, step, decision}
    adapterCalls: [],           // {sessionId, agentId, turnLabel — per stream() dispatch}
    sessionEvents: new Map(),   // sessionId -> [{seq, type, usage?, reason?}]
  }

  let ctx
  const watchdog = setTimeout(() => { console.error('OMC_CAPABILITY_LIVE_TIMEOUT'); process.exit(1) }, 60000)
  try {
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
    facts.booted = true
    facts.hostVersion = requireHost('@deepseek-ai/dsh/package.json').version

    // 1. Register the synthetic provider adapter. stream() is fully local.
    const llm = ctx.get('llm')
    assert.ok(llm, 'the booted host exposes ctx.get("llm")')
    const { LlmAdapter } = await hostImport('@deepseek-ai/dsh-llm')
    const { createUserMessage } = await hostImport('@deepseek-ai/dsh-llm')
    const callsPerSession = new Map()
    class ProbeAdapter extends LlmAdapter {
      providerInfo(provider) { return { id: provider, name: 'OMC capability probe (synthetic)' } }
      async listModels(provider) { return [{ provider, id: MODEL, name: 'OMC probe model' }] }
      async resolveModel(provider, model) { return { provider, id: model, name: 'OMC probe model' } }
      async prepareCall(provider, model) {
        return {
          model: { provider, id: model, name: 'OMC probe model' },
          stream: (options) => this.dispatch(options),
        }
      }
      async *dispatch(options) {
        const sessionId = options.sessionId ?? '(absent)'
        const count = (callsPerSession.get(sessionId) ?? 0) + 1
        callsPerSession.set(sessionId, count)
        facts.adapterCalls.push({ sessionId, call: count })
        if (count === 1 && !options.messages?.some((m) => String(m.content?.[0]?.text ?? '').includes('always-succeed'))) {
          yield { type: 'finish', reason: { kind: 'error', failure: { message: 'OMC probe induced failure', code: 'OMC_PROBE_INDUCED' } } }
          return
        }
        yield { type: 'text-delta', index: 0, text: 'OMC-PROBE-OK' }
        yield { type: 'usage', usage: { ...SUCCESS_USAGE } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    llm.registerAdapter([PROVIDER], new ProbeAdapter())

    // 2. Global waterfall taps (same registration style the OMC preset uses).
    let retryGranted = false
    let rejectNextTurnOf = null
    ctx.effect(() => ctx.on('agent/request', async (payload, next) => {
      facts.requestWaterfalls.push({ agent: payload.agent?.id, turn: payload.turn, step: payload.step,
        provider: undefined, model: undefined, at: facts.requestWaterfalls.length })
      return next()
    }, { global: true }), 'omc-capability-probe: agent/request')
    ctx.effect(() => ctx.on('agent/request-error', async (payload, next) => {
      let action = null
      if (!retryGranted) { retryGranted = true; action = { kind: 'retry' } }
      facts.requestErrors.push({ agent: payload.agent?.id, turn: payload.turn, step: payload.step,
        code: payload.failure?.code, action: action?.kind ?? 'default' })
      return action ?? next()
    }, { global: true }), 'omc-capability-probe: agent/request-error')
    ctx.effect(() => ctx.on('agent/pre-step', async (payload, next) => {
      if (rejectNextTurnOf && payload.agent?.id === rejectNextTurnOf && payload.turn === 2 && payload.step === 1) {
        rejectNextTurnOf = null
        facts.preSteps.push({ agent: payload.agent.id, turn: payload.turn, step: payload.step, decision: 'reject' })
        return { kind: 'reject' }
      }
      const decision = await next()
      facts.preSteps.push({ agent: payload.agent?.id, turn: payload.turn, step: payload.step, decision: decision?.kind })
      return decision
    }, { global: true }), 'omc-capability-probe: agent/pre-step')
    ctx.effect(() => ctx.on('session/event', (session, event) => {
      const list = facts.sessionEvents.get(session.id) ?? []
      list.push({ seq: event.seq, type: event.type,
        ...event.data?.usage ? { usage: event.data.usage } : {},
        ...event.type === 'turn/end' ? { reason: event.data?.reason?.kind } : {},
        ...event.type === 'request/header' ? { headerReason: event.data?.reason } : {} })
      facts.sessionEvents.set(session.id, list)
    }), 'omc-capability-probe: session/event')

    // 3. Drive agent A: turn 1 fails once then retries; turn 2 is rejected pre-step.
    const agents = ctx.get('agents')
    const mk = async (id) => (await agents.create({
      sessionId: id,
      agentOptions: { provider: PROVIDER, model: MODEL },
      meta: { cwd: root },
      setup: async () => {},
    })).agent
    const agentA = await mk('omc-capability-' + randomUUID())
    await agentA.whenIdle()
    agentA.followup(createUserMessage({ content: [{ type: 'text', text: 'probe turn 1' }], source: { kind: 'user' } }))
    await agentA.whenIdle()
    rejectNextTurnOf = agentA.id
    agentA.followup(createUserMessage({ content: [{ type: 'text', text: 'probe turn 2 (should be rejected)' }], source: { kind: 'user' } }))
    await agentA.whenIdle()

    // 4. Agent B: different session identity at the same adapter boundary.
    const agentB = await mk('omc-capability-' + randomUUID())
    await agentB.whenIdle()
    agentB.followup(createUserMessage({ content: [{ type: 'text', text: 'always-succeed probe B' }], source: { kind: 'user' } }))
    await agentB.whenIdle()

    // 5. Collect verdicts from durable facts.
    const eventsA = facts.sessionEvents.get(agentA.session.id) ?? []
    const eventsB = facts.sessionEvents.get(agentB.session.id) ?? []
    const attemptsA = eventsA.filter((e) => e.type === 'assistant/attempt')
    const messagesA = eventsA.filter((e) => e.type === 'assistant/message')
    const turnEndsA = eventsA.filter((e) => e.type === 'turn/end').map((e) => e.reason)
    const sessionARequestCalls = facts.adapterCalls.filter((c) => c.sessionId === agentA.session.id)
    const sessionBRequestCalls = facts.adapterCalls.filter((c) => c.sessionId === agentB.session.id)

    const verdicts = {
      requestGatePerAttempt: {
        pass: sessionARequestCalls.length === 2 && facts.requestErrors.length === 1,
        detail: `agent A produced ${sessionARequestCalls.length} adapter dispatch(es) and ${facts.requestErrors.length} request-error action(s); the retry re-entered the gate`,
      },
      preStepRejectionBlocksSend: {
        pass: turnEndsA[1] === 'blocked' && sessionARequestCalls.length === 2,
        detail: `turn 2 ended "${turnEndsA[1]}" with no third adapter dispatch`,
      },
      usageSettledOnAssistantMessage: {
        pass: messagesA.length === 1 && JSON.stringify(messagesA[0]?.usage) === JSON.stringify(SUCCESS_USAGE),
        detail: `assistant/message events: ${messagesA.length}, usage settled: ${JSON.stringify(messagesA[0]?.usage ?? null)}`,
      },
      failedAttemptRecordedWithoutUsage: {
        pass: attemptsA.length === 1 && !('usage' in attemptsA[0]),
        detail: `assistant/attempt events: ${attemptsA.length}, usage present: ${'usage' in (attemptsA[0] ?? {})}`,
      },
      settlementReasonsDurable: {
        pass: turnEndsA.length === 2 && turnEndsA[0] === 'completed' && turnEndsA[1] === 'blocked',
        detail: `agent A turn/end reasons: ${JSON.stringify(turnEndsA)}; agent B: ${JSON.stringify(eventsB.filter((e) => e.type === 'turn/end').map((e) => e.reason))}`,
      },
      sessionIdAtAdapterBoundary: {
        pass: sessionARequestCalls.length >= 2
          && sessionARequestCalls.every((c) => c.sessionId === agentA.session.id)
          && sessionBRequestCalls.length === 1
          && sessionBRequestCalls[0].sessionId === agentB.session.id
          && agentA.session.id !== agentB.session.id,
        detail: `adapter saw sessionId values; A stable across attempts, B distinct, A!==B`,
      },
    }
    return { facts: { ...facts, sessionEvents: Object.fromEntries(facts.sessionEvents) }, verdicts }
  } finally {
    clearTimeout(watchdog)
    if (ctx) await ctx.fiber.dispose()
  }
}

// ── matrix assembly ──────────────────────────────────────────────────────────

function capabilityEntry(status, evidence, boundary) {
  return { status, evidence, ...(boundary ? { boundary } : {}) }
}

function buildMatrix({ staticRun, liveRun }) {
  const byId = new Map((staticRun?.results ?? []).map((r) => [r.id, r]))
  const st = (id) => byId.get(id)
  const liveOk = (name) => (liveRun ? liveRun.verdicts[name]?.pass === true : null)
  const staticOk = (...ids) => ids.every((id) => st(id)?.ok === true)

  const native = {
    perStepUsage: capabilityEntry(
      staticOk('usage:settled-per-step', 'usage:failed-attempt-recorded', 'usage:chunk-shape', 'view:request-header-reasons') && liveOk('usageSettledOnAssistantMessage') !== false
        ? 'supported' : 'partial',
      [
        `agent-loop settles the usage chunk on each assistant/message; request/header (initial|resume|change|series) + message.source make the route attributable${st('usage:settled-per-step')?.line ? ` [line ${st('usage:settled-per-step').line}]` : ''}`,
        liveRun ? `live: ${liveRun.verdicts.usageSettledOnAssistantMessage.detail}` : 'live probe not run in this pass',
      ],
      'failed/aborted attempts log assistant/attempt without usage — those rows stay coverage:"partial", never zero-filled; built-in adapter inputTokens is the uncached bucket'),
    requestGate: capabilityEntry(
      staticOk('gate:pre-step-waterfall', 'gate:request-per-attempt', 'gate:retry-reenters-prepare') && liveOk('requestGatePerAttempt') !== false && liveOk('preStepRejectionBlocksSend') !== false
        ? 'supported' : 'partial',
      [
        'agent/request runs inside prepareRequest before llm.stream on every attempt; agent/request-error kind:"retry" re-enters it; agent/pre-step can reject a step before any send',
        liveRun ? `live: ${liveRun.verdicts.requestGatePerAttempt.detail}` : 'live probe not run in this pass',
      ],
      'the waterfall is per-agent; cross-agent atomic slot reservation is OMC-owned (its own lock), not a host guarantee'),
    resultTextView: capabilityEntry(
      staticOk('view:message-projection-registration') ? 'partial' : 'unsupported',
      ['dsh-session registerMessageProjection re-derives model-visible messages for plugin-owned events without rewriting logged events'],
      'core tool/result projection is owned by the host; OMC may only shape its own echo and artifact references this release'),
    historyViewTransform: capabilityEntry(
      staticOk('view:derive-messages') ? 'partial' : 'unsupported',
      ['session.deriveMessages() rebuilds the request boundary from the event log, so projections are replayable'],
      'kept experimental per plan §4.4: view reduction ships only after tool-call/result pairing and replay checks pass'),
    subtaskSettlement: capabilityEntry(
      staticOk('settle:child-lifecycle-events') && liveOk('settlementReasonsDurable') !== false ? 'supported' : 'partial',
      [
        'child agents are ordinary sessions: identity from the session header, settlement from durable turn/end reasons (completed|blocked|aborted|error|max-tokens)',
        liveRun ? `live: ${liveRun.verdicts.settlementReasonsDurable.detail}` : 'live probe not run in this pass',
      ],
      'OMC keeps "unknown" when no terminal event is reachable; the latest message never implies completion'),
    dynamicSessionHead: capabilityEntry(
      staticOk('head:adapter-registration', 'head:session-id-at-boundary') && liveOk('sessionIdAtAdapterBoundary') !== false ? 'partial' : 'partial',
      [
        `GenerateOptions carries the real sessionId to the adapter stream boundary${st('head:session-id-at-boundary')?.line ? ` [line ${st('head:session-id-at-boundary').line}]` : ''}; ctx.llm.registerAdapter allows a custom adapter; no built-in adapter sends a per-session header${st('head:no-opencode-session-header')?.ok ? ' (verified absent)' : ''}`,
        liveRun ? `live: ${liveRun.verdicts.sessionIdAtAdapterBoundary.detail}` : 'live probe not run in this pass',
      ],
      'seam exists and is verified; shipping a session-affinity adapter is WP07 work and must re-probe after host upgrades'),
  }

  const documented = (status, evidence, boundary) => capabilityEntry(status, evidence, boundary)
  const externalProvider = {
    perStepUsage: documented('partial',
      ['codex-jsonl turn.completed and claude-json result expose per-dispatch usage via src/session-adapters.js normalizeUsage; internal steps are not visible'],
      'per-dispatch only; missing numbers stay null — WP02 maps them to the four buckets without inventing values'),
    requestGate: documented('unsupported',
      ['no pre-send gate exists inside an external CLI process'],
      'OMC can gate between dispatches only; per-call maxCalls guarantees are refused for external lanes'),
    resultTextView: documented('partial',
      ['OMC owns the brief/handoff text it hands to the CLI and the echo it returns to the parent (integration/external-brief.js, integration/handoff.js)'],
      'CLI-internal context cannot be rewritten'),
    historyViewTransform: documented('unsupported', ['external CLI history is not host-replayable'], null),
    subtaskSettlement: documented('partial',
      ['integration/cli-result.js classifies exit-zero-but-unproved outcomes (truncated, semantic, empty, idChanged, unconfirmed) instead of trusting exit 0'],
      'mid-run settlement events are unavailable; settlement is per completed process'),
    dynamicSessionHead: documented('partial',
      ['codex native session resume is "verified" confidence in src/harnesses.js; the CLI keeps its own session files'],
      'no header control; other CLIs keep their documented/unverified confidence and must not be listed as cache-optimised'),
  }
  const direct = {
    perStepUsage: documented('unsupported',
      ['the direct surface is one spawned process; a usage summary exists only when the CLI prints one'],
      'usage unknown unless parseSessionOutput finds numbers'),
    requestGate: documented('partial',
      ['OMC spawns the process itself; the gate runs before spawn and retries re-enter it'],
      'one dispatch = one call attempt; no per-request control inside the run'),
    resultTextView: documented('partial', ['OMC owns its own echo of the captured output'], null),
    historyViewTransform: documented('unsupported', [], null),
    subtaskSettlement: documented('partial',
      ['same classifier as external lanes (integration/cli-result.js)'],
      'settlement is per completed process'),
    dynamicSessionHead: documented('partial',
      ['same CLI session resume mechanics as the external lane when the harness reports a session format'],
      null),
  }

  return {
    schemaVersion: 1,
    kind: 'efficiency-capability-matrix',
    wp: 'WP00',
    targetVersion: '0.5.0-alpha.2',
    generatedAt: new Date().toISOString(),
    probe: {
      script: 'scripts/efficiency-capability-check.mjs',
      modesRun: [staticRun ? 'static' : null, liveRun ? 'live' : null].filter(Boolean),
      modelCalls: 0,
    },
    host: staticRun
      ? { version: staticRun.hostVersion, asar: staticRun.asarPath, source: 'installed archive, read directly' }
      : (liveRun ? { version: liveRun.facts.hostVersion, source: 'booted host' } : null),
    capabilities: {
      perStepUsage: { native: native.perStepUsage, externalProvider: externalProvider.perStepUsage, direct: direct.perStepUsage },
      requestGate: { native: native.requestGate, externalProvider: externalProvider.requestGate, direct: direct.requestGate },
      resultTextView: { native: native.resultTextView, externalProvider: externalProvider.resultTextView, direct: direct.resultTextView },
      historyViewTransform: { native: native.historyViewTransform, externalProvider: externalProvider.historyViewTransform, direct: direct.historyViewTransform },
      subtaskSettlement: { native: native.subtaskSettlement, externalProvider: externalProvider.subtaskSettlement, direct: direct.subtaskSettlement },
      dynamicSessionHead: { native: native.dynamicSessionHead, externalProvider: externalProvider.dynamicSessionHead, direct: direct.dynamicSessionHead },
    },
    contractDecisions: {
      attemptId: 'native retries share the host attempt identity (sessionId:attempt, assistant/attempt events); an OMC retry or model switch after failure opens a new attempt under the same task, never a new task',
      acceptanceState: 'new field pending|passed|failed|unknown kept separate from execution status; only execution completed AND acceptance passed may be claimed as delivered',
      usageBuckets: 'four mutually exclusive buckets (uncachedInputTokens, cacheReadTokens, cacheWriteTokens, outputTokens) plus costUsd with its own source/price version; absent numbers are null, never 0',
      ledgerKey: 'idempotent by (source, session, event seq/id); restart replay must not double-count; child rollups are not re-booked as parent calls',
      cancelRequested: 'a cancellation request does not change execution status while the process still runs; cancelRequested is its own flag',
    },
    staticChecks: staticRun?.results.map(({ ok, id, note, line }) => ({ id, ok, line, note })) ?? null,
    liveProbe: liveRun
      ? { verdicts: liveRun.verdicts, facts: { adapterCalls: liveRun.facts.adapterCalls,
          requestErrors: liveRun.facts.requestErrors, preSteps: liveRun.facts.preSteps,
          sessionEventCounts: Object.fromEntries(Object.entries(liveRun.facts.sessionEvents).map(([k, v]) => [k, v.length])) } }
      : null,
  }
}

// ── entry ────────────────────────────────────────────────────────────────────

let staticRun = null
let liveRun = null
if (mode === 'live') {
  try {
    staticRun = runStaticChecks()
  } catch (error) {
    console.error(`static checks skipped in live run: ${error?.message ?? error}`)
  }
  liveRun = await runLiveProbe()
} else {
  staticRun = runStaticChecks()
}
const matrix = buildMatrix({ staticRun, liveRun })

const staticFailed = (staticRun?.results ?? []).filter((r) => !r.ok)
const liveFailed = liveRun ? Object.entries(liveRun.verdicts).filter(([, v]) => !v.pass).map(([k]) => k) : []
const ok = (staticRun ? staticFailed.length === 0 : true) && (liveRun ? liveFailed.length === 0 : true)

if (outPath) writeFileSync(resolve(outPath), JSON.stringify(matrix, null, 2) + '\n', 'utf8')
console.log(JSON.stringify(matrix, null, 2))
console.error(`OMC_CAPABILITY_${ok ? 'PASS' : 'FAILED'} mode=${mode}${staticFailed.length ? ` staticFailed=${staticFailed.map((r) => r.id).join(',')}` : ''}${liveFailed.length ? ` liveFailed=${liveFailed.join(',')}` : ''}${outPath ? ` out=${outPath}` : ''}`)
process.exit(ok ? 0 : 1)
