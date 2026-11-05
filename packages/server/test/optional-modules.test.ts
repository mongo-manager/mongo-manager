// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  OPTIONAL_HOOK,
  createOptionalRuntime,
  detectDistribution,
  detectOptionalModules,
  moduleUnavailableMessage,
  verifiedHome,
  verifiedLoader,
  type ModuleLoader,
} from '../src/optional/modules'

const missing = (name: string) =>
  Object.assign(new Error(`Cannot find module '${name}'`), { code: 'MODULE_NOT_FOUND' })

/** W8: the optional packages, as present or absent as a test wants them (no native build here). */
function loader(present: Record<string, string | 'broken'>): ModuleLoader {
  return {
    resolve: vi.fn((name: string) => {
      if (!(name in present)) throw missing(name)
      return `/global/node_modules/${name}`
    }),
    load: vi.fn((name: string) => {
      if (present[name] === 'broken') throw new Error('mongocrypt.node: cannot open shared object file')
      return { loaded: name }
    }),
    version: (name: string) => (present[name] === 'broken' ? null : (present[name] ?? null)),
  }
}

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  delete (globalThis as Record<symbol, unknown>)[OPTIONAL_HOOK]
})
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), 'mm-optional-'))
  dirs.push(d)
  return d
}
/** A package as npm puts it: a folder with a package.json and an entry. */
function pkg(dir: string, name: string, marker = name): string {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '9.9.9', main: 'index.js' }))
  writeFileSync(join(dir, 'index.js'), `module.exports = { from: ${JSON.stringify(marker)} }`)
  return dir
}

describe('W8: which package this is', () => {
  it('tells the standalone binary, the Docker image, a copy, the npm package and a checkout apart', () => {
    const d = (env: Record<string, string>, isSea: boolean, bundled: boolean, verified = true) =>
      detectDistribution({ env, isSea, bundled, verified })
    expect(d({}, true, true)).toBe('standalone')
    expect(d({ MM_DISTRIBUTION: 'docker' }, false, true)).toBe('docker')
    expect(d({}, false, true)).toBe('npm')
    expect(d({}, false, false)).toBe('source')
    // Security review C2: the service's copy of the program is not where npm installed it.
    expect(d({}, false, true, false)).toBe('copy')
    // Only the image says docker: any other value is not trusted to switch the features off.
    expect(d({ MM_DISTRIBUTION: 'other' }, false, true)).toBe('npm')
  })
})

describe('W8 (security review C2): the packages load from one verified directory only', () => {
  // 2026-11-01: npm took the package as @mongo-manager/app, a folder deeper in node_modules.
  const NAME = '@mongo-manager/app'
  const home = (global: string) => join(global, '@mongo-manager', 'app')

  // Abuse case: C:\node_modules (any user may create it) above the service's copy of the program.
  it('finds no home for a copy of the program outside an npm install, whatever is planted above it', () => {
    const root = temp()
    pkg(join(root, 'node_modules', 'kerberos'), 'kerberos', 'planted')
    const dist = join(root, 'Mongo Manager', 'app', 'dist')
    mkdirSync(dist, { recursive: true })
    pkg(join(root, 'Mongo Manager', 'app'), NAME)
    expect(verifiedHome(dist)).toBeNull()
  })

  it('loads a package beside the global mongo-manager, never one planted further up', () => {
    const root = temp()
    // Planted in a parent of the global node_modules, or in the scope's own folder: never reached.
    pkg(join(root, 'node_modules', 'kerberos'), 'kerberos', 'planted')
    const global = join(root, 'prefix', 'node_modules')
    pkg(home(global), NAME)
    pkg(join(global, '@mongo-manager', 'kerberos'), 'kerberos', 'in the scope')
    mkdirSync(join(home(global), 'dist'))
    const found = verifiedHome(join(home(global), 'dist'))!
    expect(found).not.toBeNull()
    const l = verifiedLoader(found)
    expect(() => l.resolve('kerberos')).toThrow(/Cannot find module/)
    pkg(join(global, 'kerberos'), 'kerberos', 'installed')
    expect(l.load('kerberos')).toEqual({ from: 'installed' })
    expect(l.version('kerberos')).toBe('9.9.9')
  })

  it('refuses a home whose package is not mongo-manager', () => {
    const root = temp()
    const global = join(root, 'node_modules')
    pkg(home(global), 'something-else')
    mkdirSync(join(home(global), 'dist'))
    expect(verifiedHome(join(home(global), 'dist'))).toBeNull()
  })

  // Abuse case: the package's name in a folder npm would not give it (unscoped, or another scope).
  it('refuses the package anywhere but the folder npm installs it in', () => {
    const root = temp()
    const global = join(root, 'node_modules')
    for (const dir of [join(global, 'app'), join(global, 'mongo-manager'), join(global, '@other', 'app')]) {
      pkg(dir, NAME)
      mkdirSync(join(dir, 'dist'))
      expect(verifiedHome(join(dir, 'dist')), dir).toBeNull()
    }
  })

  it('refuses a package that links out of the verified directory', () => {
    const root = temp()
    const outside = pkg(join(root, 'elsewhere', 'kerberos'), 'kerberos', 'outside')
    const global = join(root, 'prefix', 'node_modules')
    pkg(home(global), NAME)
    mkdirSync(join(home(global), 'dist'))
    symlinkSync(outside, join(global, 'kerberos'), 'junction')
    const l = verifiedLoader(verifiedHome(join(home(global), 'dist'))!)
    expect(() => l.resolve('kerberos')).toThrow(/outside/)
  })
})

