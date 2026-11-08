// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { text } from 'node:stream/consumers'
import { createFolderAdapter, resolveFolder } from '../src/backup/destinations/folder'
import { DestinationError } from '../src/backup/destinations/types'
import { remoteKeyFor } from '../src/backup/destinations/layout'

let base: string
let root: string
let dataDir: string
const signal = new AbortController().signal
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'mm-folder-'))
  root = join(base, 'root')
  dataDir = join(base, 'data')
  mkdirSync(root)
  mkdirSync(dataDir)
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

function localFile(content: string) {
  const path = join(base, `src-${Math.random()}.bin`)
  writeFileSync(path, content)
  const b = Buffer.from(content)
  return {
    path,
    size: b.length,
    sha256: createHash('sha256').update(b).digest('hex'),
    md5: createHash('md5').update(b).digest('hex'),
  }
}
const reason = (fn: () => unknown) => {
  try {
    fn()
    return 'none'
  } catch (e) {
    return e instanceof DestinationError ? e.reason : 'other'
  }
}
const io = { progress: () => undefined, saveResume: () => undefined }

describe('server folder destination (phase 3d-3b spec §2.2, D11)', () => {
  it('writes, reads, lists and removes inside its folder', async () => {
    const a = createFolderAdapter({ path: join(root, 'mm'), roots: [root], dataDir })
    const key = remoteKeyFor('', 'mmbak', '7c9e6679-7425-40de-944b-e07fc1f90ae7', Date.UTC(2026, 9, 3))
    const sent: number[] = []
    await a.put(
      key,
      localFile('hello backup'),
      null,
      { progress: (n) => sent.push(n), saveResume: () => undefined },
      signal,
    )
    expect(sent.at(-1)).toBe(12)
    expect(readFileSync(join(root, 'mm', ...key.split('/')), 'utf8')).toBe('hello backup')
    expect(existsSync(join(root, 'mm', ...key.split('/')) + '.partial')).toBe(false)
    expect(await a.stat(key, signal)).toMatchObject({ size: 12, archived: false })
    expect(await text(await a.get(key, 6, signal))).toBe('backup')
    await a.putSmall(`${key}.json`, Buffer.from('{}'), signal)
    expect((await a.getSmall(`${key}.json`, 1024, signal))!.toString()).toBe('{}')
    writeFileSync(join(root, 'mm', 'mongo-manager', '2026', '10', 'foreign.txt'), 'x')
    const page = await a.list(null, signal)
    expect(page.items.map((i) => i.key)).toEqual([key])
    await a.remove(key, signal)
    expect(await a.stat(key, signal)).toBeNull()
    expect(a.readBack).toBe(true)
    expect(a.endpoint()).toBeNull()
  })

  it('never overwrites an existing object', async () => {
    const a = createFolderAdapter({ path: join(root, 'mm'), roots: [root], dataDir })
    const key = remoteKeyFor('', 'gzip', '7c9e6679-7425-40de-944b-e07fc1f90ae7', Date.UTC(2026, 9, 3))
    await a.put(key, localFile('one'), null, io, signal)
    await expect(a.put(key, localFile('two'), null, io, signal)).rejects.toMatchObject({ reason: 'conflict' })
    expect(readFileSync(join(root, 'mm', ...key.split('/')), 'utf8')).toBe('one')
  })

  it('refuses folders outside the roots, the data directory, UNC and device paths, and links', () => {
    expect(reason(() => resolveFolder(join(base, 'elsewhere'), [root], dataDir))).toBe('path')
    expect(reason(() => resolveFolder(join(root, '..', 'data'), [root], dataDir))).toBe('path')
    expect(reason(() => resolveFolder('relative/path', [root], dataDir))).toBe('path')
    expect(reason(() => resolveFolder('\\\\server\\share\\x', [root], dataDir))).toBe('path')
    expect(reason(() => resolveFolder('\\\\?\\C:\\x', [root], dataDir))).toBe('path')
    expect(reason(() => resolveFolder(join(dataDir, 'in'), [base], dataDir))).toBe('path')
    expect(existsSync(join(dataDir, 'in'))).toBe(false)
    expect(reason(() => resolveFolder(join(root, 'ok'), [], dataDir))).toBe('path')
    const outside = join(base, 'outside')
    mkdirSync(outside)
    // A junction on Windows needs no privilege; a symlink elsewhere.
    symlinkSync(outside, join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(reason(() => resolveFolder(join(root, 'link', 'mm'), [root], dataDir))).toBe('path')
    // Nothing was created through the link.
    expect(existsSync(join(outside, 'mm'))).toBe(false)
    expect(reason(() => resolveFolder(join(root, 'ok'), [root], dataDir))).toBe('none')
  })

  it('refuses keys outside the layout', async () => {
    const a = createFolderAdapter({ path: join(root, 'mm'), roots: [root], dataDir })
    await expect(a.get('../../secret', 0, signal)).rejects.toMatchObject({ reason: 'path' })
    await expect(a.remove('mongo-manager/../../x', signal)).rejects.toMatchObject({ reason: 'path' })
  })
})
