// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { generateKeyPairSync, sign } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import {
  HEALTH_WINDOW_MS,
  RELEASE_IMAGE,
  RELEASE_NPM_PACKAGE,
  RELEASE_PUBLIC_KEYS,
  RELEASE_REPO,
  RESTART_EXIT_CODE,
  ReleaseInfoSchema,
  STANDALONE_TARGETS,
  TarError,
  assetNames,
  compareReleaseVersions,
  parseSums,
  parseReleaseVersion,
  readTar,
  verifySums,
} from '../src/index'
import * as browser from '../src/browser'
import { pax, tgz } from './tarFixture'

const pair = () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return { pub: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'), privateKey }
}
const digest = 'a'.repeat(64)
const sums = Buffer.from(`${digest}  mongo-manager-1.1.0.tgz\n${'b'.repeat(64)} *release.json\n`)

describe('versions', () => {
  it('compares x.y.z numerically', () => {
    expect(compareReleaseVersions('1.10.0', '1.9.9')).toBe(1)
    expect(compareReleaseVersions('1.0.2', '1.0.2')).toBe(0)
    expect(compareReleaseVersions('1.0.2', '2.0.0')).toBe(-1)
  })

  it('accepts only plain x.y.z', () => {
    expect(parseReleaseVersion('1.0.2')).toEqual([1, 0, 2])
    // Final review (minor): one version, one name — no leading zeros.
    for (const bad of [
      '1.0.2-beta',
      'v1.0.2',
      '01.0.0x',
      '1.0',
      '1.0.0.0',
      ' 1.0.0',
      '1234567890.0.0',
      '',
      '01.2.3',
      '1.02.3',
      '1.2.03',
    ])
      expect(parseReleaseVersion(bad), bad).toBeNull()
  })

  it('throws on a version it cannot read', () => {
    expect(() => compareReleaseVersions('1.0', '1.0.0')).toThrow()
  })
})

describe('signed sums', () => {
  it('verifies a signature made by a listed key', () => {
    const { pub, privateKey } = pair()
    const sig = sign(null, sums, privateKey).toString('base64')
    expect(verifySums(sums, `${sig}\n`, [pub])).toBe(true)
  })

  it('refuses a changed byte, another key, garbage and an empty key list', () => {
    const { pub, privateKey } = pair()
    const other = pair()
    const sig = sign(null, sums, privateKey).toString('base64')
    const changed = Buffer.from(sums)
    changed[0] = 0x63
    expect(verifySums(changed, sig, [pub])).toBe(false)
    expect(verifySums(sums, sign(null, sums, other.privateKey).toString('base64'), [pub])).toBe(false)
    expect(verifySums(sums, 'garbage', [pub])).toBe(false)
    expect(verifySums(sums, sig, [])).toBe(false)
    expect(verifySums(sums, sig, ['not a key'])).toBe(false)
  })

  it('verifies with any one key of the list', () => {
    const { pub, privateKey } = pair()
    const sig = sign(null, sums, privateKey).toString('base64')
    expect(verifySums(sums, sig, ['not a key', pair().pub, pub])).toBe(true)
  })

  it('reads sha256sum lines, with and without the binary mark', () => {
    const map = parseSums(sums.toString())
    expect(map.get('mongo-manager-1.1.0.tgz')).toBe(digest)
    expect(map.get('release.json')).toBe('b'.repeat(64))
  })

  it('refuses names that are paths, duplicates and broken lines', () => {
    for (const name of ['../x', 'a/b', 'a\\b', '..', 'a\u0001b'])
      expect(() => parseSums(`${digest}  ${name}\n`), name).toThrow()
    expect(() => parseSums(`${digest}  x\n${digest}  x\n`)).toThrow()
    expect(() => parseSums(`zz  x\n`)).toThrow()
  })
})

describe('release info', () => {
  const info = { schema: 1, version: '1.1.0', node: '24.0.0', minImage: '1.1.0' }

  it('reads a release.json', () => {
    expect(ReleaseInfoSchema.parse(info)).toEqual(info)
  })

  // Final review (I7): every later release must still be read by this launcher — a key it adds is
  // ignored, never a refusal; a release that needs a newer launcher says so in minLauncher.
  it('ignores a key a later release adds, and reads minLauncher', () => {
    expect(ReleaseInfoSchema.parse({ ...info, extra: 1 })).toEqual(info)
    expect(ReleaseInfoSchema.parse({ ...info, minLauncher: '1.2.0' }).minLauncher).toBe('1.2.0')
    expect(ReleaseInfoSchema.safeParse({ ...info, minLauncher: '1.2' }).success).toBe(false)
  })

  it('refuses a version that is not x.y.z, and another schema', () => {
    expect(ReleaseInfoSchema.safeParse({ ...info, version: '1.1' }).success).toBe(false)
    expect(ReleaseInfoSchema.safeParse({ ...info, schema: 2 }).success).toBe(false)
  })

  it('names the assets as the release workflow does', () => {
    const names = assetNames('1.1.0')
    expect(names.tgz).toBe('mongo-manager-1.1.0.tgz')
    expect(names.standalone('linux-x64')).toBe('mongo-manager-1.1.0-linux-x64')
    expect(names.standalone('win-x64')).toBe('mongo-manager-1.1.0-win-x64.exe')
    expect(STANDALONE_TARGETS).toEqual(['linux-x64', 'linux-arm64', 'win-x64', 'macos-arm64'])
  })

  it('pins the restart code and the first-start window', () => {
    expect(RESTART_EXIT_CODE).toBe(75)
    expect(HEALTH_WINDOW_MS).toBe(60_000)
  })
})

