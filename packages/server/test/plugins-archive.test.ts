// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { gzipSync } from 'node:zlib'
import { readPluginArchive } from '../src/plugins/archive'
import { helloPlugin, manifestOf, pax, tar, tgz } from './support/tar'

const files = (archive: Buffer) => readPluginArchive(archive).map((e) => e.path)
const refused = (archive: Buffer) => {
  try {
    readPluginArchive(archive)
  } catch (e) {
    return (e as Error).message
  }
  throw new Error('accepted')
}

describe('plugin archives (phase 4b §2)', () => {
  it('reads a plugin, with or without one top folder (npm pack puts it in package/)', () => {
    expect(files(helloPlugin()).sort()).toEqual(['app.js', 'index.html', 'mongo-manager-plugin.json'])
    const nested = tgz([
      { name: 'package/', type: '5' },
      { name: 'package/mongo-manager-plugin.json', data: manifestOf() },
      { name: 'package/index.html', data: 'x' },
      { name: 'package/assets/app.js', data: 'y' },
    ])
    expect(files(nested).sort()).toEqual(['assets/app.js', 'index.html', 'mongo-manager-plugin.json'])
    expect(
      readPluginArchive(nested)
        .find((e) => e.path === 'index.html')!
        .data.toString(),
    ).toBe('x')
  })

  it('takes long names from pax and GNU records, and a ustar prefix', () => {
    const deep = `${'d'.repeat(90)}/${'e'.repeat(90)}/app.js`
    const archive = tgz([
      { name: 'mongo-manager-plugin.json', data: manifestOf() },
      { name: 'index.html', data: 'x' },
      { name: 'PaxHeader', type: 'x', data: pax({ path: deep, mtime: '1' }) },
      { name: 'ignored-name', data: 'a' },
      { name: '././@LongLink', type: 'L', data: `${'f'.repeat(95)}.js\0` },
      { name: 'ignored-too', data: 'b' },
      { name: 'g.js', prefix: 'pre', data: 'c' },
      { name: 'global', type: 'g', data: pax({ comment: 'x' }) },
    ])
    expect(files(archive)).toEqual(expect.arrayContaining([deep, `${'f'.repeat(95)}.js`, 'pre/g.js']))
  })

  it('refuses paths that escape, are absolute or are not plain', () => {
    for (const name of [
      '../evil.js',
      'a/../../evil.js',
      '/etc/passwd',
      'C:/evil.js',
      'a\\..\\evil.js',
      '.hidden',
      'a/.git/config',
      'con.js',
      'a//b.js',
    ])
      expect(refused(helloPlugin({}, [{ name, data: 'x' }])), name).toMatch(/path/i)
    expect(
      refused(
        helloPlugin({}, [{ name: 'x', type: 'x', data: pax({ path: '../../evil.js' }) }, { name: 'y.js' }]),
      ),
    ).toMatch(/path/i)
  })

  it('refuses links, devices and anything but files and folders', () => {
    for (const type of ['1', '2', '3', '4', '6', 'K', 'S', 'V'])
      expect(refused(helloPlugin({}, [{ name: 'link.js', type, linkname: '/etc/passwd' }])), type).toMatch(
        /link|device|special|type/i,
      )
  })

  it('refuses too many files, too many bytes, and a compression bomb', () => {
    const many = Array.from({ length: 501 }, (_, i) => ({ name: `f${i}.js`, data: 'x' }))
    expect(refused(helloPlugin({}, many))).toMatch(/files/i)
    expect(refused(helloPlugin({}, [{ name: 'big.bin', data: Buffer.alloc(25 * 1024 * 1024 + 1) }]))).toMatch(
      /large|bytes|MB/i,
    )
    // 64 MB of zeros in a few KB: refused while it inflates, never held whole.
    const bomb = gzipSync(Buffer.alloc(64 * 1024 * 1024), { level: 9 })
    expect(refused(bomb)).toMatch(/large|MB/i)
  })

  it('refuses a damaged archive: a bad checksum, a size past the end, not gzip at all', () => {
    expect(
      refused(gzipSync(tar([{ name: 'mongo-manager-plugin.json', data: manifestOf(), badChecksum: true }]))),
    ).toMatch(/damaged|checksum/i)
    expect(refused(gzipSync(tar([{ name: 'a.js', data: 'x', size: 9999 }])))).toMatch(/damaged|end/i)
    expect(refused(Buffer.from('not an archive'))).toMatch(/gzip|archive/i)
  })

  it('refuses a path given twice, in any case, or both a file and a folder', () => {
    expect(refused(helloPlugin({}, [{ name: 'app.js', data: 'again' }]))).toMatch(/twice/i)
    expect(refused(helloPlugin({}, [{ name: 'APP.js', data: 'case' }]))).toMatch(/twice/i)
    expect(refused(helloPlugin({}, [{ name: 'app.js/x.js', data: 'under a file' }]))).toMatch(/twice|folder/i)
  })

  it('refuses an oversized pax or long-name record quickly, never parsing it for long', () => {
    const records = '6 a=b\n'.repeat(200_000)
    const started = Date.now()
    expect(
      refused(
        helloPlugin({}, [
          { name: 'PaxHeader', type: 'x', data: records },
          { name: 'x.js', data: 'x' },
        ]),
      ),
    ).toMatch(/record|header/i)
    expect(
      refused(
        helloPlugin({}, [{ name: '././@LongLink', type: 'L', data: 'a'.repeat(70_000) }, { name: 'y.js' }]),
      ),
    ).toMatch(/record|header/i)
    expect(Date.now() - started).toBeLessThan(2000)
    // Many small records in a header of fair size parse in time too.
    const fair = '6 a=b\n'.repeat(10_000)
    const t0 = Date.now()
    expect(
      files(
        helloPlugin({}, [
          { name: 'PaxHeader', type: 'x', data: fair },
          { name: 'z.js', data: 'z' },
        ]),
      ),
    ).toContain('z.js')
    expect(Date.now() - t0).toBeLessThan(1000)
  })

  it('refuses paths that name an object\u2019s own properties', () => {
    for (const name of ['__proto__', 'a/__proto__/b.js', 'constructor', 'prototype/x'])
      expect(refused(helloPlugin({}, [{ name, data: 'x' }])), name).toMatch(/path/i)
  })

  it('refuses an archive without a manifest at its top', () => {
    expect(refused(tgz([{ name: 'index.html', data: 'x' }]))).toMatch(/mongo-manager-plugin\.json/)
    expect(
      refused(
        tgz([
          { name: 'a/mongo-manager-plugin.json', data: manifestOf() },
          { name: 'b/index.html', data: 'x' },
        ]),
      ),
    ).toMatch(/mongo-manager-plugin\.json/)
  })
})
