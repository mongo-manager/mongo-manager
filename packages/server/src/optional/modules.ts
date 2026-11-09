// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join, sep } from 'node:path'

/**
 * W8 (completion, owner's ruling 2026-10-16): CSFLE / Queryable Encryption and Kerberos ship in
 * the npm package only. Their native packages are installed by the user next to the global package
 * (`npm i -g @mongo-manager/app kerberos mongodb-client-encryption`).
 *
 * Security review C2: they load from one verified directory only — the global node_modules that
 * holds this very mongo-manager package, or the package's own node_modules — never by walking up
 * from the program (C:\node_modules, which any user can create, sits above the Windows service's
 * copy). The CLI bundle routes the driver's own require of them to this loader
 * (packages/cli/scripts/missing-module.mjs, OPTIONAL_HOOK), and they load only when a connection
 * first needs them. The standalone binary, the Docker image and the service's copy keep none.
 */
export type Distribution = 'npm' | 'standalone' | 'docker' | 'copy' | 'source'
export type OptionalModuleName = 'mongodb-client-encryption' | 'kerberos'
export type ModuleStatus = 'available' | 'missing' | 'broken' | 'not_in_package'
export interface ModuleInfo {
  status: ModuleStatus
  version: string | null
}
export interface OptionalModules {
  distribution: Distribution
  clientEncryption: ModuleInfo
  kerberos: ModuleInfo
}

export interface ModuleLoader {
  /** The package's folder; throws MODULE_NOT_FOUND when it is not installed where it may be. */
  resolve(name: OptionalModuleName): string
  /** Loads it (its native part too); throws when that fails. */
  load(name: OptionalModuleName): unknown
  version(name: OptionalModuleName): string | null
}

/** The bundle's stand-in asks this global for the packages (missing-module.mjs). */
export const OPTIONAL_HOOK = Symbol.for('mongo-manager.optional-modules')

/**
 * The Docker image sets MM_DISTRIBUTION=docker (Dockerfile); a standalone binary is a Node SEA; a
 * bundle outside an npm install is a copy (the service's). Any other value is ignored: it can only
 * ever switch the optional features off, never on.
 */
export function detectDistribution(opts: {
  env: Record<string, string | undefined>
  isSea: boolean
  bundled: boolean
  /** The bundle lies where npm installed it (verifiedHome). */
  verified: boolean
}): Distribution {
  if (opts.isSea) return 'standalone'
  if (opts.env.MM_DISTRIBUTION === 'docker') return 'docker'
  if (!opts.bundled) return 'source'
  return opts.verified ? 'npm' : 'copy'
}

export interface VerifiedHome {
  /** Where the packages may be: the package's own node_modules, then the global node_modules. */
  dirs: string[]
}

const real = (path: string): string | null => {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}
const inside = (child: string, parent: string) =>
  child.startsWith(parent.endsWith(sep) ? parent : parent + sep)

/** The npm package (2026-11-01: npm refused "mongo-manager" as too close to "mongomanager"). */
export const NPM_PACKAGE = '@mongo-manager/app'

/**
 * The directories of a bundle in `<global node_modules>/@mongo-manager/app/dist`, when it
 * is one: its package named so, and that folder the one the global node_modules holds under the name.
 */
export function verifiedHome(distDir: string): VerifiedHome | null {
  const packageDir = real(dirname(distDir))
  if (!packageDir) return null
  // The scope's folder sits between the package and node_modules.
  const globalDir = real(dirname(dirname(packageDir)))
  if (!globalDir || basename(globalDir) !== 'node_modules') return null
  let name: unknown
  try {
    name = (JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as { name?: unknown }).name
  } catch {
    return null
  }
  if (name !== NPM_PACKAGE || real(join(globalDir, ...NPM_PACKAGE.split('/'))) !== packageDir) return null
  return { dirs: [join(packageDir, 'node_modules'), globalDir] }
}