describe('the release source (one file a fork changes)', () => {
  it('names the official repository, image and package', () => {
    expect(RELEASE_REPO).toBe('mongo-manager/mongo-manager')
    expect(RELEASE_IMAGE).toBe('ghcr.io/mongo-manager/mongo-manager')
    expect(RELEASE_NPM_PACKAGE).toBe('@mongo-manager/app')
    expect(Array.isArray(RELEASE_PUBLIC_KEYS)).toBe(true)
  })

  it('is offered to the browser, the verification code is not', () => {
    expect(browser).toHaveProperty('RELEASE_IMAGE')
    expect(browser).not.toHaveProperty('verifySums')
    expect(browser).not.toHaveProperty('readTar')
  })
})

describe('readTar', () => {
  const limits = { maxBytes: 1_000_000, maxFiles: 100 }
  const code = (archive: Buffer, l = limits) => {
    try {
      readTar(archive, l)
    } catch (e) {
      expect(e).toBeInstanceOf(TarError)
      return (e as TarError).code
    }
    throw new Error('accepted')
  }

  it('reads files with their modes; folders are implied', () => {
    const entries = readTar(
      tgz([
        { name: 'package/', type: '5' },
        { name: 'package/dist/cli.cjs', data: 'run()', mode: 0o755 },
        { name: './package/package.json', data: '{}' },
      ]),
      limits,
    )
    expect(entries.map((e) => [e.path, e.mode, e.data.toString()])).toEqual([
      ['package/dist/cli.cjs', 0o755, 'run()'],
      ['package/package.json', 0o644, '{}'],
    ])
  })

  it('takes a long name from a pax record', () => {
    const deep = `package/${'d'.repeat(120)}/x.js`
    const entries = readTar(
      tgz([
        { name: 'PaxHeader', type: 'x', data: pax({ path: deep }) },
        { name: 'short', data: 'y' },
      ]),
      limits,
    )
    expect(entries[0]!.path).toBe(deep)
  })

  it('refuses links, devices and a pax link', () => {
    expect(code(tgz([{ name: 'package/x', type: '2', linkname: '/etc/passwd' }]))).toBe('special')
    expect(code(tgz([{ name: 'package/x', type: '1', linkname: 'package/y' }]))).toBe('special')
    expect(code(tgz([{ name: 'package/x', type: '3' }]))).toBe('special')
    expect(code(tgz([{ name: 'p', type: 'x', data: pax({ linkpath: 'x' }) }, { name: 'a' }]))).toBe('special')
  })

  it('refuses paths that escape, are absolute or not plain', () => {
    for (const name of [
      '../evil',
      'package/../../evil',
      '/etc/passwd',
      'C:/x',
      'package\\x',
      'a//b',
      'a/./b',
      'a\u0007b',
    ])
      expect(code(tgz([{ name, data: 'x' }])), name).toBe('path')
  })

  it('keeps the raw paths when asked (the plugin reader checks its own)', () => {
    expect(readTar(tgz([{ name: '../evil', data: 'x' }]), { ...limits, paths: 'raw' })[0]!.path).toBe(
      '../evil',
    )
  })

  it('refuses a path given twice, in any case, or as a file and a folder', () => {
    expect(code(tgz([{ name: 'a/x' }, { name: 'a/x' }]))).toBe('duplicate')
    expect(code(tgz([{ name: 'a/X' }, { name: 'a/x' }]))).toBe('duplicate')
    expect(code(tgz([{ name: 'a' }, { name: 'a/x' }]))).toBe('duplicate')
  })

  it('stops a compression bomb at the limit', () => {
    expect(code(gzipSync(Buffer.alloc(1_000_000)), { maxBytes: 1000, maxFiles: 10 })).toBe('too_large')
  })

  it('counts bytes and files against the limits', () => {
    expect(code(tgz([{ name: 'a', data: 'x'.repeat(2000) }]), { maxBytes: 1000, maxFiles: 10 })).toBe(
      'too_large',
    )
    expect(code(tgz([{ name: 'a' }, { name: 'b' }, { name: 'c' }]), { maxBytes: 1000, maxFiles: 2 })).toBe(
      'too_many',
    )
  })

  it('refuses what is not gzip, and a damaged archive', () => {
    expect(code(Buffer.from('plain text'))).toBe('not_gzip')
    expect(code(tgz([{ name: 'a', data: 'x', badChecksum: true }]))).toBe('damaged')
    expect(code(tgz([{ name: 'a', data: 'x', size: 99999 }]))).toBe('damaged')
    expect(code(gzipSync(Buffer.alloc(100)))).toBe('damaged')
  })
})