describe('W8: found at start, loaded only when a connection needs them', () => {
  it('reports them from where they would load, loading nothing at start', () => {
    const l = loader({ 'mongodb-client-encryption': '6.5.0', kerberos: '2.2.2' })
    const m = detectOptionalModules({ distribution: 'npm', loader: l })
    expect(m.clientEncryption).toEqual({ status: 'available', version: '6.5.0' })
    expect(m.kerberos).toEqual({ status: 'available', version: '2.2.2' })
    expect(l.load).not.toHaveBeenCalled()
  })

  it('reports a package that is not installed as missing', () => {
    const m = detectOptionalModules({ distribution: 'npm', loader: loader({ kerberos: '2.2.2' }) })
    expect(m.clientEncryption.status).toBe('missing')
    expect(m.kerberos.status).toBe('available')
  })

  it('loads a package the first time the driver asks for it, and says broken when it does not load', () => {
    const l = loader({ 'mongodb-client-encryption': 'broken', kerberos: '2.2.2' })
    const m = detectOptionalModules({ distribution: 'npm', loader: l })
    const runtime = createOptionalRuntime(m, l)
    expect(runtime.load('kerberos')).toEqual({ loaded: 'kerberos' })
    expect(runtime.load('kerberos')).toEqual({ loaded: 'kerberos' })
    expect(l.load).toHaveBeenCalledTimes(1)
    expect(runtime.load('mongodb-client-encryption')).toBeNull()
    expect(m.clientEncryption.status).toBe('broken')
    // A package that is not there is never asked for.
    const none = createOptionalRuntime(detectOptionalModules({ distribution: 'npm', loader: loader({}) }), l)
    expect(none.load('kerberos')).toBeNull()
  })

  it('never looks for them in the standalone binary, the Docker image or a copy', () => {
    for (const distribution of ['standalone', 'docker', 'copy'] as const) {
      const l = loader({ 'mongodb-client-encryption': '6.5.0', kerberos: '2.2.2' })
      const m = detectOptionalModules({ distribution, loader: l })
      expect(m.clientEncryption.status).toBe('not_in_package')
      expect(m.kerberos.status).toBe('not_in_package')
      expect(createOptionalRuntime(m, l).load('kerberos')).toBeNull()
      expect(l.load).not.toHaveBeenCalled()
      expect(l.resolve).not.toHaveBeenCalled()
    }
  })

  it('says what to do in plain words for each case', () => {
    const notIn = moduleUnavailableMessage('kerberos', { status: 'not_in_package', version: null })
    expect(notIn).toMatch(/not available in this package/)
    expect(notIn).toMatch(/npm package/)
    expect(notIn).toMatch(/kerberos/)
    const install = moduleUnavailableMessage('mongodb-client-encryption', {
      status: 'missing',
      version: null,
    })
    expect(install).toMatch(/npm i -g mongodb-client-encryption/)
    expect(moduleUnavailableMessage('kerberos', { status: 'broken', version: null })).toMatch(
      /could not be loaded/,
    )
  })
})
