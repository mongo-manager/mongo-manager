// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { rolldown } from 'rolldown'
import { INSTALLABLE, missingModulesPlugin } from '../scripts/missing-module.mjs'
import { cleanTempDirs, tempDir } from './support'

afterEach(cleanTempDirs)

/** Builds `entry` with the plugin and runs it from `dir`, where a test may have planted packages. */
async function bundleAndRun(dir: string, entry: string, installable: boolean): Promise<unknown> {
  writeFileSync(join(dir, 'entry.cjs'), entry)
  const bundle = await rolldown({
    input: join(dir, 'entry.cjs'),
    platform: 'node',
    logLevel: 'silent',
    plugins: [missingModulesPlugin(installable ? { installable: true } : {})],
  })
  mkdirSync(join(dir, 'dist'), { recursive: true })
  await bundle.write({ file: join(dir, 'dist', 'cli.cjs'), format: 'cjs', codeSplitting: false })
  await bundle.close()
  const out = spawnSync(process.execPath, [join(dir, 'dist', 'cli.cjs')], { encoding: 'utf8' })
  return JSON.parse(out.stdout)
}

/** A package planted beside the bundle (or above it): never loaded by a search. */
function plant(dir: string, name: string): void {
  mkdirSync(join(dir, 'node_modules', name), { recursive: true })
  writeFileSync(
    join(dir, 'node_modules', name, 'package.json'),
    JSON.stringify({ name, version: '9.9.9', main: 'index.js' }),
  )
  writeFileSync(join(dir, 'node_modules', name, 'index.js'), `module.exports = { planted: true }`)
}

/** The server's loader, as installOptionalHook registers it: what it gives is what loads. */
const HOOK = (answer: string) =>
  `globalThis[Symbol.for('mongo-manager.optional-modules')] = (name) => (${answer})`

const LOAD = (name: string, before = '') =>
  `${before}
   const load = () => { try { const m = require(${JSON.stringify(name)}); return 'kModuleError' in m ? 'missing' : m.planted ? 'planted' : m.verified ? 'verified' : 'stub' } catch (e) { return e.code === 'MODULE_NOT_FOUND' ? 'missing' : 'error ' + e.message } }
   console.log(JSON.stringify([load(), load()]))`

describe('W8 (security review C2): kerberos and mongodb-client-encryption in the npm package', () => {
  it('are the two packages a user may install next to the CLI', () => {
    expect([...INSTALLABLE].sort()).toEqual(['kerberos', 'mongodb-client-encryption'])
  })

  it('come from the server’s verified loader, never from a search beside or above the bundle', async () => {
    const dir = tempDir()
    plant(dir, 'kerberos')
    plant(join(dir, 'dist'), 'kerberos')
    expect(await bundleAndRun(dir, LOAD('kerberos', HOOK('{ verified: true }')), true)).toEqual([
      'verified',
      'verified',
    ])
  })

  // Abuse case: a planted package where Node's search would find it, and no verified one.
  it('report themselves missing, every time, when the loader has none, whatever is planted', async () => {
    const dir = tempDir()
    plant(dir, 'kerberos')
    plant(join(dir, 'dist'), 'mongodb-client-encryption')
    expect(await bundleAndRun(dir, LOAD('kerberos', HOOK('null')), true)).toEqual(['missing', 'missing'])
    expect(await bundleAndRun(dir, LOAD('mongodb-client-encryption'), true)).toEqual(['missing', 'missing'])
  })

  // Only these two: other optional add-ons stay stubbed whatever is installed nearby.
  it('never let another optional add-on load from beside the bundle', async () => {
    const dir = tempDir()
    plant(dir, 'snappy')
    plant(dir, 'gcp-metadata')
    expect(await bundleAndRun(dir, LOAD('snappy', HOOK('{ verified: true }')), true)).toEqual([
      'missing',
      'missing',
    ])
    expect(await bundleAndRun(dir, LOAD('gcp-metadata'), true)).toEqual(['missing', 'missing'])
  })

  // The shell worker (and any build that does not ask) keeps them stubbed: it loads no add-on.
  it('stay stubbed in a build that does not ask for them', async () => {
    const dir = tempDir()
    plant(dir, 'kerberos')
    expect(await bundleAndRun(dir, LOAD('kerberos', HOOK('{ verified: true }')), false)).toEqual([
      'missing',
      'missing',
    ])
  })
})
