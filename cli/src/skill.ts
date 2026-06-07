/**
 * `typebulb skill` — emit the bulb-authoring skill to stdout, so a cold agent bootstraps with no
 * ecosystem knowledge: "tell your agent to run `npx typebulb skill`" works against any agent that
 * understands the cross-agent Agent Skills format (Specs/Typebulb-CLI-Skill.md).
 *
 * The skill IS the package README, in full — one source of truth, no separate SKILL.md to drift. The
 * README carries no YAML frontmatter of its own (so it renders clean on npm/GitHub); the
 * `name`/`description` discovery metadata is the only thing wrapped on here, at emit time. This is
 * read-only: emitting a skill never writes it anywhere — the agent persists it only if asked
 * (Skill-spec "the CLI never installs the skill").
 */

import { readFileSync, existsSync } from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'

/** The `typebulb` package root, where npm ships the README and, alongside it, the skill's
 *  `description.md`. Found by walking up to the nearest `package.json` rather than assuming a fixed
 *  depth: the shipped bundle lives at `<root>/dist/index.js` but the source (under `cli/src/`) sits
 *  a folder deeper, and only the package root has a `package.json` to anchor on. */
function packageRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url))
  while (!existsSync(path.join(dir, 'package.json'))) {
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return dir
}

/** The skill's two on-disk pieces, resolved here so `skill` (which assembles them) and `agent`
 *  (which hands their paths to the agent) can't drift. The README *is* the skill body;
 *  `description.md` is the discovery blurb — both shipped so an agent can read either directly. */
export function bundledReadmePath(): string { return path.join(packageRoot(), 'README.md') }
export function bundledDescriptionPath(): string { return path.join(packageRoot(), 'description.md') }

/** Discovery metadata wrapped onto the README at emit time (the README itself carries none). The
 *  `description` is read from `description.md` — the single source the `agent` output also points
 *  at — and flattened to the one line YAML frontmatter wants; `version` stamps the typebulb release
 *  the skill was cut from, so a persisted copy is self-identifying and its staleness is checkable
 *  (see freshnessNote). */
export function skillFrontmatter(version: string): string {
  const description = readFileSync(bundledDescriptionPath(), 'utf8').trim().replace(/\s+/g, ' ')
  return `---
name: typebulb
description: ${description}
version: ${version}
---`
}

/** A one-line freshness self-check emitted just under the frontmatter. A persisted SKILL.md can't
 *  refresh itself, and the CLI can't refresh it either — the never-plant invariant means it never
 *  learns where the agent saved the copy, so it can't compare versions against it (Skill-spec). So
 *  the check lives in the artifact, actionable by the reader: if the installed CLI has moved on, the
 *  agent re-runs `skill`. (The live path — re-running `agent`/`skill` — is always fresh regardless.) */
export function freshnessNote(version: string): string {
  return `> Generated from typebulb v${version}. If \`npx typebulb --version\` reports a newer version, re-run \`npx typebulb skill\` to refresh this file.`
}

/** The full emittable skill: discovery frontmatter (with version stamp), the freshness self-check,
 *  a blank line, then the entire README. */
export function buildSkill(readme: string, version: string): string {
  return `${skillFrontmatter(version)}\n\n${freshnessNote(version)}\n\n${readme.trim()}\n`
}
