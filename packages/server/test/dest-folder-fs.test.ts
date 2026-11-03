import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, parse, sep } from 'node:path'
import * as fsp from 'node:fs/promises'
import { createFolderAdapter, resolveFolder } from '../src/backup/destinations/folder'
import { remoteKeyFor } from '../src/backup/destinations/layout'
import { DestinationError } from '../src/backup/destinations/types'

/**
 * Short names reviews (2026-10-21): a path that matches no root as written is matched against
 * the roots' own folders, so nothing but names in those folders is looked at (no climb above the
 * path through links outside every root), and a part that cannot be read is a refusal, not a raw
 * error (a 500).
 */
vi.mock('node:fs', async (original) => {
  const real = await original<typeof import('node:fs')>()
  const realpathSync = Object.assign(vi.fn(real.realpathSync), {
    native: vi.fn(real.realpathSync.native),
  })
  return {
    ...real,
    lstatSync: vi.fn(real.lstatSync),
    statSync: vi.fn(real.statSync),
    existsSync: vi.fn(real.existsSync),
    accessSync: vi.fn(real.accessSync),
    mkdirSync: vi.fn(real.mkdirSync),
    createReadStream: vi.fn(real.createReadStream),
    realpathSync,
  }
})

vi.mock('node:fs/promises', async (original) => {
  const real = await original<typeof import('node:fs/promises')>()
  return { ...real, open: vi.fn(real.open), rename: vi.fn(real.rename) }
})
const openReal = vi.mocked(fsp.open).getMockImplementation()!
const renameReal = vi.mocked(fsp.rename).getMockImplementation()!

const watched = () => [
  fs.lstatSync,
  fs.statSync,
  fs.existsSync,
  fs.accessSync,
  fs.mkdirSync,
  fs.realpathSync,
  fs.realpathSync.native,
]
const nativeReal = vi.mocked(fs.realpathSync.native).getMockImplementation()!
const lstatReal = vi.mocked(fs.lstatSync).getMockImplementation()!
let base: string
let root: string
let dataDir: string
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'mm-folder-fs-'))
  root = join(base, 'root')
  dataDir = join(base, 'data')
  for (const d of [root, dataDir]) mkdirSync(d)
  forget()
})
/** What the test itself did is not what resolveFolder looked at. */
const forget = () => {
  for (const f of watched()) vi.mocked(f).mockClear()
}
afterEach(() => {
  vi.mocked(fs.realpathSync.native).mockImplementation(nativeReal)
  vi.mocked(fs.lstatSync).mockImplementation(lstatReal)
  vi.mocked(fsp.open).mockImplementation(openReal)
  vi.mocked(fsp.rename).mockImplementation(renameReal)
  rmSync(base, { recursive: true, force: true })
})

const refusal = (fn: () => unknown) => {
  try {
    fn()
    return 'none'
  } catch (e) {
    return e instanceof DestinationError ? e.message : `raw ${String(e)}`
  }
}
const touched = () => watched().flatMap((f) => vi.mocked(f).mock.calls.map((c) => String(c[0])))
const eperm = () => Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })
/** The mocked call fails for paths ending in `end`, from its `from`th such call on. */
function failing<T extends (...a: never[]) => unknown>(real: T, end: string, from = 1) {
  let seen = 0
  return ((p: fs.PathLike, ...rest: never[]) => {
    if (String(p).endsWith(end) && ++seen >= from) throw eperm()
    return real(p as never, ...rest)
  }) as never
}

