// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, describe, expect, it } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeEmbeddedPlugins } from '../src/plugins/embedded'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), 'mm-embedded-'))
  dirs.push(d)
  return d
}
const bytes = (s: string) => new Uint8Array(Buffer.from(s))
const FILES = new Map([
  ['charts/mongo-manager-plugin.json', bytes('{"id":"charts"}')],
  ['charts/index.html', bytes('<!doctype html>')],
  ['charts/assets/app.js', bytes('console.log(1)')],
])

// 2026-11-01: the standalone binary carried no plugins. It carries them now and writes them, at
// start, into its private data directory — never a folder beside the program, which anyone may make.
describe("the standalone binary's plugins", () => {
  it('are written into the data directory under the version, and that folder is returned', () => {
    const data = temp()
    const dir = writeEmbeddedPlugins(data, '1.0.0', FILES)
    expect(dir).toBe(join(data, 'bundled-plugins', '1.0.0'))
    expect(readFileSync(join(dir, 'charts', 'assets', 'app.js'), 'utf8')).toBe('console.log(1)')
  })

  it('are left as they are when they match, and written again when anything changed', () => {
    const data = temp()
    const dir = writeEmbeddedPlugins(data, '1.0.0', FILES)
    const before = statSync(join(dir, 'charts', 'index.html')).mtimeMs
    expect(writeEmbeddedPlugins(data, '1.0.0', FILES)).toBe(dir)
    expect(statSync(join(dir, 'charts', 'index.html')).mtimeMs).toBe(before)
    // Changed, missing, or one more file: the folder is written again from the binary.
    writeFileSync(join(dir, 'charts', 'index.html'), '<script>evil()</script>')
    writeFileSync(join(dir, 'charts', 'extra.js'), 'evil()')
    rmSync(join(dir, 'charts', 'assets', 'app.js'))
    writeEmbeddedPlugins(data, '1.0.0', FILES)
    expect(readFileSync(join(dir, 'charts', 'index.html'), 'utf8')).toBe('<!doctype html>')
    expect(existsSync(join(dir, 'charts', 'extra.js'))).toBe(false)
    expect(readFileSync(join(dir, 'charts', 'assets', 'app.js'), 'utf8')).toBe('console.log(1)')
  })

  // Abuse case: a link put in a plugin's place, to a file elsewhere.
  it('never keeps a link in the folder', () => {
    const data = temp()
    const dir = writeEmbeddedPlugins(data, '1.0.0', FILES)
    const outside = join(data, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'mongo-manager-plugin.json'), '{"id":"evil"}')
    rmSync(join(dir, 'charts'), { recursive: true })
    symlinkSync(outside, join(dir, 'charts'), process.platform === 'win32' ? 'junction' : 'dir')
    writeEmbeddedPlugins(data, '1.0.0', FILES)
    expect(readFileSync(join(dir, 'charts', 'mongo-manager-plugin.json'), 'utf8')).toBe('{"id":"charts"}')
    expect(readFileSync(join(outside, 'mongo-manager-plugin.json'), 'utf8')).toBe('{"id":"evil"}')
  })

  it("removes an earlier version's folder", () => {
    const data = temp()
    writeEmbeddedPlugins(data, '0.9.0', FILES)
    writeEmbeddedPlugins(data, '1.0.0', FILES)
    expect(readdirSync(join(data, 'bundled-plugins'))).toEqual(['1.0.0'])
  })

  // Abuse case: a name that would leave the folder.
  it('refuses a path or a version that would leave the folder', () => {
    const data = temp()
    for (const bad of ['../x.js', 'charts/../../x.js', '/abs.js', 'charts\\x.js', '', 'charts//x.js'])
      expect(() => writeEmbeddedPlugins(data, '1.0.0', new Map([[bad, bytes('x')]])), bad).toThrow(/plugin/)
    expect(() => writeEmbeddedPlugins(data, '../1.0.0', FILES)).toThrow(/version/)
  })
})
