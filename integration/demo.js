/**
 * Native fleet demo workspace.
 *
 * The demo is deliberately small and deterministic: one module, one failing
 * test, one acceptance file. Its job is to make the role fleet observable —
 * Explorer must locate, Oracle must review, Fixer must edit, and the verifier
 * must run a command whose exit code is not an opinion.
 *
 * Nothing here calls a model. The caller seeds a directory and hands the prompt
 * to an OMC session; the models do the rest.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { basename, isAbsolute, join, resolve } from 'node:path'

export const DEMO_VERSION = 1
export const DEMO_ROOT_NAME = 'omc-demo'
export const DEMO_METADATA_NAME = '.omc-demo.json'

const INVENTORY = `// Demo fixture: totalValue skips the last line in this version.
export function totalValue(items) {
  let total = 0
  // BUG: the loop stops one item early.
  for (let index = 0; index < items.length - 1; index += 1) {
    total += items[index].quantity * items[index].unitPrice
  }
  return total
}

export function lowStock(items, threshold = 3) {
  return items
    .filter((item) => item.quantity <= threshold)
    .map((item) => item.sku)
}
`

const TEST = `import test from 'node:test'
import assert from 'node:assert/strict'
import { lowStock, totalValue } from './inventory.mjs'

const items = [
  { sku: 'A-1', quantity: 2, unitPrice: 100 },
  { sku: 'B-2', quantity: 1, unitPrice: 150 },
  { sku: 'C-3', quantity: 5, unitPrice: 65 },
]

test('totalValue counts every line', () => {
  assert.equal(totalValue(items), 675)
})

test('lowStock reports quantities at or below the threshold', () => {
  assert.deepEqual(lowStock(items, 3), ['A-1', 'B-2'])
})

test('an empty cart is worth zero', () => {
  assert.equal(totalValue([]), 0)
})
`

const TASK = `# Demo task: the last line is missing from the total

## Symptom

\`inventory.mjs\` exports \`totalValue(items)\`. With the fixture in
\`inventory.test.mjs\` it returns **350**, but the expected total is **675**
(200 + 150 + 325).

## Required behaviour

- \`totalValue\` must count every line, including the last one.
- \`totalValue([])\` must stay 0.
- \`lowStock\` must not change: it already returns \`['A-1', 'B-2']\`.
- Change only \`inventory.mjs\`; do not edit the tests to fit the bug.

## Acceptance

- \`npm test\` equivalent passes: all three tests in \`inventory.test.mjs\`.
- The diff is limited to \`inventory.mjs\`.
- The Explorer reports the exact line that causes the off-by-one.
- The Oracle reports a concrete fix and a risk check before the Fixer edits.
`

/** The per-run metadata written beside the fixture. */
export function demoMetadata({ at = new Date().toISOString(), node = 'node' } = {}) {
  return {
    demo: 'ohmycharness-native-fleet',
    version: DEMO_VERSION,
    at,
    node,
  }
}

/** A fresh, unique demo directory under the DSH home (or a supplied root). */
export function demoDirectory({ home, root, at = new Date(), suffix = '' } = {}) {
  const stamp = at.toISOString().replace(/[:.]/g, '-')
  const base = root ?? (home ? join(home, DEMO_ROOT_NAME) : join(process.cwd(), DEMO_ROOT_NAME))
  return join(base, 'run-' + stamp + (suffix ? '-' + suffix : ''))
}

/**
 * Resolve the executable that can run \`inventory.test.mjs\`.
 *
 * DSH Desktop does not put its bundled Node on PATH, so the demo records the
 * absolute executable it can prove exists. A plain Node host resolves to itself;
 * anything else falls back to the literal \`node\` and says so in RUN.md.
 */
