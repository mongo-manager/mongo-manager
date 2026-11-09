// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as realFs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { text } from 'node:stream/consumers'

/*
 * Phase 3d-3b final review (A19): races in the folder destination — a link planted between the
 * check of a path and its use. The file system calls are wrapped so a test can act at that moment.
 */

const hooks = vi.hoisted(() => ({
  /** Runs once, before the first open/read of a path for which it returns true. */
  beforeUse: null as null | ((path: string) => boolean),
  /** Runs before every mkdirSync. */
  beforeMkdir: null as null | ((path: string) => void),
  /** Counts fs/promises lstat calls (a listing page must not stat every object). */
  lstats: 0,
}))
const fire = (p: unknown) => {
  const h = hooks.beforeUse
  if (h && typeof p === 'string' && h(p)) hooks.beforeUse = null
}

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    createReadStream: ((p: unknown, ...rest: unknown[]) => {
      fire(p)
      return (actual.createReadStream as (...a: unknown[]) => unknown)(p, ...rest)
    }) as typeof actual.createReadStream,
    mkdirSync: ((p: unknown, ...rest: unknown[]) => {
      hooks.beforeMkdir?.(String(p))
      return (actual.mkdirSync as (...a: unknown[]) => unknown)(p, ...rest)
    }) as typeof actual.mkdirSync,
  }
})
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    open: ((p: unknown, ...rest: unknown[]) => {
      fire(p)
      return (actual.open as (...a: unknown[]) => unknown)(p, ...rest)
    }) as typeof actual.open,
    lstat: ((...a: unknown[]) => {
      hooks.lstats++
      return (actual.lstat as (...b: unknown[]) => unknown)(...a)
    }) as typeof actual.lstat,
    readFile: ((p: unknown, ...rest: unknown[]) => {
      fire(p)
      return (actual.readFile as (...a: unknown[]) => unknown)(p, ...rest)
    }) as typeof actual.readFile,
  }
})

const { createFolderAdapter, resolveFolder } = await import('../src/backup/destinations/folder')
const { remoteKeyFor } = await import('../src/backup/destinations/layout')

let base: string
let root: string
let dataDir: string
let outside: string
const signal = new AbortController().signal
beforeEach(() => {
  base = realFs.mkdtempSync(join(tmpdir(), 'mm-folder-race-'))
  root = join(base, 'root')
  dataDir = join(base, 'data')
  outside = join(base, 'outside')
  for (const d of [root, dataDir, outside]) realFs.mkdirSync(d)
})
afterEach(() => {
  hooks.beforeUse = null
  hooks.beforeMkdir = null
  realFs.rmSync(base, { recursive: true, force: true })
})
const link = (target: string, at: string) =>
  realFs.symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir')
const key = remoteKeyFor('', 'mmbak', '00000001-7425-40de-944b-e07fc1f90ae7', Date.UTC(2026, 9, 3))
const name = key.split('/').at(-1)!

describe('folder races (A19)', () => {
  /** The month folder is swapped for a junction to a look-alike elsewhere, at the moment of use. */
  function swapMonthOnUse() {
    const month = join(root, 'mm', 'mongo-manager', '2026', '10')
    realFs.mkdirSync(month, { recursive: true })
    realFs.writeFileSync(join(month, name), 'ours')
    realFs.writeFileSync(join(outside, name), 'SECRET elsewhere')
    hooks.beforeUse = (p) => {
      if (!p.endsWith(name)) return false
      realFs.renameSync(month, `${month}-old`)
      link(outside, month)
      return true
    }
  }

  it('get never reads through a junction swapped in between the check and the open', async () => {
    swapMonthOnUse()
    const a = createFolderAdapter({ path: join(root, 'mm'), roots: [root], dataDir })
    const got: unknown = await a.get(key, 0, signal).catch((e: unknown) => e)
    const read = got instanceof Readable ? await text(got) : null
    expect(read).not.toBe('SECRET elsewhere')
    expect(got).toMatchObject({ reason: 'path' })
  })

  it('getSmall never reads through a junction swapped in between the check and the open', async () => {
    swapMonthOnUse()
    const a = createFolderAdapter({ path: join(root, 'mm'), roots: [root], dataDir })
    const got: unknown = await a.getSmall(key, 1024, signal).catch((e: unknown) => e)
    expect(Buffer.isBuffer(got) ? got.toString() : null).not.toBe('SECRET elsewhere')
    expect(got).toMatchObject({ reason: 'path' })
  })

  it('resolveFolder creates nothing through a junction planted while it creates the folder', () => {
    const wanted = join(root, 'a', 'b')
    let planted = false
    hooks.beforeMkdir = (p) => {
      if (planted || !p.startsWith(root)) return
      planted = true
      link(outside, join(root, 'a'))
    }
    expect(() => resolveFolder(wanted, [root], dataDir)).toThrow()
    expect(planted).toBe(true)
    expect(realFs.existsSync(join(outside, 'b'))).toBe(false)
  })
})

describe('folder listing cost (final gate)', () => {
  // A page used to stat every object in the folder (10 pages of 10 000 → 100 000 stats).
  it('stats only the objects of the page it returns', async () => {
    const a = createFolderAdapter({ path: join(root, 'mm'), roots: [root], dataDir })
    const month = join(root, 'mm', 'mongo-manager', '2026', '10')
    realFs.mkdirSync(month, { recursive: true })
    const ids = Array.from({ length: 1500 }, (_, i) => String(i).padStart(8, '0'))
    for (const id of ids) realFs.writeFileSync(join(month, `mm-20261003-000000-${id}.mmbak`), 'x')
    hooks.lstats = 0
    const first = await a.list(null, signal)
    expect(first.items).toHaveLength(1000)
    expect(first.items[0]!.key).toBe(`mongo-manager/2026/10/mm-20261003-000000-${ids.at(-1)}.mmbak`)
    expect(hooks.lstats).toBeLessThanOrEqual(1010)
    const second = await a.list(first.cursor, signal)
    expect(second.items).toHaveLength(500)
    expect(second.cursor).toBeNull()
    expect(new Set([...first.items, ...second.items].map((i) => i.key)).size).toBe(1500)
  })
})