describe('resolveFolder: what is looked at for a path that matches no root as written', () => {
  it('nothing when no root is set', () => {
    const path = join(base, 'somewhere', 'deep')
    // Short names review 8 (I-1): and said as no root set, not as a path outside the roots.
    expect(refusal(() => resolveFolder(path, [], dataDir))).toMatch(/MM_BACKUP_FOLDER_ROOTS is not set/)
    expect(touched()).toEqual([])
  })

  // Short names review 3 (I-1): not even the name beside the roots' own folders — on POSIX a lookup
  // of a mount point goes into the mount (a dead NFS mount, an automounter).
  it('nothing beneath a folder that is not one of the roots’ own, nor the folder itself', () => {
    mkdirSync(join(base, 'other', 'deep'), { recursive: true })
    forget()
    const path = join(base, 'other', 'deep', 'x')
    expect(refusal(() => resolveFolder(path, [root], dataDir))).toMatch(/not inside/)
    expect(touched().filter((p) => p.startsWith(join(base, 'other')))).toEqual([])
  })

  // Where a folder has no other spelling, not even a name that would be one on Windows.
  it.runIf(process.platform !== 'win32')(
    'nothing named like a root’s folder, where there are no spellings',
    () => {
      for (const name of ['ROOT', 'ROOT~1', 'root::$INDEX_ALLOCATION'])
        mkdirSync(join(base, name), { recursive: true })
      forget()
      for (const name of ['ROOT', 'ROOT~1', 'root::$INDEX_ALLOCATION']) {
        expect(refusal(() => resolveFolder(join(base, name, 'one'), [root], dataDir))).toMatch(/not inside/)
      }
      expect(touched().filter((p) => p !== root && !p.startsWith(root + sep))).toEqual([])
    },
  )

  it.runIf(process.platform === 'win32')('each path once, however many roots there are', () => {
    // Long names, so that R~1 may be the short name of each.
    const roots = ['root-number-one', 'root-number-two', 'root-number-three'].map((n) => join(base, n))
    for (const r of roots) mkdirSync(r)
    forget()
    expect(refusal(() => resolveFolder(join(base, 'R~1', 'x'), roots, dataDir))).toMatch(/not inside/)
    const counts = new Map<string, number>()
    for (const c of vi.mocked(fs.lstatSync).mock.calls)
      counts.set(String(c[0]), (counts.get(String(c[0])) ?? 0) + 1)
    expect([...counts].filter(([, n]) => n > 1)).toEqual([])
    expect(counts.has(join(base, 'R~1'))).toBe(true)
  })

  it.runIf(process.platform === 'win32')('nothing on a drive no root is on', () => {
    const drive = parse(base).root.slice(0, 1).toUpperCase()
    const other = drive === 'Q' ? 'R' : 'Q'
    // The root's own folder names on another drive, so that only the drive tells them apart.
    const deep = join(`${other}:\\`, root.slice(parse(root).root.length), 'deep')
    expect(refusal(() => resolveFolder(deep, [root], dataDir))).toMatch(/not inside/)
    expect(touched().filter((p) => p.toUpperCase().startsWith(`${other}:`))).toEqual([])
  })
})

describe('resolveFolder: a root spelled another way is that root only when it surely is', () => {
  const asIndex = (p: string) => `${p}::$INDEX_ALLOCATION`

  it.runIf(process.platform === 'win32')('not on a disk that gives no file ids', () => {
    vi.mocked(fs.lstatSync).mockImplementation(((p: fs.PathLike, o?: { bigint?: boolean }) => {
      const st = lstatReal(p, o as never)
      return o?.bigint && st
        ? Object.assign(Object.create(Object.getPrototypeOf(st) as object), st, { ino: 0n })
        : st
    }) as never)
    expect(refusal(() => resolveFolder(join(asIndex(root), 'one'), [root], dataDir))).toMatch(/not inside/)
  })

  it.runIf(process.platform === 'win32')('not when its real path is not the root’s', () => {
    vi.mocked(fs.realpathSync.native).mockImplementation(((p: fs.PathLike, o?: unknown) =>
      String(p).endsWith('$INDEX_ALLOCATION') ? join(base, 'elsewhere') : nativeReal(p, o as never)) as never)
    expect(refusal(() => resolveFolder(join(asIndex(root), 'one'), [root], dataDir))).toMatch(/not inside/)
  })
})