/** Packages from the verified directories only, each by its own folder (no module search). */
export function verifiedLoader(home: VerifiedHome): ModuleLoader {
  const resolve = (name: OptionalModuleName): string => {
    for (const dir of home.dirs) {
      const folder = join(dir, name)
      if (!existsSync(join(folder, 'package.json'))) continue
      const at = real(folder)
      const base = real(dir)
      if (!at || !base || !inside(at, base))
        throw Object.assign(new Error(`${name} links outside ${dir}: not loaded`), {
          code: 'MODULE_NOT_FOUND',
        })
      return at
    }
    throw Object.assign(new Error(`Cannot find module '${name}'`), { code: 'MODULE_NOT_FOUND' })
  }
  return {
    resolve,
    // An absolute folder: its package.json names the entry; nothing is searched for.
    load: (name) => {
      const folder = resolve(name)
      return createRequire(join(folder, 'package.json'))(folder)
    },
    version: (name) => {
      try {
        const v = (
          JSON.parse(readFileSync(join(resolve(name), 'package.json'), 'utf8')) as { version?: unknown }
        ).version
        return typeof v === 'string' ? v : null
      } catch {
        return null
      }
    },
  }
}

/** A source checkout (development): the packages its own node_modules may hold. */
export function sourceLoader(): ModuleLoader {
  const req = createRequire(join(import.meta.dirname, 'optional-modules.cjs'))
  return {
    resolve: (name) => dirname(req.resolve(`${name}/package.json`)),
    load: (name) => req(name),
    version: (name) => {
      try {
        return String((req(`${name}/package.json`) as { version?: unknown }).version ?? '') || null
      } catch {
        return null
      }
    },
  }
}

const KEYS = { 'mongodb-client-encryption': 'clientEncryption', kerberos: 'kerberos' } as const

/** What is installed where it may load from; nothing is loaded here. */
export function detectOptionalModules(opts: {
  distribution: Distribution
  loader: ModuleLoader | null
}): OptionalModules {
  const { distribution, loader } = opts
  if (distribution === 'standalone' || distribution === 'docker' || distribution === 'copy' || !loader) {
    const none: ModuleInfo = { status: 'not_in_package', version: null }
    return { distribution, clientEncryption: { ...none }, kerberos: { ...none } }
  }
  const find = (name: OptionalModuleName): ModuleInfo => {
    try {
      loader.resolve(name)
    } catch {
      return { status: 'missing', version: null }
    }
    return { status: 'available', version: loader.version(name) }
  }
  return { distribution, clientEncryption: find('mongodb-client-encryption'), kerberos: find('kerberos') }
}

/**
 * The packages, loaded the first time the driver asks for one (a connection needs it), once; a
 * package that does not load is said broken from then on. Null: not there, or broken.
 */
export function createOptionalRuntime(modules: OptionalModules, loader: ModuleLoader | null) {
  const loaded = new Map<OptionalModuleName, unknown>()
  return {
    load(name: OptionalModuleName): unknown {
      if (loaded.has(name)) return loaded.get(name)
      const info = modules[KEYS[name]]
      if (!loader || info.status !== 'available') return null
      try {
        const m = loader.load(name)
        loaded.set(name, m)
        return m
      } catch {
        info.status = 'broken'
        loaded.set(name, null)
        return null
      }
    },
  }
}

/** The bundle's stand-ins for kerberos and mongodb-client-encryption ask this runtime. */
export function installOptionalHook(runtime: ReturnType<typeof createOptionalRuntime>): void {
  ;(globalThis as Record<symbol, unknown>)[OPTIONAL_HOOK] = (name: OptionalModuleName) => runtime.load(name)
}

/** What to do about a package that is not there, in plain words (shown in the form and the docs). */
export function moduleUnavailableMessage(name: OptionalModuleName, info: ModuleInfo): string {
  const feature =
    name === 'kerberos' ? 'Kerberos (GSSAPI)' : 'Client-side field level and Queryable Encryption'
  switch (info.status) {
    case 'not_in_package':
      return `${feature} is not available in this package (the standalone binary, the Docker image or the service's own copy): use the npm package and install ${name} next to it (npm i -g @mongo-manager/app ${name})`
    case 'broken':
      return `${feature} needs ${name}, which is installed but could not be loaded (its native part is missing for this platform): reinstall it with npm i -g ${name}`
    case 'missing':
      return `${feature} needs the optional package ${name}: install it next to Mongo Manager (npm i -g ${name}) and restart`
    default:
      return `${feature} is available`
  }
}
