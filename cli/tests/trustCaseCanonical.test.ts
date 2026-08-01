import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { normalizeBulbPath } from '../src/serve/paths.js'
import { setBulbTrusted, isBulbTrusted } from '../src/serve/trustStore.js'

// The trust key is security-bearing (trust membership). On a case-insensitive volume two casings of
// one bulb file must resolve to ONE key — otherwise an `untrust` typed in a different casing silently
// no-ops and the bulb stays Trusted (a fail-open). normalizeBulbPath canonicalizes case through the
// real filesystem so this holds on EVERY case-insensitive volume, not just win32 where a per-platform
// lowercase happened to mask it. Forcing platform='darwin' below is exactly the macOS path this guards.

function fsIsCaseInsensitive(dir: string): boolean {
  const probe = join(dir, 'CaseProbe.tmp')
  writeFileSync(probe, '')
  const insensitive = existsSync(join(dir, 'caseprobe.tmp'))
  rmSync(probe, { force: true })
  return insensitive
}

describe('trust keys are case-canonical on case-insensitive volumes', () => {
  let dir: string
  const realPlatform = process.platform

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tb-case-'))
    process.env.TYPEBULB_SERVERS_DIR = join(dir, 'servers')
  })

  afterEach(() => {
    delete process.env.TYPEBULB_SERVERS_DIR
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
    rmSync(dir, { recursive: true, force: true })
  })

  it('untrust in a different casing actually revokes (no fail-open) — simulating macOS', () => {
    // A case-sensitive volume genuinely has two distinct files, so the property does not apply; skip.
    // (True on a case-sensitive Linux runner; Windows/macOS CI exercise the real proof.)
    if (!fsIsCaseInsensitive(dir)) return
    // Force non-win32 so the win32 lowercase can't mask the gap — the realpath canonicalization is
    // then the only thing collapsing the two casings. Without the fix this test goes red here.
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })

    const real = join(dir, 'Vault.bulb.md')
    writeFileSync(real, '# bulb')
    const upper = join(dir, 'Vault.bulb.md')
    const lower = join(dir, 'vault.bulb.md') // same on-disk file, different casing

    expect(normalizeBulbPath(lower)).toBe(normalizeBulbPath(upper)) // one canonical key

    setBulbTrusted(upper, true)
    expect(isBulbTrusted(lower)).toBe(true)  // trust is found across casing
    setBulbTrusted(lower, false)             // untrust via the other casing
    expect(isBulbTrusted(upper)).toBe(false) // FAIL-OPEN if the key split: would still be true
  })

  it('still matches case on win32 for a path not yet on disk (the realpath ENOENT fallback)', () => {
    // A non-existent file can't be realpath'd, so the win32 lowercase fallback must still canonicalize.
    if (realPlatform !== 'win32') return
    const a = normalizeBulbPath(join(dir, 'Ghost.bulb.md')) // does not exist
    const b = normalizeBulbPath(join(dir, 'ghost.bulb.md'))
    expect(a).toBe(b)
  })
})

// The one loud write: `typebulb trust` exists to persist a decision, so an unwritable home is an
// error there — unlike the registry/port bookkeeping, which degrades stateless (TB-CLI.md).
describe('trust store on an unwritable home', () => {
  it('setBulbTrusted fails loudly instead of silently remembering nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tb-ro-'))
    try {
      const blocker = join(dir, 'blocker')
      writeFileSync(blocker, '')                       // a FILE where the home should be
      process.env.TYPEBULB_SERVERS_DIR = join(blocker, 'servers')
      expect(() => setBulbTrusted(join(dir, 'x.bulb.md'), true)).toThrow(/trust not remembered/)
    } finally {
      delete process.env.TYPEBULB_SERVERS_DIR
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