describe('resolveFolder: a part that cannot be read', () => {
  it('by its real path, is refused as a folder that could not be made, not a raw error', () => {
    vi.mocked(fs.realpathSync.native).mockImplementation(failing(nativeReal, 'one'))
    expect(refusal(() => resolveFolder(join(root, 'one', 'two'), [root], dataDir))).toMatch(/could not be/)
  })

  it('looked at, is too', () => {
    mkdirSync(join(root, 'one'))
    vi.mocked(fs.lstatSync).mockImplementation(failing(lstatReal, 'one'))
    expect(refusal(() => resolveFolder(join(root, 'one', 'two'), [root], dataDir))).toMatch(/could not be/)
  })

  // Short names review 3 (M-3): a folder swapped for a junction after its check — seen here as its
  // real path suddenly elsewhere — has nothing made beneath it.
  it('leading elsewhere once looked at, has nothing made beneath it', () => {
    vi.mocked(fs.realpathSync.native).mockImplementation(((p: fs.PathLike, o?: unknown) =>
      String(p) === join(root, 'a') ? join(base, 'elsewhere') : nativeReal(p, o as never)) as never)
    expect(refusal(() => resolveFolder(join(root, 'a', 'b'), [root], dataDir))).toMatch(/leads outside/)
    expect(fs.existsSync(join(root, 'a', 'b'))).toBe(false)
  })

  // Short names review 8 (M-5, M-3): create and outside pinned by their codes too; a read-only
  // file system said so, not as a permission matter.
  it('says which: could not be made, read-only, outside', () => {
    const why = (fn: () => unknown) => {
      try {
        fn()
      } catch (e) {
        return e instanceof DestinationError ? e.extra.why : `raw ${String(e)}`
      }
      return 'none'
    }
    const errno = (code: string) => Object.assign(new Error(code), { code })
    vi.mocked(fs.mkdirSync).mockImplementationOnce(() => {
      throw errno('EACCES')
    })
    expect(why(() => resolveFolder(join(root, 'p'), [root], dataDir))).toBe('create')
    vi.mocked(fs.mkdirSync).mockImplementationOnce(() => {
      throw errno('EROFS')
    })
    expect(why(() => resolveFolder(join(root, 'q'), [root], dataDir))).toBe('read_only')
    vi.mocked(fs.realpathSync.native).mockImplementation(((p: fs.PathLike, o?: unknown) =>
      String(p) === join(root, 'r') ? join(base, 'elsewhere') : nativeReal(p, o as never)) as never)
    expect(why(() => resolveFolder(join(root, 'r', 's'), [root], dataDir))).toBe('outside')
  })

  // CI 2026-10-21 (Linux): a name too long for the file system makes lstat say ENAMETOOLONG before
  // any mkdir — said as too long, not as a folder that could not be made; a read-only one likewise.
  it('looked at, says what the file system said where it is not a permission matter', () => {
    const why = (fn: () => unknown) => {
      try {
        fn()
      } catch (e) {
        return e instanceof DestinationError ? e.extra.why : `raw ${String(e)}`
      }
      return 'none'
    }
    const errno = (code: string) => Object.assign(new Error(code), { code })
    vi.mocked(fs.lstatSync).mockImplementation(((p: fs.PathLike, o?: never) => {
      if (String(p).endsWith('long')) throw errno('ENAMETOOLONG')
      if (String(p).endsWith('ro')) throw errno('EROFS')
      return lstatReal(p, o)
    }) as never)
    expect(why(() => resolveFolder(join(root, 'long'), [root], dataDir))).toBe('too_long')
    expect(why(() => resolveFolder(join(root, 'ro'), [root], dataDir))).toBe('read_only')
  })

  it('looked at again once made, is too', () => {
    vi.mocked(fs.lstatSync).mockImplementation(failing(lstatReal, 'made', 2))
    expect(refusal(() => resolveFolder(join(root, 'made'), [root], dataDir))).toMatch(/could not be/)
  })

  it('the folder itself, at the end, is too', () => {
    vi.mocked(fs.realpathSync.native).mockImplementation(failing(nativeReal, 'last', 2))
    expect(refusal(() => resolveFolder(join(root, 'last'), [root], dataDir))).toMatch(/could not be/)
  })
})

// Short names review 8 (I-2): a write the file system refuses is said as the destination's refusal —
// a full disk as a full destination, no permission as a folder that cannot be made — not passed on
// raw, to be called the provider's.
describe('a folder destination whose writes the file system refuses', () => {
  const key = remoteKeyFor('', 'mmbak', '00000001-7425-40de-944b-e07fc1f90ae7', Date.UTC(2026, 9, 3))
  const signal = new AbortController().signal
  const errno = (code: string) => Object.assign(new Error(code), { code })
  const refusedWith = async (fn: () => Promise<unknown>) => {
    try {
      await fn()
    } catch (e) {
      return e instanceof DestinationError ? [e.reason, e.extra.why ?? null] : ['raw', String(e)]
    }
    return ['none', null]
  }

  it('says a full disk is a full destination, and no permission a folder that cannot be made', async () => {
    const a = createFolderAdapter({ path: join(root, 'mm'), roots: [root], dataDir })
    vi.mocked(fsp.open).mockImplementationOnce(() => Promise.reject(errno('ENOSPC')))
    expect(await refusedWith(() => a.putSmall(`${key}.json`, Buffer.from('{}'), signal))).toEqual([
      'quota',
      null,
    ])
    vi.mocked(fsp.open).mockImplementationOnce(() => Promise.reject(errno('EACCES')))
    expect(await refusedWith(() => a.putSmall(`${key}.json`, Buffer.from('{}'), signal))).toEqual([
      'path',
      'create',
    ])
    // And one that fails while it writes.
    vi.mocked(fsp.open).mockImplementationOnce(async (...args) => {
      const handle = await openReal(...(args as Parameters<typeof openReal>))
      return Object.assign(Object.create(handle) as object, {
        writeFile: () => Promise.reject(errno('EDQUOT')),
        close: () => handle.close(),
      }) as never
    })
    expect(await refusedWith(() => a.putSmall(`${key}.json`, Buffer.from('{}'), signal))).toEqual([
      'quota',
      null,
    ])
    // Something else is passed on as it is.
    vi.mocked(fsp.open).mockImplementationOnce(() => Promise.reject(errno('EIO')))
    expect((await refusedWith(() => a.putSmall(`${key}.json`, Buffer.from('{}'), signal)))[0]).toBe('raw')
  })
})

