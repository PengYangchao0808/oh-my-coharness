/**
 * Bundled skills.
 *
 * Registering through `ctx.skills.register()` puts the bodies in the global layer and
 * makes them visible without a restart, without writing into `~/.dsh/skills`, and
 * without a preset entry (PLAN §3.6). A skill file that cannot be read is skipped:
 * a broken skill must never stop the plugin from loading.
 */

import { readFileSync } from 'node:fs'

/**
 * The bundle's skill set. `scripts/check.mjs` and `scripts/pack-check.mjs` read this
 * list instead of hard-coding directory names, so adding a skill is one edit here
 * plus one directory (V0.2-PLAN §4.3).
 */
export const SKILLS = [
  { dir: 'coharness', modelInvocable: true, userInvocable: true },
  { dir: 'coharness-setup', modelInvocable: true, userInvocable: true },
  { dir: 'coharness-council', modelInvocable: true, userInvocable: true },
  { dir: 'coharness-ulw', modelInvocable: true, userInvocable: true },
  { dir: 'coharness-verify', modelInvocable: true, userInvocable: true },
]

/** Minimal `---` frontmatter: flat `key: value` pairs, which is all we author. */
export function parseFrontmatter(raw) {
  const text = String(raw ?? '').replace(/^\uFEFF/, '')
  if (!text.startsWith('---')) return { data: {}, body: text.trim() }

  const end = text.indexOf('\n---', 3)
  if (end === -1) return { data: {}, body: text.trim() }

  const head = text.slice(3, end)
  const body = text.slice(end + 4).replace(/^\r?\n/, '')
  const data = {}

  for (const line of head.split(/\r?\n/)) {
    const match = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line.trim())
    if (!match) continue
    let value = match[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    data[match[1]] = value
  }

  return { data, body: body.trim() }
}

/**
 * @param {{ get(name: string): any }} ctx
 * @returns {Array<() => void>} disposers
 */
export function registerSkills(ctx) {
  const skills = ctx.get('skills')
  if (!skills?.register) return []

  const disposers = []
  for (const entry of SKILLS) {
    try {
      const url = new URL(`../skills/${entry.dir}/SKILL.md`, import.meta.url)
      const { data, body } = parseFrontmatter(readFileSync(url, 'utf8'))
      if (!data.name || !data.description) continue
      disposers.push(
        skills.register({
          name: data.name,
          description: data.description,
          whenToUse: data.whenToUse || undefined,
          content: body,
          source: 'runtime',
          invocation: { modelInvocable: entry.modelInvocable, userInvocable: entry.userInvocable },
        }),
      )
    } catch {
      // Missing or unreadable skill: keep the plugin alive.
    }
  }
  return disposers
}
