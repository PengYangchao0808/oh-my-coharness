/**
 * R05 regressions: the efficiency layer a user can actually edit.
 *
 * Two halves:
 *   - `mergeEfficiency` / `readUserEfficiency`: the settings card's stored layer
 *     wins over the deployment row config, but only the documented knobs and
 *     only when the stored value has the right type. A factory-default
 *     `efficiency` block must never overwrite an explicit row config.
 *   - the card itself: the budget controls and both dictionaries exist, because
 *     a schema field nobody can reach is not a setting.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { mergeEfficiency, readUserEfficiency } from '../../src/index.js'
import { resolveConfig } from '../../src/config.js'

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

test('R05: stored caps override the row config, and only the documented knobs', () => {
  const rowConfig = { efficiency: { mode: 'observe', budget: { maxCalls: 50, maxUsd: 5, perTaskCalls: 10, enforce: 'off' } } }
  const merged = mergeEfficiency(rowConfig, {
    mode: 'balanced',
    budget: { maxCalls: 3, maxUsd: 0.75, perTaskCalls: 2, enforce: 'on' },
    context: { maxToolTextChars: 4000 },
    bogus: { anything: true },
  })
  assert.equal(merged.efficiency.mode, 'balanced')
  assert.equal(merged.efficiency.budget.maxCalls, 3)
  assert.equal(merged.efficiency.budget.maxUsd, 0.75)
  assert.equal(merged.efficiency.budget.perTaskCalls, 2)
  assert.equal(merged.efficiency.budget.enforce, 'on')
  assert.equal(merged.efficiency.context.maxToolTextChars, 4000)
  assert.equal(merged.efficiency.bogus, undefined, 'an unsupported section is dropped')

  const resolved = resolveConfig(merged)
  assert.equal(resolved.efficiency.budget.maxCalls, 3)
  assert.equal(resolved.efficiency.budget.enforce, true, '"on" resolves to enforcing')
  assert.equal(resolved.efficiency.budget.perTaskCalls, 2)
})

test('R05: no stored layer leaves the row config untouched; a default block does not clobber it', () => {
  const rowConfig = { efficiency: { budget: { maxCalls: 7, enforce: true } } }
  assert.deepEqual(mergeEfficiency(rowConfig, null), rowConfig)
  assert.deepEqual(mergeEfficiency(rowConfig, {}), rowConfig)

  // The card stores 0 for "no cap"; resolveConfig keeps that as no cap.
  const cleared = resolveConfig(mergeEfficiency(rowConfig, { budget: { maxCalls: 0 } }))
  assert.equal(cleared.efficiency.budget.maxCalls, null)

  // Malformed values are dropped, never coerced into something that blocks.
  const malformed = mergeEfficiency(
    { efficiency: { mode: 'observe', budget: { maxCalls: 7 } } },
    { mode: 'yolo', budget: { maxCalls: -3, maxUsd: 'lots', perTaskCalls: 1.5 } },
  )
  assert.equal(malformed.efficiency.mode, 'observe', 'the row config mode survives')
  assert.equal(malformed.efficiency.budget.maxCalls, 7, 'a negative cap is ignored')
  assert.equal(malformed.efficiency.budget.maxUsd, undefined)
  assert.equal(malformed.efficiency.budget.perTaskCalls, undefined)
})

test('R05: only the USER settings layer is read, never the effective defaults', () => {
  const withUser = {
    get: (name) => (name === 'settings' ? {
      describe: () => [
        { ns: 'oh-my-coharness', value: { efficiency: { mode: 'observe', budget: { maxCalls: 0 } } }, user: { efficiency: { budget: { maxCalls: 12 } } } },
      ],
    } : undefined),
  }
  assert.deepEqual(readUserEfficiency(withUser), { budget: { maxCalls: 12 } })

  const noUserLayer = {
    get: () => ({ describe: () => [{ ns: 'oh-my-coharness', value: { efficiency: { mode: 'balanced' } } }] }),
  }
  assert.equal(readUserEfficiency(noUserLayer), null, 'a default-only row stores nothing')

  assert.equal(readUserEfficiency({ get: () => undefined }), null)
  assert.equal(readUserEfficiency({}), null)
  assert.equal(readUserEfficiency(undefined), null)
})

test('R05: the card exposes the budget controls with both dictionaries', () => {
  const source = readFileSync(join(root, 'vendor', 'omd', 'npm-package', 'client', 'client.js'), 'utf8')
  for (const key of ['budgetTitle', 'budgetMode', 'budgetMaxCalls', 'budgetMaxUsd', 'budgetPerTaskCalls', 'budgetEnforce']) {
    const occurrences = source.split(`${key}:`).length - 1
    assert.ok(occurrences >= 2, `${key} must exist in both dictionaries (found ${occurrences})`)
  }
  assert.match(source, /预算与效率/)
  assert.match(source, /Budget & efficiency/)
  assert.match(source, /onWrite\(\['efficiency', 'budget', 'maxCalls'\]/)
  assert.match(source, /onWrite\(\['efficiency', 'budget', 'enforce'\]/)
  assert.match(source, /onWrite\(\['efficiency', 'mode'\]/)
})
