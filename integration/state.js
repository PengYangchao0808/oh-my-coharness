/**
 * OMC state layout.
 *
 * One DSH home may host several profiles, and one profile may be opened by more
 * than one DSH process. Every persistent OMC object therefore lives under a
 * profile-scoped directory:
 *
 *   $DSH_HOME/omc/profiles/<profile>/
 *     sessions.json
 *     tasks/<parent>/...
 *     graph/<parent>.json
 *     mailbox/<parent>.json
 *     locks/...
 *
 * The previous single-file `$DSH_HOME/oh-my-coharness-sessions.json` path stays
 * readable for migration, but new writes never go there.
 */

import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

export function dshHome(env = process.env) {
  const configured = env.DSH_HOME && String(env.DSH_HOME).trim() !== ''
    ? env.DSH_HOME
    : join(homedir(), '.dsh')
  return configured
}

/** Profile identity, stable across processes and safe as one path segment. */
export function profileId(env = process.env) {
  if (env.DSH_PROFILE && String(env.DSH_PROFILE).trim() !== '') return String(env.DSH_PROFILE).trim()
  if (env.DSH_PROFILE_DIR && String(env.DSH_PROFILE_DIR).trim() !== '') return basename(String(env.DSH_PROFILE_DIR).trim())
  return 'default'
}

export function safeSegment(value, fallback = '_') {
  const text = String(value ?? '').trim()
  const safe = text.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+$/, '_')
  return safe === '' ? fallback : safe.slice(0, 120)
}

/**
 * The profile-scoped state root.
 * @param {{env?: NodeJS.ProcessEnv, profile?: string, home?: string}} [options]
 */
export function stateRoot({ env = process.env, profile, home } = {}) {
  return join(home ?? dshHome(env), 'omc', 'profiles', safeSegment(profile ?? profileId(env), 'default'))
}

/** Resolve one path below the state root. */
export function statePath(...parts) {
  return join(stateRoot(), ...parts.map((part) => String(part)))
}

/** Create a directory below the state root and return it. */
export function ensureStateDir(...parts) {
  const dir = statePath(...parts)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

/** The pre-partition session registry, kept read-only for migration. */
export function legacySessionFile(env = process.env) {
  return join(dshHome(env), 'oh-my-coharness-sessions.json')
}

export function sessionFile(env = process.env) {
  return join(stateRoot({ env }), 'sessions.json')
}
