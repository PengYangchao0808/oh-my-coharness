/**
 * Task kind: should-restart.
 *
 * The repository replaced the synchronous settings loader with an async one.
 * `src/read-settings.mjs` in the start state still calls the removed synchronous
 * loader, so importing it throws. A worker that reuses stale context will keep
 * patching the caller to match the old API; the correct action is to restart
 * from the current module contract.
 */

import { readFile } from 'node:fs/promises'

const DEFAULTS = Object.freeze({ theme: 'light', density: 'comfortable', telemetry: false })

export async function loadConfig(path) {
  try {
    const text = await readFile(path, 'utf8')
    const parsed = JSON.parse(text)
    return { ...DEFAULTS, ...parsed }
  } catch {
    return { ...DEFAULTS }
  }
}

export { DEFAULTS }
