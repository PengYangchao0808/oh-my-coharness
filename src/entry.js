/**
 * Oh My CoHarness — the bundle's single Host row.
 *
 * The merged bundle keeps ONE profile row, so a pre-0.4 user override such as
 * `- id: oh-my-coharness` continues to target the same row. That row owns two
 * halves that used to be separate plugins:
 *
 *   1. the OMD companion: settings schema (including the OMC harness keys),
 *      profile RPC, legacy import and startup report;
 *   2. the OMC Host: `omc:<id>` subagent providers, the `coharness` tool,
 *      `/coharness` command and skills.
 *
 * They share one config document. The schema lives in the companion because
 * the settings form needs it; the provider code reads the same validated value
 * through the same row config.
 */

import * as companion from '../vendor/omd/npm-package/lib/index.js'
import * as host from './index.js'

export const name = 'oh-my-coharness'
export const inject = host.inject

// The settings form's schema and namespace (see lib/config-settings.js).
export const Config = companion.Config

/**
 * Mount both halves on one Cordis fiber.
 * @param ctx - the profile-plane row context.
 * @param config - the merged settings document (role config + harness config).
 */
export function apply(ctx, config) {
  companion.apply(ctx, config)
  return host.apply(ctx, config)
}

export { host }
