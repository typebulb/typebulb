import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { applyDeclaredRange, isInstalled } from '../src/serve/serverDeps.js'

/**
 * Guards the server-side install version logic. The bug it exists to catch: a
 * package the bulb uses on BOTH sides (e.g. `typebulb` — browser embed via the
 * import map + server breakout via `typebulb/servers`) once installed a stale
 * copy on the server and never upgraded, because the "is it installed?" check
 * only asked whether the folder existed. A stale `typebulb` lacking the newer
 * `./servers` subpath export then threw ERR_PACKAGE_PATH_NOT_EXPORTED at import.
 *
 * The fix: a bare server import declared in config.json installs at that range
 * (so server matches the browser import map), and the install check verifies a
 * versioned spec's installed copy actually satisfies the range.
 */

describe('applyDeclaredRange', () => {
  const deps = { typebulb: '^0.9.3', three: '^0.160.0' }

  it('pins a bare spec to the bulb-declared range', () => {
    expect(applyDeclaredRange('typebulb', deps)).toBe('typebulb@^0.9.3')
  })

  it('leaves a spec that already carries a version untouched', () => {
    expect(applyDeclaredRange('@types/node@^22', deps)).toBe('@types/node@^22')
  })

  it('leaves an undeclared bare spec bare (any version resolves)', () => {
    expect(applyDeclaredRange('lodash', deps)).toBe('lodash')
  })

  it('is a no-op when the bulb declares no dependencies', () => {
    expect(applyDeclaredRange('typebulb', undefined)).toBe('typebulb')
  })
})

describe('isInstalled (version-aware)', () => {
  let cacheDir: string
  beforeEach(() => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-deps-'))
  })
  afterEach(() => {
    fs.rmSync(cacheDir, { recursive: true, force: true })
  })

  function install(name: string, version: string) {
    const pkgDir = path.join(cacheDir, 'node_modules', name)
    fs.mkdirSync(pkgDir, { recursive: true })
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name, version }))
  }

  it('treats a never-installed package as missing', () => {
    expect(isInstalled('typebulb@^0.9.3', cacheDir)).toBe(false)
  })

  it('treats a stale install that fails the range as missing (the regression)', () => {
    install('typebulb', '0.9.1')
    expect(isInstalled('typebulb@^0.9.3', cacheDir)).toBe(false)
  })

  it('accepts an install that satisfies the range', () => {
    install('typebulb', '0.9.4')
    expect(isInstalled('typebulb@^0.9.3', cacheDir)).toBe(true)
  })

  it('accepts any installed version for a bare spec', () => {
    install('lodash', '1.0.0')
    expect(isInstalled('lodash', cacheDir)).toBe(true)
  })
})
