// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { assetNames } from '../src/updates/release'
import { tgz, type TarSpec } from './tarFixture'

export interface TestKey {
  pub: string
  privateKey: KeyObject
}

export function testKey(): TestKey {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return { pub: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'), privateKey }
}

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex')

export interface VersionOptions {
  /** The package's files under package/ (default: a cli.cjs and a package.json). */
  files?: Record<string, string>
  /** release.json's version, when it should name another. */
  infoVersion?: string
  /** The standalone target (default linux-x64). */
  target?: string
  node?: string
  minImage?: string
  minLauncher?: string
}

/**
 * A version folder as the updater stages it: SHA256SUMS signed by the key, release.json, and the
 * package (package.tgz kept, its files extracted under package/) or the standalone binary.
 */
export function makeVersionDir(
  appDir: string,
  version: string,
  kind: 'package' | 'standalone',
  key: TestKey,
  opts: VersionOptions = {},
): string {
  const dir = join(appDir, version)
  mkdirSync(dir, { recursive: true })
  const info = JSON.stringify({
    schema: 1,
    version: opts.infoVersion ?? version,
    node: opts.node ?? '20.0.0',
    minImage: opts.minImage ?? '1.0.0',
    ...(opts.minLauncher ? { minLauncher: opts.minLauncher } : {}),
  })
  const names = assetNames(version)
  const lines: string[] = []
  if (kind === 'package') {
    const files = opts.files ?? {
      'package.json': JSON.stringify({ name: '@mongo-manager/app', version }),
      'dist/cli.cjs': 'process.exit(0)\n',
    }
    const specs: TarSpec[] = Object.entries(files).map(([name, data]) => ({ name: `package/${name}`, data }))
    const archive = tgz(specs)
    writeFileSync(join(dir, 'package.tgz'), archive)
    for (const [name, data] of Object.entries(files)) {
      const at = join(dir, 'package', name)
      mkdirSync(dirname(at), { recursive: true })
      writeFileSync(at, data)
    }
    lines.push(`${sha(archive)}  ${names.tgz}`)
  } else {
    const name = names.standalone(opts.target ?? 'linux-x64')
    const binary = `binary ${version}`
    // As a download writes it (final review, C2): the install makes it runnable, not the fixture.
    writeFileSync(join(dir, name), binary, { mode: 0o600 })
    lines.push(`${sha(binary)}  ${name}`)
  }
  writeFileSync(join(dir, 'release.json'), info)
  lines.push(`${sha(info)}  release.json`)
  const sums = Buffer.from(`${lines.join('\n')}\n`)
  writeFileSync(join(dir, 'SHA256SUMS'), sums)
  writeFileSync(join(dir, 'SHA256SUMS.sig'), `${sign(null, sums, key.privateKey).toString('base64')}\n`)
  return dir
}
