import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'
import { buildSkill, skillFrontmatter, freshnessNote } from '../src/skill.js'

/**
 * The skill is the entire package README with the discovery frontmatter wrapped on at emit time
 * (TB-Skill.md). There is no body split — the human-facing intro, the usage list, and the
 * bulb-format example are all part of the emitted skill.
 */

// The README lives at the package root (runtime/), two levels up from cli/tests/.
const readmePath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'README.md')

describe('buildSkill', () => {
  it('prepends the versioned frontmatter and the freshness note, then the README, ending in a newline', () => {
    const out = buildSkill(readFileSync(readmePath, 'utf8'), '1.2.3')
    expect(out.startsWith(skillFrontmatter('1.2.3') + '\n\n' + freshnessNote('1.2.3') + '\n\n')).toBe(true)
    expect(out).toContain('name: typebulb')
    expect(out.endsWith('\n')).toBe(true)
  })

  it('stamps the version in the frontmatter and the self-check line', () => {
    const out = buildSkill('# x', '9.9.9')
    expect(out).toContain('version: 9.9.9')
    expect(out).toContain('Generated from typebulb v9.9.9')
    expect(out).toContain('`npx typebulb skill`')   // the refresh instruction the stamp makes actionable
  })

  it('emits the whole README — top half and bottom half', () => {
    const out = buildSkill(readFileSync(readmePath, 'utf8'), '1.2.3')
    // Top half (the old below-the-divider split used to drop these):
    expect(out).toContain('## Features')
    expect(out).toContain('## Usage')
    // Bottom half (the authoring skill proper):
    expect(out).toContain('## Bulb Format')
    expect(out).toContain('## Agent Harness Support')
  })

  it('needs no `---` divider — a README without one emits verbatim after the frontmatter + note', () => {
    const md = '# Title\n\nintro\n\n## Body\ncontent'
    expect(buildSkill(md, '1.2.3')).toBe(`${skillFrontmatter('1.2.3')}\n\n${freshnessNote('1.2.3')}\n\n${md}\n`)
  })
})
