import { afterEach, beforeEach, describe, expect, it, onTestFinished, type TestContext } from 'vitest'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { text } from 'node:stream/consumers'
import { createFolderAdapter, resolveFolder } from '../src/backup/destinations/folder'
import { remoteKeyFor } from '../src/backup/destinations/layout'
import { DestinationError } from '../src/backup/destinations/types'
import { isCI } from './support/slowness'

/* Phase 3d-3b spec §2.2, D11: the server folder destination — its path walk and its object store. */

let base: string
let root: string
let dataDir: string
let outside: string
const signal = new AbortController().signal
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'mm-folder-more-'))
  root = join(base, 'root')
  dataDir = join(base, 'data')
  outside = join(base, 'outside')
  for (const d of [root, dataDir, outside]) mkdirSync(d)
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

/** A directory link that needs no privilege on Windows (a junction), a symlink elsewhere. */
const link = (target: string, at: string) =>
  symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir')
/**
 * Windows' 8.3 short spelling of a path, or null where the volume keeps no short name for its last
 * part (a short folder above it, as C:\Users\RUNNER~1, is not enough).
 */
const shortOf = (p: string) => {
  // Verbatim: cmd reads the quotes as written, not as escaped by Node. /u: UTF-16, so a folder
  // named outside the OEM code page reads back as it is.
  const r = spawnSync('cmd.exe', ['/u', '/d', '/c', `for %I in ("${p}") do @echo %~sI`], {
    encoding: 'utf16le',
    windowsVerbatimArguments: true,
  })
  const s = r.status === 0 ? r.stdout.trim() : ''
  return s && basename(s) !== basename(p) && existsSync(s) ? s : null
}
/** Where the volume keeps no short names: skipped, but not on CI, where these tests must run. */
const noShortNames = (ctx: TestContext) => {
  // GitHub sets CI=true; a CI=false or a Dev Drive (no 8.3 names) at home only skips.
  if (isCI()) {
    throw new Error('This volume keeps no 8.3 short names: the short-name tests cannot run')
  }
  ctx.skip()
}
const reason = (fn: () => unknown) => {
  try {
    fn()
    return 'none'
  } catch (e) {
    return e instanceof DestinationError ? e.reason : 'other'
  }
}
/** Which refusal: every one is the reason 'path', told apart by its message. */
const refusal = (fn: () => unknown) => {
  try {
    fn()
    return 'none'
  } catch (e) {
    return e instanceof DestinationError ? e.message : 'other'
  }
}
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
const io = { progress: () => undefined, saveResume: () => undefined }
const keyAt = (i: number) =>
  remoteKeyFor(
    '',
    'mmbak',
    `${i.toString(16).padStart(8, '0')}-7425-40de-944b-e07fc1f90ae7`,
    Date.UTC(2026, 9, 3, 0, 0, i),
  )
const onDisk = (folder: string, key: string) => join(folder, ...key.split('/'))
const adapter = (path = join(root, 'mm')) => createFolderAdapter({ path, roots: [root], dataDir })