// Short names review 9: a put's source and its destination told apart, every write step mapped,
// and nothing left behind.
describe('a folder destination put', () => {
  const key = remoteKeyFor('', 'mmbak', '00000002-7425-40de-944b-e07fc1f90ae7', Date.UTC(2026, 9, 3))
  const signal = new AbortController().signal
  const io = { progress: () => undefined, saveResume: () => undefined }
  const errno = (code: string) => Object.assign(new Error(code), { code })
  const local = () => {
    const path = join(base, `src-${Math.random()}.bin`)
    fs.writeFileSync(path, 'x'.repeat(100))
    return { path, size: 100, sha256: 'a'.repeat(64), md5: 'b'.repeat(32) }
  }
  const outcome = async (fn: () => Promise<unknown>) => {
    try {
      await fn()
    } catch (e) {
      return e instanceof DestinationError
        ? [e.reason, e.extra.why ?? null]
        : ['raw', (e as { code?: string }).code]
    }
    return ['none', null]
  }
  const partials = () => {
    const at = join(root, 'mm', ...key.split('/').slice(0, -1))
    return fs.existsSync(at) ? fs.readdirSync(at).filter((n) => n.endsWith('.partial')) : []
  }
  const adapter = () => createFolderAdapter({ path: join(root, 'mm'), roots: [root], dataDir })

  // (I-1): an unreadable LOCAL backup file is not the destination folder's refusal.
  it('passes a local source that cannot be read on as it is', async () => {
    const real = vi.mocked(fs.createReadStream).getMockImplementation()!
    vi.mocked(fs.createReadStream).mockImplementationOnce(((p: fs.PathLike, o?: never) => {
      const s = real(p, o)
      setImmediate(() => s.destroy(errno('EACCES')))
      return s
    }) as never)
    expect(await outcome(() => adapter().put(key, local(), null, io, signal))).toEqual(['raw', 'EACCES'])
    expect(partials()).toEqual([])
  })

  it('says a full disk while writing is a full destination, and leaves no partial', async () => {
    vi.mocked(fsp.open).mockImplementationOnce(async (...args) => {
      const handle = await openReal(...(args as Parameters<typeof openReal>))
      return Object.assign(Object.create(handle) as object, {
        write: () => Promise.reject(errno('ENOSPC')),
        close: () => handle.close(),
      }) as never
    })
    expect(await outcome(() => adapter().put(key, local(), null, io, signal))).toEqual(['quota', null])
    expect(partials()).toEqual([])
  })

  it('passes a sync the disk fails for another reason on, and leaves no partial', async () => {
    vi.mocked(fsp.open).mockImplementationOnce(async (...args) => {
      const handle = await openReal(...(args as Parameters<typeof openReal>))
      return Object.assign(Object.create(handle) as object, {
        write: (b: Buffer) => handle.write(b),
        sync: () => Promise.reject(errno('EIO')),
        close: () => handle.close(),
      }) as never
    })
    expect(await outcome(() => adapter().put(key, local(), null, io, signal))).toEqual(['raw', 'EIO'])
    expect(partials()).toEqual([])
  })

  it('says a quota used up at the sync is a full destination, and leaves no partial', async () => {
    vi.mocked(fsp.open).mockImplementationOnce(async (...args) => {
      const handle = await openReal(...(args as Parameters<typeof openReal>))
      return Object.assign(Object.create(handle) as object, {
        write: (b: Buffer) => handle.write(b),
        sync: () => Promise.reject(errno('EDQUOT')),
        close: () => handle.close(),
      }) as never
    })
    expect(await outcome(() => adapter().put(key, local(), null, io, signal))).toEqual(['quota', null])
    expect(partials()).toEqual([])
  })

  // (M-2): a rename the file system refuses is mapped, and the partial removed.
  it('says a refused rename as a folder that cannot be written, and leaves no partial', async () => {
    vi.mocked(fsp.rename).mockImplementationOnce(() => Promise.reject(errno('EPERM')))
    expect(await outcome(() => adapter().put(key, local(), null, io, signal))).toEqual(['path', 'create'])
    expect(partials()).toEqual([])
    vi.mocked(fsp.rename).mockImplementationOnce(() => Promise.reject(errno('EPERM')))
    expect(await outcome(() => adapter().putSmall(`${key}.json`, Buffer.from('{}'), signal))).toEqual([
      'path',
      'create',
    ])
    expect(partials()).toEqual([])
  })

  // Short names review 11 (M-4): a folder planted at the name while the file was written is the
  // layout, even where the rename says EPERM for it.
  it('says a folder planted at the name during the write is the layout', async () => {
    vi.mocked(fsp.rename).mockImplementationOnce(async (_from, to) => {
      fs.mkdirSync(String(to))
      throw errno('EPERM')
    })
    expect(await outcome(() => adapter().put(key, local(), null, io, signal))).toEqual(['path', 'layout'])
    expect(partials()).toEqual([])
  })

  // (M-2): a folder planted where the partial goes is something else inside the layout.
  it('says a folder planted at the partial is the layout', async () => {
    const a = adapter()
    await a.putSmall(`${key}.json`, Buffer.from('{}'), signal)
    fs.mkdirSync(join(root, 'mm', ...`${key}.partial`.split('/')))
    expect(await outcome(() => a.put(key, local(), null, io, signal))).toEqual(['path', 'layout'])
  })

  // Short names review 10 (M-1): a folder planted at the backup's own name is the layout, said
  // before anything is written (Windows' rename says EPERM, not EISDIR).
  it('says a folder planted at the file’s own name is the layout, before writing', async () => {
    const a = adapter()
    await a.putSmall(`${key}.json`, Buffer.from('{}'), signal)
    fs.mkdirSync(join(root, 'mm', ...key.split('/')))
    vi.mocked(fsp.open).mockClear()
    expect(await outcome(() => a.put(key, local(), null, io, signal))).toEqual(['path', 'layout'])
    expect(await outcome(() => a.putSmall(key, Buffer.from('{}'), signal))).toEqual(['path', 'layout'])
    expect(vi.mocked(fsp.open).mock.calls.filter((c) => String(c[0]).endsWith('.partial'))).toEqual([])
  })

  // (M-4): a close that fails after the sync is mapped, and leaves no partial.
  it('says a close the disk fails is the destination’s, and leaves no partial', async () => {
    for (const run of [
      (a: ReturnType<typeof adapter>) => a.put(key, local(), null, io, signal),
      (a: ReturnType<typeof adapter>) => a.putSmall(`${key}.json`, Buffer.from('{}'), signal),
    ]) {
      vi.mocked(fsp.open).mockImplementationOnce(async (...args) => {
        const handle = await openReal(...(args as Parameters<typeof openReal>))
        let closed = false
        return Object.assign(Object.create(handle) as object, {
          write: (b: Buffer) => handle.write(b),
          writeFile: (b: Buffer) => handle.writeFile(b),
          sync: () => handle.sync(),
          close: async () => {
            await handle.close()
            if (!closed) {
              closed = true
              throw errno('ENOSPC')
            }
          },
        }) as never
      })
      expect(await outcome(() => run(adapter()))).toEqual(['quota', null])
      expect(partials()).toEqual([])
    }
  })

  // (M-4): what lstat says after a layout folder was made meanwhile is a refusal, not raw.
  it('says a layout folder made meanwhile that cannot be looked at is one that cannot be made', async () => {
    fs.mkdirSync(join(root, 'mm'))
    const real = vi.mocked(fs.mkdirSync).getMockImplementation()!
    vi.mocked(fs.mkdirSync).mockImplementationOnce(((p: fs.PathLike, o?: never) => {
      real(p, o)
      throw errno('EEXIST')
    }) as never)
    vi.mocked(fs.lstatSync).mockImplementation(failing(lstatReal, 'mongo-manager', 2))
    expect(await outcome(() => adapter().putSmall(`${key}.json`, Buffer.from('{}'), signal))).toEqual([
      'path',
      'create',
    ])
  })

  // (M-1): another process making the same month folder first is no refusal.
  it('takes a layout folder made meanwhile by someone else', async () => {
    // The folder itself is there: the next folder made is the layout's own (pathOf).
    fs.mkdirSync(join(root, 'mm'))
    const real = vi.mocked(fs.mkdirSync).getMockImplementation()!
    vi.mocked(fs.mkdirSync).mockImplementationOnce(((p: fs.PathLike, o?: never) => {
      real(p, o)
      throw errno('EEXIST')
    }) as never)
    expect(await outcome(() => adapter().putSmall(`${key}.json`, Buffer.from('{}'), signal))).toEqual([
      'none',
      null,
    ])
  })
})
