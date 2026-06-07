import * as fs from 'fs/promises'
import { buildSkill, bundledReadmePath } from '../skill.js'

/**
 * `typebulb skill` — print the bulb-authoring skill (the discovery frontmatter followed by the whole
 * README) to stdout and nothing else, so the output is a clean, valid, copy-able / redirectable
 * SKILL.md. Reads the README at the package root (npm always ships it there), so a published install
 * emits the shipped one and a repo run emits the live one. Emit-only; the CLI never installs a skill
 * (Skill-spec). `process.exitCode`-free: a plain successful print, exit 0.
 */
export async function runSkill(version: string): Promise<void> {
  const readmePath = bundledReadmePath()
  let readme: string
  try {
    readme = await fs.readFile(readmePath, 'utf8')
  } catch {
    console.error(`Could not read the bundled README (expected at ${readmePath}).`)
    process.exit(1)
  }
  process.stdout.write(buildSkill(readme, version))
}