describe('resolveFolder: the path walk (spec §2.2)', () => {
  it('refuses a regular file on the way and leaves it alone', () => {
    writeFileSync(join(root, 'file.txt'), 'keep')
    expect(reason(() => resolveFolder(join(root, 'file.txt', 'mm'), [root], dataDir))).toBe('path')
    expect(readFileSync(join(root, 'file.txt'), 'utf8')).toBe('keep')
  })

  it('refuses a junction deeper in the path and creates nothing through it', () => {
    mkdirSync(join(root, 'a'))
    link(outside, join(root, 'a', 'link'))
    expect(reason(() => resolveFolder(join(root, 'a', 'link', 'b', 'c'), [root], dataDir))).toBe('path')
    expect(readdirSync(outside)).toEqual([])
    // The same folder spelled with ".." through the link is still refused.
    expect(reason(() => resolveFolder(join(root, 'a', 'link', '..', 'link', 'b'), [root], dataDir))).toBe(
      'path',
    )
    expect(readdirSync(outside)).toEqual([])
  })

  it('refuses a path that climbs out of the roots, and a root that does not exist', () => {
    expect(reason(() => resolveFolder(`${root}/mm/../../outside/x`, [root], dataDir))).toBe('path')
    expect(existsSync(join(outside, 'x'))).toBe(false)
    const missing = join(base, 'missing-root')
    expect(reason(() => resolveFolder(join(missing, 'mm'), [missing], dataDir))).toBe('path')
    expect(existsSync(missing)).toBe(false)
  })

  it('refuses a folder inside a data directory that does not exist yet', () => {
    const later = join(base, 'later-data')
    expect(reason(() => resolveFolder(join(later, 'x'), [base], later))).toBe('path')
    expect(existsSync(later)).toBe(false)
  })

  it('matches a root given through a link by its real path, and answers the real folder', () => {
    const real = join(base, 'real-root')
    mkdirSync(real)
    const alias = join(base, 'alias-root')
    link(real, alias)
    // Spelled through the root as given… (the native real path: long names, as resolveFolder answers)
    expect(resolveFolder(join(alias, 'one'), [alias], dataDir)).toBe(realpathSync.native(join(real, 'one')))
    // …or through its real path (e.g. /tmp and /private/tmp on macOS).
    expect(resolveFolder(join(real, 'two'), [alias], dataDir)).toBe(realpathSync.native(join(real, 'two')))
    expect(readdirSync(real).sort()).toEqual(['one', 'two'])
  })

  // CI 2026-10-21: the Windows runner's temp folder is C:\Users\RUNNER~1\… — a root given by its
  // short name answers its long real path, and a junction beneath it is still found.
  it.runIf(process.platform === 'win32')(
    'answers the long real path of a root given by its 8.3 short name',
    (ctx) => {
      const long = join(base, 'a-root-with-a-long-name')
      mkdirSync(long)
      const short = shortOf(long)
      if (!short) return noShortNames(ctx)
      const got = resolveFolder(join(short, 'one'), [short], dataDir)
      expect(got).toBe(join(realpathSync.native(long), 'one'))
      expect(got).not.toContain('~')
      link(outside, join(long, 'away'))
      expect(refusal(() => resolveFolder(join(short, 'away', 'x'), [short], dataDir))).toMatch(
        /link or junction/,
      )
      expect(readdirSync(outside)).toEqual([])
    },
  )

  it.runIf(process.platform === 'win32')(
    'matches a folder spelled by short names inside a root given by its long name',
    (ctx) => {
      const long = join(base, 'a-root-with-a-long-name')
      mkdirSync(long)
      const short = shortOf(long)
      if (!short) return noShortNames(ctx)
      const longReal = realpathSync.native(long)
      expect(resolveFolder(join(short, 'one'), [longReal], dataDir)).toBe(join(longReal, 'one'))
      // The drive letter as typed: c: is C:.
      const lower = short.replace(/^[A-Z]:/, (d) => d.toLowerCase())
      expect(resolveFolder(join(lower, 'two'), [longReal], dataDir)).toBe(join(longReal, 'two'))
      expect(readdirSync(long).sort()).toEqual(['one', 'two'])
      link(outside, join(long, 'away'))
      expect(refusal(() => resolveFolder(join(short, 'away', 'x'), [longReal], dataDir))).toMatch(
        /link or junction/,
      )
      expect(readdirSync(outside)).toEqual([])
    },
  )

  it.runIf(process.platform === 'win32')(
    'refuses a data directory spelled by its short name before creating anything in it',
    (ctx) => {
      const data = join(root, 'a-data-folder-with-a-long-name')
      mkdirSync(data)
      const short = shortOf(data)
      if (!short) return noShortNames(ctx)
      // Only the data directory's own part short, and every part short.
      for (const path of [join(root, basename(short), 'x'), join(short, 'y')]) {
        expect(refusal(() => resolveFolder(path, [realpathSync.native(root)], data))).toMatch(
          /data directory/,
        )
      }
      expect(readdirSync(data)).toEqual([])
    },
  )

  // Short names review 1 (I-1): a root that is, by its real path, inside the data
  // directory is refused before its first missing part is made in there.
  it('refuses a root inside the data directory through a link before creating anything', () => {
    mkdirSync(join(dataDir, 'backups'))
    link(dataDir, join(base, 'lk'))
    const viaLink = join(base, 'lk', 'backups')
    expect(refusal(() => resolveFolder(join(viaLink, 'newdir'), [viaLink], dataDir))).toMatch(
      /data directory/,
    )
    expect(readdirSync(join(dataDir, 'backups'))).toEqual([])
  })

  it.runIf(process.platform === 'win32')(
    'refuses a root given by its short name inside the data directory before creating anything',
    (ctx) => {
      const data = join(base, 'a-data-folder-with-a-long-name')
      const backups = join(data, 'backups-with-a-long-name')
      mkdirSync(backups, { recursive: true })
      const short = shortOf(backups)
      if (!short) return noShortNames(ctx)
      expect(refusal(() => resolveFolder(join(short, 'newdir'), [short], data))).toMatch(/data directory/)
      expect(readdirSync(backups)).toEqual([])
    },
  )

  it.runIf(process.platform === 'win32')(
    'matches a folder spelled by the short name of a root that is a junction',
    (ctx) => {
      const real = join(base, 'real-root')
      mkdirSync(real)
      const alias = join(base, 'alias-root-with-a-long-name')
      link(real, alias)
      const short = shortOf(alias)
      if (!short) return noShortNames(ctx)
      expect(resolveFolder(join(short, 'one'), [alias], dataDir)).toBe(join(realpathSync.native(real), 'one'))
      expect(readdirSync(real)).toEqual(['one'])
    },
  )

  // Short names review 4 (M-3): a root given by short names whose real path is elsewhere (it ends in a
  // junction): a path in long names matches the root as given, part by part.
  it.runIf(process.platform === 'win32')(
    'matches long names to a root given by short names that ends in a junction',
    (ctx) => {
      const dir = join(base, 'a-folder-with-a-long-name')
      mkdirSync(dir)
      link(outside, join(dir, 'j'))
      const short = shortOf(dir)
      if (!short) return noShortNames(ctx)
      const given = join(short, 'j')
      expect(resolveFolder(join(dir, 'J', 'one'), [given], dataDir)).toBe(
        join(realpathSync.native(outside), 'one'),
      )
      expect(readdirSync(outside)).toEqual(['one'])
    },
  )

  it('does not take a link to a root, found elsewhere, for the root', () => {
    const elsewhere = join(base, 'elsewhere')
    mkdirSync(elsewhere)
    link(root, join(elsewhere, 'to-root'))
    expect(refusal(() => resolveFolder(join(elsewhere, 'to-root', 'x'), [root], dataDir))).toMatch(
      /not inside/,
    )
    expect(readdirSync(root)).toEqual([])
  })

  // Short names review 2 (I-1): a folder through a link above its root is
  // not matched — finding it meant following links outside every root (an automounter, a share).
  it('does not follow a link above a root', () => {
    const above = join(base, 'above')
    link(base, above)
    const realRoot = realpathSync.native(root)
    expect(refusal(() => resolveFolder(join(above, 'root', 'one'), [realRoot], dataDir))).toMatch(
      /not inside/,
    )
    expect(readdirSync(root)).toEqual([])
  })

  // No 8.3 names needed: NTFS's own ::$INDEX_ALLOCATION spelling of a folder, on every Windows.
  const asIndex = (p: string) => `${p}::$INDEX_ALLOCATION`

  it.runIf(process.platform === 'win32')('matches a root spelled another way, and answers it plainly', () => {
    const realRoot = realpathSync.native(root)
    expect(resolveFolder(join(asIndex(root), 'one'), [root], dataDir)).toBe(join(realRoot, 'one'))
    expect(readdirSync(root)).toEqual(['one'])
  })

  it.runIf(process.platform === 'win32')(
    'matches a root given through a junction, by its real folder spelled another way',
    () => {
      const real = join(base, 'real-root')
      mkdirSync(real)
      const alias = join(base, 'alias-root')
      link(real, alias)
      expect(resolveFolder(join(asIndex(real), 'one'), [alias], dataDir)).toBe(
        join(realpathSync.native(real), 'one'),
      )
    },
  )

  it.runIf(process.platform === 'win32')(
    'refuses a junction beneath a root spelled another way, as it does spelled plainly',
    () => {
      mkdirSync(join(root, 'sub'))
      link(base, join(root, 'sub', 'up'))
      for (const r of [root, asIndex(root)]) {
        expect(refusal(() => resolveFolder(join(r, 'sub', 'up', 'root', 'c'), [root], dataDir))).toMatch(
          /link or junction/,
        )
      }
      expect(readdirSync(root)).toEqual(['sub'])
    },
  )

  it.runIf(process.platform === 'win32')(
    'refuses a data directory spelled another way before creating anything in it',
    () => {
      const data = join(root, 'dd')
      mkdirSync(data)
      expect(refusal(() => resolveFolder(join(asIndex(data), 'x'), [root], data))).toMatch(/data directory/)
      expect(readdirSync(data)).toEqual([])
    },
  )

  it('refuses a root that is a file', () => {
    const file = join(base, 'a-file')
    writeFileSync(file, 'x')
    expect(refusal(() => resolveFolder(file, [file], dataDir))).toMatch(/not a folder/)
  })

  // Short names review 3 (M-2): Node writes names as given (\\?\), so these were made as folders
  // Explorer, cmd and robocopy cannot open or remove. Refused before any part of the path is made.
  it.runIf(process.platform === 'win32')('refuses folder names Windows cannot use', () => {
    const odd = [
      'g.',
      'a ',
      'NUL',
      'com1.txt',
      'Lpt¹',
      'conout$',
      'aux.tar.gz',
      // Short names review 4 (I-1): a stream spelling of one made the folder itself.
      'nul::$INDEX_ALLOCATION',
      'g.:$I30:$INDEX_ALLOCATION',
      'a:b',
      // Short names review 5 (M-1, M-2): spaces before a device name's extension; characters and
      // lengths mkdir refuses, which left the folders before them made.
      'con .txt',
      'nul  .txt',
      // (A NUL is refused before any of this, on every platform: see below.)
      ...['a"b', 'a<b', 'a>b', 'a|b', 'a?b', 'a*b', 'a\tb', 'a$&b.'],
      'n'.repeat(256),
    ]
    for (const name of odd) {
      const path = join(root, 'fine', name, 'x')
      expect(refusal(() => resolveFolder(path, [root], dataDir))).toMatch(/Windows cannot use/)
      // Short names review 5 (M-4): its own reason, so the editor says the name is the trouble.
      expect(reason(() => resolveFolder(path, [root], dataDir))).toBe('path_name')
    }
    expect(readdirSync(root)).toEqual([])
    // Names that only look like them are fine.
    const fine = ['null', 'com10', 'com0', 'lpt0', 'a.b', 'consoles', 'icon', 'n'.repeat(255)]
    for (const name of fine) resolveFolder(join(root, name), [root], dataDir)
    expect(readdirSync(root).sort()).toEqual([...fine].sort())
  })

  // Short names review 4 (M-1): a folder there already, from before names were checked, stays usable.
  it.runIf(process.platform === 'win32')('keeps a folder that is there already, whatever its name', () => {
    for (const name of ['v1.', 'aux']) {
      mkdirSync(join(root, name))
      expect(resolveFolder(join(root, name), [root], dataDir)).toBe(join(realpathSync.native(root), name))
      expect(resolveFolder(join(root, name, 'x'), [root], dataDir)).toBe(
        join(realpathSync.native(root), name, 'x'),
      )
      expect(refusal(() => resolveFolder(join(root, name, 'y.'), [root], dataDir))).toMatch(
        /Windows cannot use/,
      )
    }
  })

  it.runIf(process.platform === 'win32')('says an odd name back quoted and short', () => {
    const said = refusal(() => resolveFolder(join(root, 'a\u0007b.'), [root], dataDir))
    expect(said).toContain('"a\\u0007b."')
    expect(said).not.toContain('\u0007')
    // A $& in the name is the name, not a replacement pattern.
    expect(refusal(() => resolveFolder(join(root, 'a$&b.'), [root], dataDir))).toContain('"a$&b."')
    // Short names review 5 (M-3): a long one keeps its end, where the trouble often is.
    const long = `${'n'.repeat(100)}.`
    expect(refusal(() => resolveFolder(join(root, long), [root], dataDir))).toContain(
      `"${'n'.repeat(31)}…${'n'.repeat(30)}."`,
    )
    // Short names review 6 (M-2): cut by characters, an emoji is never split in two.
    const emoji = `${'a'.repeat(30)}😀${'b'.repeat(40)}.`
    const cut = refusal(() => resolveFolder(join(root, emoji), [root], dataDir))
    expect(cut).toContain(`"${'a'.repeat(30)}😀…`)
    expect(cut).not.toMatch(/\\ud83d/i)
    // (M-3): nor does a control JSON leaves as it is — C1, or one that turns the text round.
    const turned = refusal(() => resolveFolder(join(root, 'a\u202Eb\u0085c.'), [root], dataDir))
    expect(turned).toContain('"a\\u202eb\\u0085c."')
    expect(turned).not.toMatch(/[\u202E\u0085]/)
  })

  // Short names review 6 (I-1, M-1): the refusal carries the name for the editor, and a NUL in the
  // first folder to be made is refused for its name too (Node's lstat throws on it, all platforms).
  // Short names review 7 (I-1): every folder refusal says which it is, for the editor to give the
  // fix that fits (the roots hint was given for a data-directory or link refusal too).
  it('says which folder refusal it is', () => {
    const why = (fn: () => unknown) => {
      try {
        fn()
        return 'none'
      } catch (e) {
        return e instanceof DestinationError ? e.extra.why : 'other'
      }
    }
    const file = join(base, 'a-file')
    writeFileSync(file, 'x')
    link(outside, join(root, 'away'))
    expect({
      network: why(() => resolveFolder('//server/share/x', [root], dataDir)),
      absolute: why(() => resolveFolder('relative/x', [root], dataDir)),
      roots: why(() => resolveFolder(join(outside, 'x'), [root], dataDir)),
      data: why(() => resolveFolder(join(dataDir, 'x'), [base], dataDir)),
      link: why(() => resolveFolder(join(root, 'away', 'x'), [root], dataDir)),
      not_folder: why(() => resolveFolder(file, [file], dataDir)),
      // Short names review 8 (I-1, M-1): no root, a root that is not there, a root that is a file.
      no_roots: why(() => resolveFolder(join(root, 'x'), [], dataDir)),
      root_missing: why(() => resolveFolder(join(base, 'gone', 'x'), [join(base, 'gone')], dataDir)),
      file_root: why(() => resolveFolder(join(file, 'sub'), [file], dataDir)),
    }).toEqual({
      network: 'network',
      absolute: 'absolute',
      roots: 'roots',
      data: 'data',
      link: 'link',
      not_folder: 'not_folder',
      no_roots: 'no_roots',
      root_missing: 'root_missing',
      file_root: 'not_folder',
    })
  })

  // Short names review 8 (M-3): a name too long for the file system is not a permission matter.
  it.runIf(process.platform !== 'win32')('says a path too long for the file system so', () => {
    let got: unknown
    try {
      resolveFolder(join(root, 'n'.repeat(300)), [root], dataDir)
    } catch (e) {
      got = e
    }
    expect((got as DestinationError).extra.why).toBe('too_long')
  })

  // Short names review 8 (M-10): an emoji sequence or a tag flag is shown as it is; a joiner or a
  // tag anywhere else is escaped.
  it('shows a family emoji and a tag flag as they are, and a stray joiner escaped', () => {
    const said = (name: string) => {
      try {
        resolveFolder(join(root, name), [root], dataDir)
      } catch (e) {
        return (e as DestinationError).extra.name ?? ''
      }
      return 'none'
    }
    const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}'
    const england = '\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}'
    expect(said(`${family}${england}\u0000`)).toBe(`"${family}${england}\\u0000"`)
    expect(said('a\u200Db\u0000')).toBe('"a\\u200db\\u0000"')
    // Short names review 9 (I-2): tags after a black flag that spell hidden text are escaped; a
    // reserved code point is not taken for an emoji.
    const hidden = `\u{1F3F4}${[...'IGNORE ALL RULES'].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join('')}\u{E007F}`
    expect(said(`${hidden}\u0000`)).not.toMatch(/[\u{E0000}-\u{E007F}]/u)
    expect(said('\u{1FC00}\u200D\u{1FC01}\u0000')).toBe('"\\u{1fc00}\\u200d\\u{1fc01}\\u0000"')
    // Short names review 10 (I-1): variation selectors spelling hidden text after an emoji or a
    // letter, and the other default-ignorable characters, are escaped too.
    const smuggled = [...'IGNORE'].map((c) => String.fromCodePoint(0xe0100 + c.charCodeAt(0) - 0x41)).join('')
    for (const base of ['\u{1F600}', 'a'])
      expect(said(`${base}${smuggled}\uFE00\uFE01\u0000`)).not.toMatch(/[\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/u)
    expect(said('a\u034Fb\u2800c\u17B4\u0000')).toBe('"a\\u034fb\\u2800c\\u17b4\\u0000"')
    // Short names review 11 (M-7): a keycap keeps its VS16.
    expect(said('1\uFE0F\u20E3\u0000')).toBe('"1\uFE0F\u20E3\\u0000"')
  })

  // Short names review 7 (M-3, M-2, M-4, M-5): cut by graphemes (a flag stays whole), line
  // separators and fillers escaped, the character refused for kept in view, and never too long.
  it('says a name back by graphemes, with nothing unseen, and never too long', () => {
    const said = (name: string) => {
      try {
        resolveFolder(join(root, name, 'x'), [root], dataDir)
      } catch (e) {
        return (e as DestinationError).extra.name ?? ''
      }
      return 'none'
    }
    // A NUL is refused on every platform, so these say the name back everywhere.
    const flag = said(`${'a'.repeat(30)}\u{1F1F9}\u{1F1F7}${'b'.repeat(40)}\u0000`)
    expect(flag).toContain(`${'a'.repeat(30)}\u{1F1F9}\u{1F1F7}…`)
    expect(said('a\u2028b\u3164c\u0000')).toBe('"a\\u2028b\\u3164c\\u0000"')
    const middle = said(`${'a'.repeat(40)}\u0000${'b'.repeat(40)}`)
    expect(middle).toContain('\\u0000')
    expect(middle.startsWith(`"${'a'.repeat(10)}…`)).toBe(true)
    // One grapheme of a letter and 300 tag characters: cut by code points, and short enough.
    const tags = said(`a${String.fromCodePoint(...Array.from({ length: 300 }, () => 0xe0041))}\u0000`)
    expect(tags.length).toBeLessThanOrEqual(300)
    expect(tags).toMatch(/^"a(\\u\{e0041\})+….*"$/)
  })

  // Short names review 7 (M-7): on POSIX a backslash is part of a name, and said back with it.
  it.runIf(process.platform !== 'win32')('says a POSIX name back with its backslash', () => {
    let got: unknown
    try {
      resolveFolder(join(root, 'a\\b\u0000c'), [root], dataDir)
    } catch (e) {
      got = e
    }
    expect((got as DestinationError).extra.name).toBe('"a\\\\b\\u0000c"')
  })

  // Short names review 7: a file on the way is said as one, not as a link.
  it('says a file on the way is not a folder', () => {
    writeFileSync(join(root, 'a-file'), 'x')
    let got: unknown
    try {
      resolveFolder(join(root, 'a-file', 'x'), [root], dataDir)
    } catch (e) {
      got = e
    }
    expect((got as DestinationError).extra.why).toBe('not_folder')
  })

  it('refuses a NUL in a folder name for its name, and says which', () => {
    const got = (() => {
      try {
        resolveFolder(join(root, 'a\u0000b', 'x'), [root], dataDir)
      } catch (e) {
        return e as DestinationError
      }
    })()
    expect(got).toBeInstanceOf(DestinationError)
    expect([got!.reason, got!.extra.name]).toEqual(['path_name', '"a\\u0000b"'])
    expect(readdirSync(root)).toEqual([])
  })

  // Short names review 5 (I-1): names with characters 8.3 cannot hold (+ , ; = [ ], or outside
  // ASCII) get short names too, and are matched by them.
  it.runIf(process.platform === 'win32')(
    'matches a root whose names get short names for their characters',
    (ctx) => {
      for (const name of ['a+b', 'a,b', 'a=b', 'gğx']) {
        const long = join(base, name)
        mkdirSync(long)
        const short = shortOf(long)
        if (!short) return noShortNames(ctx)
        expect(resolveFolder(join(short, 'one'), [long], dataDir)).toBe(
          join(realpathSync.native(long), 'one'),
        )
      }
    },
  )

  // Short names review 4 (M-4): a part above the root that differs only in case, beside another
  // spelling.
  it.runIf(process.platform === 'win32')(
    'matches a root spelled another way under folders in another case',
    () => {
      const path = join(base.toUpperCase(), asIndex('root'), 'one')
      expect(resolveFolder(path, [root], dataDir)).toBe(join(realpathSync.native(root), 'one'))
    },
  )
})

