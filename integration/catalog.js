/**
 * Live DSH model catalog reader.
 *
 * The catalog is the host's own answer to "which provider/model pairs can this
 * installation actually call?". OMC never invents a model list and never ships
 * a default that names a model the user does not have.
 */

import { normalizeCatalog } from './fleet.js'

/** Per-context cache: the catalog changes only when a provider is configured. */
const cache = new WeakMap()

/** Refresh at most this often unless the caller asks for a fresh read. */
export const CATALOG_TTL_MS = 15_000

/**
 * Provider routes the host has registered.
 * @param {any} ctx
 * @returns {Array<{id: string, name?: string}>}
 */
export function listProviderRoutes(ctx) {
  try {
    const providers = ctx.get?.('llm')?.listProviders?.() ?? []
    return providers
      .map((row) => ({ id: String(row?.id ?? '').trim(), name: typeof row?.name === 'string' ? row.name : undefined }))
      .filter((row) => row.id !== '')
  } catch {
    return []
  }
}

/**
 * Read every registered provider's model list. A provider whose adapter throws
 * is reported as an empty row, never as a fabricated model.
 *
 * @param {any} ctx
 * @param {{refresh?: boolean, now?: number}} [options]
 * @returns {Promise<Array<{provider: string, models: object[]}>>}
 */
export async function readProviderModels(ctx, { refresh = false, now = Date.now() } = {}) {
  const cached = cache.get(ctx)
  if (!refresh && cached && now - cached.at < CATALOG_TTL_MS) return cached.rows

  const rows = []
  for (const provider of listProviderRoutes(ctx)) {
    let models = []
    try {
      models = await ctx.get('llm').listModels(provider.id)
    } catch {
      models = []
    }
    rows.push({ provider: provider.id, name: provider.name, models: Array.isArray(models) ? models : [] })
  }
  cache.set(ctx, { at: now, rows })
  return rows
}

/**
 * The flattened, role-plannable catalog.
 * @param {any} ctx
 * @param {{refresh?: boolean, now?: number}} [options]
 */
export async function readModelCatalog(ctx, options = {}) {
  return normalizeCatalog(await readProviderModels(ctx, options))
}

/**
 * Index a catalog by `provider/model` for availability checks.
 * @param {Array<{provider: string, model: string, label?: string}>} catalog
 */
export function catalogIndex(catalog) {
  const map = new Map()
  for (const entry of Array.isArray(catalog) ? catalog : []) {
    map.set(entry.label ?? entry.provider + '/' + entry.model, entry)
  }
  return map
}
