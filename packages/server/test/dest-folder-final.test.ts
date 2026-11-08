// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createFolderAdapter, resolveFolder } from '../src/backup/destinations/folder'
import { remoteKeyFor } from '../src/backup/destinations/layout'
import { DestinationError } from '../src/backup/destinations/types'

/* Phase 3d-3b final review: the folder destination's findings. */

let base: string
let root: string
let dataDir: string
let outside: string
const signal = new AbortController().signal
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'mm-folder-final-'))
  root = join(base, 'root')
  dataDir = join(base, 'data')
  outside = join(base, 'outside')
  for (const d of [root, dataDir, outside]) mkdirSync(d)
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

const keyAt = (i: number) =>
  remoteKeyFor(
    '',
    'mmbak',
    `${i.toString(16).padStart(8, '0')}-7425-40de-944b-e07fc1f90ae7`,
    Date.UTC(2026, 9, 3, 0, 0, i),
  )
const onDisk = (folder: string, key: string) => join(folder, ...key.split('/'))
const adapter = (path = join(root, 'mm')) => createFolderAdapter({ path, roots: [root], dataDir })
const io = { progress: () => undefined, saveResume: () => undefined }
function localFile(content: string | Buffer) {
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

describe('folder final review', () => {
  it('A5: a retried put finds the object already in place: accepted when its size matches', async () => {
    const a = adapter()
    const f = localFile('0123456789')
    await a.put(keyAt(1), f, null, io, signal)
    await expect(a.put(keyAt(1), f, null, io, signal)).resolves.toEqual({})
    // Another size is another file: still a conflict.
    await expect(a.put(keyAt(1), localFile('012'), null, io, signal)).rejects.toMatchObject({
      reason: 'conflict',
    })
    // The same size with other bytes is another file too.
    await expect(a.put(keyAt(1), localFile('9876543210'), null, io, signal)).rejects.toMatchObject({
      reason: 'conflict',
    })
    expect(readFileSync(onDisk(join(root, 'mm'), keyAt(1)), 'utf8')).toBe('0123456789')
  })

  it('A6: putSmall never writes through a file planted at its partial name', async () => {
    const a = adapter()
    await a.authCheck(signal)
    const full = onDisk(join(root, 'mm'), `${keyAt(2)}.json`)
    mkdirSync(dirname(full), { recursive: true })
    const victim = join(outside, 'victim')
    writeFileSync(victim, 'precious')
    // A hard link needs no privilege anywhere: opening it with "w" would truncate the victim.
    linkSync(victim, `${full}.partial`)
    await a.putSmall(`${keyAt(2)}.json`, Buffer.from('{"v":1}'), signal)
    expect(readFileSync(victim, 'utf8')).toBe('precious')
    expect(readFileSync(full, 'utf8')).toBe('{"v":1}')
  })

  it('A18: a folder whose layout root is the data directory is refused', () => {
    const data = join(root, 'mongo-manager')
    mkdirSync(data)
    expect(reason(() => resolveFolder(root, [root], data))).toBe('path')
    // The data directory inside the layout root too.
    const deeper = join(root, 'x', 'mongo-manager', '2026')
    mkdirSync(deeper, { recursive: true })
    expect(reason(() => resolveFolder(join(root, 'x'), [root], deeper))).toBe('path')
    // A data directory beside the folder is fine.
    expect(reason(() => resolveFolder(join(root, 'y'), [root], dataDir))).toBe('none')
  })

  it('A19: list and putSmall honour an aborted signal', async () => {
    const a = adapter()
    await a.authCheck(signal)
    const stopped = AbortSignal.abort()
    await expect(a.list(null, stopped)).rejects.toMatchObject({ reason: 'aborted' })
    await expect(a.putSmall(`${keyAt(3)}.json`, Buffer.from('{}'), stopped)).rejects.toMatchObject({
      reason: 'aborted',
    })
    expect(existsSync(onDisk(join(root, 'mm'), `${keyAt(3)}.json`))).toBe(false)
  })

  it('A19: a listing holds at most 10 000 objects, the newest', async () => {
    const a = adapter()
    const month = join(root, 'mm', 'mongo-manager', '2026', '10')
    mkdirSync(month, { recursive: true })
    for (let i = 0; i < 10_010; i++) writeFileSync(join(month, keyAt(i).split('/').at(-1)!), '')
    let total = 0
    let first: string | undefined
    let cursor: string | null = null
    do {
      const page = await a.list(cursor, signal)
      first ??= page.items[0]?.key
      total += page.items.length
      cursor = page.cursor
    } while (cursor)
    expect(total).toBe(10_000)
    expect(first).toBe(keyAt(10_009))
  }, 60_000)
})