export function resolveNodePath({ execPath = process.execPath, resourcesPath = process.resourcesPath } = {}) {
  if (/^node(\.exe)?$/i.test(basename(execPath ?? ''))) return execPath
  const candidates = []
  if (resourcesPath) {
    candidates.push(join(resourcesPath, 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin',
      process.platform === 'win32' ? 'node.exe' : 'node'))
    candidates.push(join(resourcesPath, 'runtime', 'bin', process.platform === 'win32' ? 'node.exe' : 'node'))
  }
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate
    } catch {
      // keep looking
    }
  }
  return 'node'
}

/**
 * The scenario prompt handed to an OMC session.
 * @param {{dir: string, node: string}} input
 */
export function demoPrompt({ dir, node }) {
  return [
    '你正在运行 Oh My CoHarness 的原生多模型演示。',
    '',
    '工作目录（所有读写必须限制在这里）：' + dir,
    '',
    '任务：',
    '1. 先调用 `subagent_explorer`，只读定位 `inventory.mjs` 中导致 totalValue 少算最后一项的具体代码行；要求它给出文件、行号和初始值/期望值。',
    '2. 把 Explorer 的结论交给 `subagent_oracle`，只读评审修复方案与回归风险；要求它给出最小修复和需要验证的边界。',
    '3. 把 Oracle 的方案交给 `subagent_fixer`，只修改 `inventory.mjs`，不要改测试。',
    '4. 主控自己运行：`"' + node + '" --test inventory.test.mjs`，记录完整输出和退出码。',
    '5. 把 diff 和测试结果再交给 `subagent_oracle` 复核（如果已有同一个 Oracle 子 Agent，用 `send_message` 继续；否则新调用一次）；若测试失败，交回 Fixer 修复，最多两轮。',
    '',
    '结束条件：三条测试全部通过，且改动只在 `inventory.mjs`。',
    '',
    '最终用中文输出 `DEMO-REPORT`，必须包含：',
    '- 每个角色实际使用的 provider/model（从角色工具返回、`/coharness status` 或设置卡读取；不要猜）；',
    '- Explorer 定位到的行、Oracle 的方案与复核结论、Fixer 的 diff；',
    '- 测试命令、退出码与关键输出；',
    '- 未完成项和不确定项（没有就写“无”）。',
  ].join('\n')
}

/** The files seeded into one demo directory. */
export function demoFiles({ node }) {
  return {
    'inventory.mjs': INVENTORY,
    'inventory.test.mjs': TEST,
    'TASK.md': TASK,
    'RUN.md': [
      '# Run the demo fixture',
      '',
      '```sh',
      '"' + node + '" --test inventory.test.mjs',
      '```',
      '',
      'Expected before the fix: the first test fails with `350 !== 675`.',
      'Expected after the fix: all three tests pass.',
      '',
      'The command is recorded with an absolute Node path because DSH Desktop does not',
      'guarantee that `node` is on PATH. If the path is `node`, use a shell where Node is available.',
      '',
    ].join('\n'),
    [DEMO_METADATA_NAME]: JSON.stringify(demoMetadata({ node }), null, 2) + '\n',
  }
}

/**
 * Seed one demo directory. Refuses to overwrite an existing directory.
 * @param {{dir: string, node?: string}} input
 * @returns {{dir: string, node: string, files: string[], prompt: string}}
 */
export function seedNativeDemo({ dir, node = resolveNodePath() } = {}) {
  if (typeof dir !== 'string' || dir.trim() === '') throw new TypeError('demo directory is required')
  const target = isAbsolute(dir) ? resolve(dir) : resolve(process.cwd(), dir)
  if (existsSync(target)) {
    throw Object.assign(new Error(`OMC/DEMO-EXISTS: ${target} already exists; choose a new directory`), {
      code: 'OMC/DEMO-EXISTS',
    })
  }
  mkdirSync(target, { recursive: true })
  const files = demoFiles({ node })
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(target, name), content, { encoding: 'utf8', flag: 'wx' })
  }
  return {
    dir: target,
    node,
    files: Object.keys(files).sort(),
    prompt: demoPrompt({ dir: target, node }),
  }
}
