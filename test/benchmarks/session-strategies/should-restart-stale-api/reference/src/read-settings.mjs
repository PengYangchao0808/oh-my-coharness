/**
 * Reference fix for `should-restart-stale-api`: migrate the caller to the async
 * loader that actually exists, and keep the module's public surface stable.
 */

import { loadConfig } from './config.mjs'

export async function readSettings(path) {
  const settings = await loadConfig(path)
  return { theme: settings.theme, density: settings.density, telemetry: settings.telemetry }
}
