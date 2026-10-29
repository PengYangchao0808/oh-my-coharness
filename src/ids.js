/**
 * Id minting for external runs.
 *
 * DSH's subagent README states that an external provider mints a fresh
 * `SubagentRun.id` inside the runtime's shared Session id namespace. The helper that
 * mints a real `SessionId` was NOT verified against this installation (PLAN §B1), so
 * this module keeps one seam to replace: a UUID string is unique in that namespace
 * and is accepted as an opaque id by the catalog.
 */

import { randomUUID } from 'node:crypto'

/** @returns {string} a fresh id for one external execution */
export function mintRunId() {
  return `omc-${randomUUID()}`
}
