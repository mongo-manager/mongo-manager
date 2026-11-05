// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { securityDirectory, stripAuthenticode } from '../scripts/pe.mjs'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

/** A PE32+ skeleton with a certificate table of `certSize` bytes at its end. */
function pe(certSize: number): Buffer {
  const body = 1024
  const buf = Buffer.alloc(body + certSize)
  buf.write('MZ', 0)
  buf.writeUInt32LE(0x80, 0x3c)
  buf.write('PE\0\0', 0x80, 'latin1')
  buf.writeUInt16LE(240, 0x80 + 4 + 16) // SizeOfOptionalHeader
  const opt = 0x80 + 24
  buf.writeUInt16LE(0x20b, opt)
  buf.writeUInt32LE(0xdeadbeef, opt + 64) // CheckSum
  buf.writeUInt32LE(16, opt + 108) // NumberOfRvaAndSizes
  if (certSize > 0) {
    buf.writeUInt32LE(body, opt + 112 + 4 * 8)
    buf.writeUInt32LE(certSize, opt + 112 + 4 * 8 + 4)
  }
  return buf
}

describe('removing the Authenticode signature before injecting the app (final review Minor 6)', () => {
  it('drops the certificate table and clears its directory entry and the checksum', () => {
    const signed = pe(512)
    expect(securityDirectory(signed)).toEqual({ offset: 1024, size: 512 })
    const stripped = stripAuthenticode(signed)
    expect(stripped.length).toBe(1024)
    expect(securityDirectory(stripped)).toEqual({ offset: 0, size: 0 })
    expect(stripped.readUInt32LE(0x80 + 24 + 64)).toBe(0)
  })

  it('leaves an unsigned file and non-PE files alone', () => {
    const unsigned = pe(0)
    expect(stripAuthenticode(unsigned)).toBe(unsigned)
    const elf = Buffer.from('\x7fELF'.padEnd(256, '\0'), 'latin1')
    expect(stripAuthenticode(elf)).toBe(elf)
  })

  it('refuses a certificate table that is not at the end of the file', () => {
    const odd = pe(512)
    odd.writeUInt32LE(900, 0x80 + 24 + 112 + 32)
    expect(() => stripAuthenticode(odd)).toThrow(/not at the end/)
  })

  it.runIf(process.platform === 'win32')('the stripped node.exe still runs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mm-pe-'))
    dirs.push(dir)
    const copy = join(dir, 'node.exe')
    copyFileSync(process.execPath, copy)
    const original = readFileSync(copy)
    expect(securityDirectory(original).size).toBeGreaterThan(0)
    writeFileSync(copy, stripAuthenticode(original))
    expect(spawnSync(copy, ['--version'], { encoding: 'utf8' }).stdout.trim()).toBe(process.version)
  })
})
