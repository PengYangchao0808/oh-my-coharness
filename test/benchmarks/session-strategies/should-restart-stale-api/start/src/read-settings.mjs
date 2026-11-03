/**
 * The stale caller: it still imports the removed synchronous loader.
 * Importing this module throws, which is the signal that the context is stale.
 */

import { loadConfigSync } from './config.mjs'

export function readSettings(path) {
  const settings = loadConfigSync(path)
  return { theme: settings.theme, density: settings.density, telemetry: settings.telemetry }
}
