/**
 * The report cache must not serve a failed probe forever.
 *
 * A cold-start probe (WSL not ready, a spawn deadline, a permission error) is a
 * transient verdict. `reportNeedsRefresh` is the pure gate the Host uses to
 * decide whether a cached report is still worth serving, so these tests exercise
 * it through the exported helper only — never through `apply()` internals.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { REPORT_TTL_MS, reportNeedsRefresh } from '../../src/index.js'
import { detect } from '../../src/doctor.js'
import { resolveConfig } from '../../src/config.js'
import { connectionTable } from '../../src/connection.js'
import { harnessDef } from '../../src/harnesses.js'

/** A cached doctor report with one healthy row. */
function cleanReport() {
  return {
    at: '2026-11-02T08:00:00.000Z',
    rows: [{ id: 'codex', transport: 'native', via: 'path', auth: 'ok', source: 'path', verified: true }],
  }
}

/** A cached report whose codex/opencode probes failed at cold start. */
function failedReport() {
  return {
    at: '2026-11-02T08:00:00.000Z',
    rows: [
      { id: 'codex', transport: 'native', via: 'probe', auth: 'unknown', source: 'probe', probeFailed: true, detail: 'Wsl/E_DISTRO_UNAVAILABLE' },
      { id: 'opencode', transport: 'native', via: 'probe', auth: 'unknown', source: 'probe', probeFailed: true, detail: 'OMC/SPAWN-TIMEOUT' },
    ],
  }
}

test('the TTL is a named, sane constant', () => {
  assert.equal(typeof REPORT_TTL_MS, 'number')
  assert.ok(REPORT_TTL_MS > 0 && Number.isFinite(REPORT_TTL_MS), 'the TTL must be a finite positive duration')
  // The whole point is that a cold start recovers without a restart.
  assert.ok(REPORT_TTL_MS <= 60_000, 'the TTL must stay short enough to recover a cold start quickly')
})

test('a fresh report with failed probes is served as-is', () => {
  assert.equal(reportNeedsRefresh(failedReport(), 0), false)
  assert.equal(reportNeedsRefresh(failedReport(), REPORT_TTL_MS - 1), false)
})

test('an old report with failed probes is refreshed', () => {
  assert.equal(reportNeedsRefresh(failedReport(), REPORT_TTL_MS), true)
  assert.equal(reportNeedsRefresh(failedReport(), REPORT_TTL_MS * 4), true)
})

test('a clean report is never auto-refreshed, however old', () => {
  assert.equal(reportNeedsRefresh(cleanReport(), 0), false)
  assert.equal(reportNeedsRefresh(cleanReport(), REPORT_TTL_MS), false)
  assert.equal(reportNeedsRefresh(cleanReport(), 24 * 60 * 60 * 1000), false)
  // Freshness is irrelevant without a failed probe: the cache is the truth.
  assert.equal(reportNeedsRefresh(cleanReport(), Number.NaN), false)
})

test('auth unknown from the probe counts as unverifiable even without the flag', () => {
  const report = {
    at: '2026-11-02T08:00:00.000Z',
    rows: [{ id: 'codex', transport: 'native', via: 'probe', auth: 'unknown', source: 'probe' }],
  }
  assert.equal(reportNeedsRefresh(report, 0), false)
  assert.equal(reportNeedsRefresh(report, REPORT_TTL_MS + 1), true)

  // `unknown` from anywhere else (no probe ran, config-only row) is not a
  // failed probe: it is the honest baseline and must not trigger re-probes.
  const configOnly = {
    at: '2026-11-02T08:00:00.000Z',
    rows: [{ id: 'codex', transport: 'native', via: 'path', auth: 'unknown', source: 'path' }],
  }
  assert.equal(reportNeedsRefresh(configOnly, REPORT_TTL_MS * 10), false)
})

test('nothing cached is never "stale"', () => {
  assert.equal(reportNeedsRefresh(null, REPORT_TTL_MS * 10), false)
  assert.equal(reportNeedsRefresh(undefined, REPORT_TTL_MS * 10), false)
  assert.equal(reportNeedsRefresh({}, REPORT_TTL_MS * 10), false)
  assert.equal(reportNeedsRefresh({ rows: [] }, REPORT_TTL_MS * 10), false)
})

test('an unclocked age is treated as stale rather than trusted', () => {
  assert.equal(reportNeedsRefresh(failedReport(), Number.NaN), true)
  assert.equal(reportNeedsRefresh(failedReport(), undefined), true)
  assert.equal(reportNeedsRefresh(failedReport(), -1), false, 'a negative age (clock skew) is still fresh')
})

/** A context whose every spawn fails with `error`, like a cold-start WSL probe. */
function failingCtx(error) {
  return { get: () => undefined, subprocess: { spawn() { throw error } } }
}

/** Only codex, forced through WSL, so the probe path is deterministic. */
function wslCodexCfg() {
  return resolveConfig({
    surface: 'direct',
    harnesses: { codex: { transport: 'wsl', distro: 'Ubuntu' } },
  })
}

test('a cold-start probe failure produces an unverifiable row the cache will refresh', async () => {
  // Exactly the live bug: wsl.exe is not ready yet, so discovery throws before
  // it can answer. The row must not read as "this CLI is not installed".
  const error = Object.assign(new Error('Wsl/Service/E_NOT_READY'), { code: 'Wsl/Service/E_NOT_READY' })
  const report = await detect(failingCtx(error), wslCodexCfg())
  const row = report.rows.find((entry) => entry.id === 'codex')
  assert.equal(row.probeFailed, true)
  assert.equal(row.auth, 'unknown')
  assert.equal(row.source, 'probe')
  assert.equal(row.detail, 'OMC/CLI-MISSING', 'the transport code is kept as the detail')

  // The cache gate reacts to that row, and the connection model refuses to call
  // it installed-and-routable or missing.
  assert.equal(reportNeedsRefresh(report, 0), false)
  assert.equal(reportNeedsRefresh(report, REPORT_TTL_MS + 1), true)
  const table = connectionTable({
    harnesses: [harnessDef('codex')],
    cfg: resolveConfig({ surface: 'direct', harnesses: { codex: { enabled: true } } }),
    rows: report.rows,
  })
  assert.equal(table.codex.state, 'installed')
  assert.equal(table.codex.routable, false)
  assert.match(table.codex.reason, /probe failed \(OMC\/CLI-MISSING\)/)
})

test('a probe that completed and found nothing stays a clean missing verdict', async () => {
  // No launch/WSL/timeout evidence: the probe ran and the binary is absent.
  const report = await detect(failingCtx(new Error('not found')), wslCodexCfg())
  const row = report.rows.find((entry) => entry.id === 'codex')
  assert.equal(row.auth, 'missing')
  assert.equal(row.probeFailed, false)
  // Nothing failed to probe, so the report is never auto-refreshed.
  assert.equal(reportNeedsRefresh(report, REPORT_TTL_MS * 100), false)
  const table = connectionTable({
    harnesses: [harnessDef('codex')],
    cfg: resolveConfig({ surface: 'direct', harnesses: { codex: { enabled: true } } }),
    rows: report.rows,
  })
  assert.equal(table.codex.state, 'missing')
})