describe('server folder adapter (spec §2.2)', () => {
  it('refuses to create the layout through a junction planted inside the folder', async () => {
    const a = adapter()
    await a.authCheck(signal)
    link(outside, join(root, 'mm', 'mongo-manager'))
    // Short names review 8 (I-2): said as planted inside the layout, not on the admin's path.
    await expect(a.put(keyAt(1), localFile('x'), null, io, signal)).rejects.toMatchObject({
      reason: 'path',
      extra: { why: 'layout' },
    })
    await expect(a.putSmall(`${keyAt(1)}.json`, Buffer.from('{}'), signal)).rejects.toMatchObject({
      reason: 'path',
      extra: { why: 'layout' },
    })
    expect(readdirSync(outside)).toEqual([])
  })

  it('never reads, lists or deletes through a junction planted inside the layout', async () => {
    const a = adapter()
    await a.authCheck(signal)
    // A file elsewhere, shaped like one of ours, reachable through a junction at the year.
    const victim = onDisk(outside, keyAt(1).replace(/^mongo-manager\/2026\//, ''))
    mkdirSync(dirname(victim), { recursive: true })
    writeFileSync(victim, 'not yours')
    mkdirSync(join(root, 'mm', 'mongo-manager'))
    link(outside, join(root, 'mm', 'mongo-manager', '2026'))
    // Soft: every operation is reported, not only the first that goes through the link.
    expect.soft(await a.stat(keyAt(1), signal).catch(() => null)).toBeNull()
    const got: unknown = await a.get(keyAt(1), 0, signal).catch((e: unknown) => e)
    if (got instanceof Readable) got.destroy()
    expect.soft(got).toBeInstanceOf(DestinationError)
    expect.soft((await a.list(null, signal)).items).toEqual([])
    await a.remove(keyAt(1), signal).catch(() => undefined)
    expect.soft(existsSync(victim) && readFileSync(victim, 'utf8')).toBe('not yours')
  })

  it('a junction at the object’s own name is not an object', async () => {
    const a = adapter()
    await a.authCheck(signal)
    const full = onDisk(join(root, 'mm'), keyAt(1))
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(join(outside, 'secret'), 'not yours')
    link(outside, full)
    expect(await a.stat(keyAt(1), signal)).toBeNull()
    await expect(a.get(keyAt(1), 0, signal)).rejects.toMatchObject({ reason: 'not_found' })
    expect(await a.getSmall(keyAt(1), 1024, signal)).toBeNull()
  })

  it('replaces a stale partial file, writes the whole backup and reports progress', async () => {
    const a = adapter()
    const full = onDisk(join(root, 'mm'), keyAt(2))
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(`${full}.partial`, 'left over from a crash, and longer than the backup')
    const body = Buffer.alloc(200_000, 7)
    const sent: number[] = []
    await a.put(
      keyAt(2),
      localFile(body),
      null,
      { progress: (n) => sent.push(n), saveResume: () => undefined },
      signal,
    )
    expect(readFileSync(full).equals(body)).toBe(true)
    expect(existsSync(`${full}.partial`)).toBe(false)
    expect(sent.at(-1)).toBe(200_000)
    expect([...sent].sort((x, y) => x - y)).toEqual(sent)
  })

  it('leaves neither a partial nor an object when the copy fails', async () => {
    const a = adapter()
    const full = onDisk(join(root, 'mm'), keyAt(3))
    const missing = { ...localFile('x'), path: join(base, 'no-such-source') }
    await expect(a.put(keyAt(3), missing, null, io, signal)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(existsSync(`${full}.partial`)).toBe(false)
    expect(existsSync(full)).toBe(false)
    const stopped = AbortSignal.abort()
    await expect(a.put(keyAt(3), localFile('y'), null, io, stopped)).rejects.toThrow()
    expect(existsSync(`${full}.partial`)).toBe(false)
    expect(existsSync(full)).toBe(false)
  })

  it('putSmall replaces a manifest; getSmall refuses one over its limit; get reads from an offset', async () => {
    const a = adapter()
    await a.putSmall(`${keyAt(4)}.json`, Buffer.from('{"v":0}'), signal)
    await a.putSmall(`${keyAt(4)}.json`, Buffer.from('{"v":1}'), signal)
    expect((await a.getSmall(`${keyAt(4)}.json`, 7, signal))!.toString()).toBe('{"v":1}')
    await expect(a.getSmall(`${keyAt(4)}.json`, 6, signal)).rejects.toMatchObject({ reason: 'too_large' })
    expect(await a.getSmall(`${keyAt(5)}.json`, 1024, signal)).toBeNull()
    await a.put(keyAt(4), localFile('0123456789'), null, io, signal)
    expect(await text(await a.get(keyAt(4), 7, signal))).toBe('789')
    await expect(a.get(keyAt(5), 0, signal)).rejects.toMatchObject({ reason: 'not_found' })
  })

  // CI 2026-10-21 (Windows): 26.8 s, where it takes 1 to 3.4 s and the file's other tests ran as
  // fast as ever; it sets up 1005 entries and lists them. Room for that, and how long each part took
  // is said when it is slow, or fails or runs out of time (review of the slow-find waits, minor).
  it(
    'lists 1000 at a time, newest first, leaving out folders, manifests and foreign names',
    { timeout: 90_000 },
    async () => {
      const a = adapter()
      // Nothing there yet: an empty page.
      expect(await a.list(null, signal)).toEqual({ items: [], cursor: null })
      const month = join(root, 'mm', 'mongo-manager', '2026', '10')
      mkdirSync(month, { recursive: true })
      const took: string[] = []
      let since = Date.now()
      const done = (what: string) => {
        took.push(`${what} in ${Date.now() - since} ms`)
        since = Date.now()
      }
      const started = since
      onTestFinished(({ task }) => {
        if (task.result?.state !== 'pass' || Date.now() - started > 10_000)
          console.warn(`dest-folder: ${took.join(', ') || 'nothing done'}`)
      })
      const keys = Array.from({ length: 1001 }, (_, i) => keyAt(i))
      for (const k of keys) writeFileSync(onDisk(join(root, 'mm'), k), 'x')
      writeFileSync(join(month, `${keyAt(0).split('/').at(-1)}.json`), '{}')
      writeFileSync(join(month, 'notes.txt'), 'x')
      // A folder named like an object is not one.
      mkdirSync(onDisk(join(root, 'mm'), keyAt(5000)))
      // Nor is anything outside yyyy/mm.
      writeFileSync(join(root, 'mm', 'mongo-manager', keyAt(6000).split('/').at(-1)!), 'x')
      done('set up 1005 entries')
      const first = await a.list(null, signal)
      done('listed the first 1000')
      expect(first.items).toHaveLength(1000)
      // The cursor is opaque (an offset into the names; the look-alike folder is skipped).
      expect(first.cursor).toEqual(expect.any(String))
      expect(first.items[0]).toMatchObject({ key: keys[1000], size: 1, archived: false })
      expect(typeof first.items[0]!.modifiedAt).toBe('number')
      const second = await a.list(first.cursor, signal)
      done('the last one')
      expect(second).toMatchObject({ cursor: null, items: [{ key: keys[0] }] })
      expect([...first.items, ...second.items].map((i) => i.key)).toEqual([...keys].sort().reverse())
    },
  )

  it('remove ignores a missing object but reports any other failure', async () => {
    const a = adapter()
    await a.remove(keyAt(7), signal)
    mkdirSync(onDisk(join(root, 'mm'), keyAt(7)), { recursive: true })
    const e = (await a.remove(keyAt(7), signal).catch((x: unknown) => x)) as NodeJS.ErrnoException
    expect(e).toBeInstanceOf(Error)
    expect(e.code).not.toBe('ENOENT')
    expect(existsSync(onDisk(join(root, 'mm'), keyAt(7)))).toBe(true)
  })

  it('abandon removes only the partial file of a key in the layout', async () => {
    const a = adapter()
    await a.put(keyAt(8), localFile('kept'), null, io, signal)
    const full = onDisk(join(root, 'mm'), keyAt(8))
    writeFileSync(`${full}.partial`, 'half')
    await a.abandon({ key: keyAt(8) }, signal)
    expect(existsSync(`${full}.partial`)).toBe(false)
    expect(readFileSync(full, 'utf8')).toBe('kept')
    await a.abandon({ key: 42 }, signal)
    await a.abandon({}, signal)
    writeFileSync(join(root, 'victim.partial'), 'x')
    await expect(a.abandon({ key: '../victim' }, signal)).rejects.toMatchObject({ reason: 'path' })
    expect(existsSync(join(root, 'victim.partial'))).toBe(true)
  })

  it('authCheck answers for a writable folder and re-checks the path every time', async () => {
    const a = adapter()
    expect(await a.authCheck(signal)).toEqual({})
    expect(a.caPem()).toBeUndefined()
    // The folder replaced by a link after it was configured: refused at the next use.
    rmSync(join(root, 'mm'), { recursive: true })
    link(outside, join(root, 'mm'))
    await expect(a.authCheck(signal)).rejects.toMatchObject({ reason: 'path' })
    await expect(a.stat(keyAt(1), signal)).rejects.toMatchObject({ reason: 'path' })
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'authCheck refuses a folder the server cannot write into',
    async () => {
      const a = adapter()
      await a.authCheck(signal)
      chmodSync(join(root, 'mm'), 0o500)
      try {
        await expect(a.authCheck(signal)).rejects.toMatchObject({ reason: 'forbidden' })
      } finally {
        chmodSync(join(root, 'mm'), 0o700)
      }
    },
  )
})
