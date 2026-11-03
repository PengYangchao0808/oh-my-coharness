/**
 * One budget-gate contender, for the cross-process last-slot race (R02).
 *
 * Two copies of this script start at the same wall-clock instant and each try
 * to reserve one slot against the same parent. With maxCalls=1 exactly one may
 * win; the loser must be refused by the file, not by a process-local Map.
 *
 * Usage:
 *   node test/fixtures/budget-contender.mjs --dir <state/budget> --parent <id>
 *     --task <id> --request <modelRequestId> --max-calls 1 --start-at <epochMs>
 *     --out <result.json>
 *
 * The result is written as JSON to --out (stdout is not used: a confined
 * sandbox refuses to open pipes for a child).
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { createRequestGate } from '../../integration/request-gate.js'

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback
}

const dir = option('dir')
const parentId = option('parent', 'contended-parent')
const taskId = option('task', 'contended-task')
const modelRequestId = option('request', `req-${process.pid}`)
const maxCalls = Number(option('max-calls', '1'))
const startAt = Number(option('start-at', '0'))
const out = option('out')

function sleepUntil(target) {
  for (;;) {
    const remaining = target - Date.now()
    if (remaining <= 0) return
    // Synchronous sleep without spawning anything.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(10, remaining))
  }
}

sleepUntil(startAt)

const gate = createRequestGate({ dir })
let payload
try {
  const reserved = gate.reserve({
    parentId,
    taskId,
    modelRequestId,
    limits: { maxCalls },
    source: { kind: 'contender', pid: process.pid },
  })
  payload = { ok: true, pid: process.pid, modelRequestId, ...reserved }
} catch (error) {
  payload = { ok: false, pid: process.pid, modelRequestId, error: String(error?.message ?? error), code: error?.code ?? null }
}

if (out) {
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
}
process.exit(0)
