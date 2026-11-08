// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { createHash } from 'node:crypto'
import { accessSync, constants, createReadStream, lstatSync, mkdirSync, realpathSync } from 'node:fs'
import type { BigIntStats, Stats } from 'node:fs'
import { lstat, open, readdir, rename, rm, unlink, type FileHandle } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { safeEqual } from '../../http/security'
import { assertSafePath, isSafeKey, layoutRoot } from './layout'
import type { FolderRefusal } from '@mongo-manager/shared'
import { DestinationError, offsetOf, type DestinationAdapter, type RemoteItem } from './types'
import { fullPath } from '../series'

/**
 * Why a folder is refused. Short names review 7 (I-1): the code goes with the refusal
 * (extra.why), so the editor says which it is and gives the fix that fits, not one for all.
 */
const WHY: Record<FolderRefusal, string> = {
  // Short names review 8 (I-1): no root at all, or the root the path is in cannot be read, is not
  // "not inside MM_BACKUP_FOLDER_ROOTS".
  no_roots: 'MM_BACKUP_FOLDER_ROOTS is not set',
  root_missing: 'its root in MM_BACKUP_FOLDER_ROOTS does not exist or cannot be read',
  network: 'network and device paths are not allowed',
  absolute: 'the path must be absolute',
  roots: 'it is not inside MM_BACKUP_FOLDER_ROOTS',
  data: 'it is inside the data directory',
  create: 'the folder could not be created',
  // Review 8 (M-3): what mkdir says, where it is not a matter of permission.
  too_long: 'the path is too long for the file system',
  read_only: 'the file system is read-only',
  link: 'a link or junction is on the way',
  outside: 'it leads outside MM_BACKUP_FOLDER_ROOTS',
  not_folder: 'a file is on the way, or it is not a folder',
  // Review 8 (I-2): a link, junction or file planted inside the mongo-manager folder itself.
  // Review 11 (M-3): a folder where a backup file goes is one too.
  layout: 'something that does not belong is inside its mongo-manager folder',
}
const bad = (why: FolderRefusal) =>
  new DestinationError('path', `This folder cannot be used: ${WHY[why]}`, { why })
/** Review 8 (I-2, M-3): a folder that could not be made, by what the file system said. */
const notMade = (e: unknown): DestinationError => {
  const code = (e as NodeJS.ErrnoException).code
  return bad(code === 'ENAMETOOLONG' ? 'too_long' : code === 'EROFS' ? 'read_only' : 'create')
}
/**
 * Review 8 (I-2): a write the file system refused, said as a destination's refusal (a full disk is
 * a full destination), not passed on raw to be called the provider's. Review 9 (I-1): only the
 * destination's own steps go through it — `toFolder` — never the local backup file's read.
 */
const writeRefusal = (e: unknown): unknown => {
  if (e instanceof DestinationError) return e
  const code = (e as NodeJS.ErrnoException).code
  if (code === 'ENOSPC' || code === 'EDQUOT')
    return new DestinationError('quota', 'The folder’s disk is full, or its quota is used up')
  // Review 9 (M-2): a folder planted where a file of ours goes.
  if (code === 'EISDIR' || code === 'ERR_FS_EISDIR') return bad('layout')
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS' || code === 'ENAMETOOLONG') return notMade(e)
  return e
}
const inside = (parent: string, child: string) => {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}
const PAGE = 1000
/**
 * How many of a page's objects are looked at together: a few, so DNS lookups and key derivation,
 * which share libuv's pool (4 threads), wait behind at most one small batch on a slow network
 * folder (second and third reviews of the slow-find waits).
 */
const STAT_BATCH = 8
/** Like the other adapters: a listing holds at most this many objects (the newest). */
const MAX_ITEMS = 10_000
/** Phase 3d-3b final review (A18): the native real path resolves Windows 8.3 short names too. */
const realOf = (p: string) => (realpathSync.native ?? realpathSync)(p)
const lstatOrNull = (p: string): Stats | null => lstatSync(p, { throwIfNoEntry: false }) ?? null
/** The entry itself (a link is not followed), with its file id; null where it cannot be read. */
const entryOf = (p: string) => {
  try {
    return lstatSync(p, { bigint: true, throwIfNoEntry: false }) ?? null
  } catch {
    return null
  }
}
const sameEntry = (a: BigIntStats, b: BigIntStats) => a.ino !== 0n && a.ino === b.ino && a.dev === b.dev
const realQuiet = (p: string) => {
  try {
    return realOf(p)
  } catch {
    return null
  }
}
/** A part of the walk, or null where there is none; one that cannot be read is a refusal. */
const lstatOfPart = (p: string) => {
  try {
    return lstatOrNull(p)
  } catch (e) {
    // CI 2026-10-21 (Linux): lstat says ENAMETOOLONG before any mkdir does; said as what it is.
    throw notMade(e)
  }
}
/** The real path of a part of the walk; one that cannot be read is a refusal, not a raw error. */
const realOfPart = (p: string) => {
  const real = realQuiet(p)
  if (real === null) throw bad('create')
  return real
}
/** A path and the folders above it, the drive (or /) first. */
const fromTop = (p: string) => {
  const out = [p]
  while (dirname(out[0]!) !== out[0]) out.unshift(dirname(out[0]!))
  return out
}

/** NTFS's stream spellings of a folder: name::$INDEX_ALLOCATION, name:$I30:$INDEX_ALLOCATION. */
const withoutStream = (name: string) => name.replace(/:(\$I30)?:\$INDEX_ALLOCATION$/i, '')
/**
 * A name that fits 8.3 as it is: such a name has no short name of its own beside it. Short names
 * review 5 (I-1): only ASCII in 8.3's own set — + , ; = [ ], a space or a letter outside ASCII
 * (gğx → GXA0D6~1) gets a short name of its own.
 */
const SHORT_PART = "[A-Za-z0-9!#$%&'()@^_`{}~-]"
const FITS_83 = new RegExp(`^${SHORT_PART}{1,8}(\\.${SHORT_PART}{1,3})?$`)
const fits83 = (name: string) => FITS_83.test(name)
/**
 * Short names review 4 (M-3): a part that may be another spelling of ours — the same name but for
 * case or a stream suffix, a short name (8.3-shaped, where ours does not fit 8.3), or the long name
 * of ours where ours is a generated short name. Short names set by hand (fsutil) are found where
 * they look like one.
 */
const mayBeSpelling = (theirs: string, ours: string) => {
  const a = withoutStream(basename(theirs))
  const b = withoutStream(basename(ours))
  return a.toUpperCase() === b.toUpperCase() || (fits83(a) && !fits83(b)) || (b.includes('~') && !fits83(a))
}

/**
 * Short names review 2 (I-1): the part of `path` that is the folder `spelled`, written another
 * way (8.3 short names, NTFS's ::$INDEX_ALLOCATION), or null. Other
 * spellings are matched only on Windows: elsewhere a lookup goes into a mount (a dead NFS mount, an
 * automounter), and a folder spelled another way there (macOS case, a vfat mount) is refused.
 * Matched from the top, part by part, against the folders `spelled` itself goes through: a part is
 * looked at only inside a folder already found to be the same entry, and only when its name may be
 * another spelling of that folder's part — so no link outside the roots is followed (a share; an
 * lstat opens the link itself), only names that may be another spelling are opened, and no disk no
 * root is on is touched. A link above a root found in the path is a different entry, so it is not
 * matched. `entry` looks a path up once per call.
 */
function sameFolderAs(
  path: string,
  spelled: string,
  entry: (p: string) => BigIntStats | null,
): string | null {
  const top = (p: string) => parse(p).root.toLowerCase()
  if (process.platform !== 'win32' || top(path) !== top(spelled)) return null
  const ours = fromTop(spelled)
  const theirs = fromTop(path)
  if (theirs.length < ours.length) return null
  for (let i = 1; i < ours.length; i++) {
    if (!mayBeSpelling(theirs[i]!, ours[i]!)) return null
    const a = entry(theirs[i]!)
    const b = entry(ours[i]!)
    if (!a || !b || !sameEntry(a, b)) return null
  }
  return theirs[ours.length - 1]!
}
/**
 * Short names review 3 (M-2): a name Node makes as given (\\?\) but Explorer, cmd and robocopy may
 * not handle: a trailing dot or space, a device name (with an extension too, or spaces before it,
 * as Windows 10 and Server still read it), a stream or other colon (review 4, I-1:
 * nul::$INDEX_ALLOCATION made nul). Review 5 (M-2): and what mkdir refuses — < > " | ? *, control
 * characters, more than 255 characters — so that no folder before it is made either.
 */
const awkwardOnWindows = (name: string) =>
  /[. ]$/.test(name) ||
  /[:<>"|?*]/.test(name) ||
  [...name].some((c) => c.charCodeAt(0) < 0x20) ||
  name.length > 255 ||
  /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$) *(\..*)?$/i.test(name)
/**
 * What is escaped in a name said back, beyond what JSON escapes. Short names reviews 6 (M-3) and 7
 * (M-2): control and format characters (C1, the bidi ones that turn text round), line and
 * paragraph separators, private-use and unassigned ones, and the Hangul fillers that show as
 * nothing. Review 10 (I-1): every default-ignorable one — variation selectors spell hidden text one
 * byte each after any letter or emoji — and the braille blank, as check-forbidden refuses them.
 */
const UNSEEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cn}\p{Default_Ignorable_Code_Point}\u2800]/gu
const escapeUnseen = (s: string) =>
  s.replace(UNSEEN, (c) => {
    const hex = c.codePointAt(0)!.toString(16)
    return hex.length > 4 ? `\\u{${hex}}` : `\\u${hex.padStart(4, '0')}`
  })
/**
 * Short names review 8 (M-10): an emoji sequence joined by U+200D (a family) or a subdivision flag
 * (the England flag) is shown as it is: its joiner and tags are part of it. Only a whole grapheme
 * of that shape; a joiner or tag anywhere else is escaped. Review 9 (I-2): a flag's tags are a
 * subdivision code only (two letters, then one to three letters or digits), so no text can be
 * spelled in them, and no unassigned code point is taken for an emoji.
 */
const PICTO = '(?!\\p{Cn})\\p{Extended_Pictographic}(?:\\uFE0F|\\p{Emoji_Modifier})?'
const FLAG = '\\u{1F3F4}[\\u{E0061}-\\u{E007A}]{2}[\\u{E0030}-\\u{E0039}\\u{E0061}-\\u{E007A}]{1,3}\\u{E007F}'
// Review 11 (M-7): a keycap (1, then VS16, then the enclosing keycap) is an emoji too.
const KEYCAP = '[#*0-9]\\uFE0F\\u20E3'
const EMOJI = new RegExp(`^(?:${PICTO}(?:\\u200D${PICTO})*|${FLAG}|${KEYCAP})$`, 'u')
const escaped = (s: string) => {
  const parts = splitGraphemes(JSON.stringify(s))
  return parts.map((g) => (EMOJI.test(g) ? g : escapeUnseen(g))).join('')
}
/**
 * Review 8 (M-11): Intl.Segmenter where Node has it (full or system ICU); code points where it
 * does not, so a Node built without Intl still loads this module.
 */
const segmenter =
  typeof Intl === 'object' && typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null
const splitGraphemes = (s: string) =>
  segmenter ? Array.from(segmenter.segment(s), (x) => x.segment) : Array.from(s)
/** A character a name is refused for wherever it is (not only at an end). */
const troubled = (g: string) => /[:<>"|?*]/.test(g) || [...g].some((c) => c.charCodeAt(0) < 0x20)
/** At most `n` units from each end; the first troubled one kept in view between them. */
function cut(units: string[], n: number, at: number): string {
  if (units.length <= 2 * n + 2) return units.join('')
  if (at < n || at >= units.length - n) return [...units.slice(0, n), '…', ...units.slice(-n)].join('')
  const k = Math.max(1, Math.floor(n / 3))
  return [...units.slice(0, k), '…', ...units.slice(at - k, at + k + 1), '…', ...units.slice(-k)].join('')
}
/** Short names review 7 (M-5): what is said back, escaped, is never longer than this. */
const MAX_SAID = 300
/**
 * A name said back: quoted and escaped, its start and its end if long (Short names review 6), cut
 * by graphemes so that no emoji, flag or accented letter is split (review 7, M-3), keeping the
 * character it is refused for in view (M-4), and never over MAX_SAID once escaped (M-5) — by code
 * points if one grapheme alone is too long.
 */
function quoted(name: string): string {
  for (const units of [splitGraphemes(name), Array.from(name)]) {
    const at = units.findIndex(troubled)
    // 31 from each end: a name of 64 or fewer is said whole.
    for (const n of [31, 24, 16, 8, 4, 2]) {
      const said = escaped(cut(units, n, at))
      if (said.length <= MAX_SAID) return said
    }
  }
  return '"…"'
}
/** Short names review 6 (I-1): a refusal for a name carries it, for the editor to show. */
const badName = (name: string, words: string) => {
  const said = quoted(name)
  // A function, so that a $& or $' in the name is not read as a replacement pattern.
  return new DestinationError(
    'path_name',
    `This folder cannot be used: ${words.replaceAll('%', () => said)}`,
    {
      name: said,
    },
  )
}
const toFolder = async <T>(step: () => Promise<T>): Promise<T> => {
  try {
    return await step()
  } catch (e) {
    throw writeRefusal(e)
  }
}
const stopped = (signal: AbortSignal) => {
  if (signal.aborted) throw new DestinationError('aborted', 'The request was stopped')
}

/**
 * Phase 3d-3b spec §2.2: a folder inside one of MM_BACKUP_FOLDER_ROOTS, never inside the data
 * directory, never through a link or junction, never a UNC or device path. Checked at every use,
 * and before anything is created (a link must not make us create directories elsewhere).
 */
export function resolveFolder(path: string, roots: readonly string[], dataDir: string): string {
  if (roots.length === 0) throw bad('no_roots')
  if (/^[\\/]{2}/.test(path)) throw bad('network')
  if (!fullPath(path)) throw bad('absolute')
  // Short names review 6 (M-1): a NUL, which no file system takes (and Node's lstat throws on, so
  // the name check would never see it), anywhere in the path, before any file system call. Review
  // 7 (M-7): a backslash is a separator on Windows only, so the name said back is the one given.
  const nul = path.split(process.platform === 'win32' ? /[\\/]/ : /\//).find((p) => p.includes('\u0000'))
  if (nul !== undefined) throw badName(nul, '% cannot be a folder name')
  let wanted = resolve(path)
  const known = roots.flatMap((r) => {
    try {
      return [{ given: resolve(r), real: realOf(r) }]
    } catch {
      return []
    }
  })
  // A root is matched as written or by its real path (e.g. /tmp and /private/tmp on macOS).
  let match = known.find((r) => inside(r.given, wanted) || inside(r.real, wanted))
  // CI 2026-10-21: or spelled another way, as by Windows 8.3 short names (C:\Users\RUNNER~1\…).
  // The path is then spelled on from the root, so the walk starts there. This is about spelling,
  // not safety: the walk and the checks after it keep the folder inside the root however it was
  // written.
  const entries = new Map<string, BigIntStats | null>()
  const entry = (p: string) => {
    if (!entries.has(p)) entries.set(p, entryOf(p))
    return entries.get(p)!
  }
  for (const r of match ? [] : known) {
    for (const spelled of [r.given, r.real]) {
      const at = sameFolderAs(wanted, spelled, entry)
      // Short names review 2 (M-2): a file id is not proof alone — the real path must be the
      // root's too.
      const realAt = at === null ? null : realQuiet(at)
      if (at === null || realAt === null || relative(r.real, realAt) !== '') continue
      match = r
      wanted = join(spelled, relative(at, wanted))
      break
    }
    if (match) break
  }
  // Review 8 (I-1): inside a root as written that cannot be read is not "not inside".
  if (!match && roots.some((r) => !known.some((k) => k.given === resolve(r)) && inside(resolve(r), wanted)))
    throw bad('root_missing')
  if (!match) throw bad('roots')
  const root = inside(match.given, wanted) ? match.given : match.real
  let data: string
  try {
    data = realOf(dataDir)
  } catch {
    data = resolve(dataDir)
  }
  const inData = (p: string) => [data, resolve(dataDir)].some((d) => inside(d, p))
  // Phase 3d-3b final review (A18): what is written lives under <folder>/mongo-manager — that layout
  // root must not be the data directory, nor lie inside it or hold it.
  const touchesData = (folder: string) => {
    const layout = join(folder, layoutRoot(''))
    return inData(folder) || inData(layout) || [data, resolve(dataDir)].some((d) => inside(layout, d))
  }
  // Short names review 1 (I-1): the root, and every part after it, by its real path too — spelled
  // another way (a short name, a link above it) it may still be in the data directory, and nothing
  // is created beneath one that is.
  if (touchesData(wanted) || inData(match.real)) throw bad('data')
  // Review 8 (M-1): a root that is a file is said so before anything beneath it is tried.
  if (!lstatOfPart(match.real)?.isDirectory()) throw bad('not_folder')
  // Created one level at a time, each checked: a link planted while the folder is being made is
  // found before anything is created through it (mkdir recursive would follow it).
  let at = root
  const parts = relative(root, wanted).split(sep).filter(Boolean)
  let named = process.platform !== 'win32'
  for (const [i, part] of parts.entries()) {
    at = join(at, part)
    let st = lstatOfPart(at)
    if (!st) {
      // Short names review 4 (M-1): the names to be made, all of them before the first is — a
      // folder that is there already is the user's, and stays usable whatever its name.
      const awkward = named ? undefined : parts.slice(i).find(awkwardOnWindows)
      named = true
      if (awkward !== undefined) {
        // Short names review 5 (M-4): its own reason, so the editor says the name is the trouble.
        throw badName(awkward, 'Windows cannot use % as a folder name')
      }
      try {
        mkdirSync(at, { mode: 0o700 })
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw notMade(e)
      }
      st = lstatOfPart(at)
      if (!st) throw bad('create')
    }
    // Short names review 7: a file on the way is said as one, not as a link.
    if (st.isSymbolicLink()) throw bad('link')
    if (!st.isDirectory()) throw bad('not_folder')
    // Short names review 3 (M-3): a folder swapped for a junction after its check would take the
    // next one outside the root; its real path is checked before anything is made beneath it. That
    // narrows the window, it does not close it: Node cannot make a folder relative to an open handle.
    const realAt = realOfPart(at)
    if (!inside(match.real, realAt)) throw bad('outside')
    if (inData(realAt)) throw bad('data')
  }
  const real = realOfPart(wanted)
  if (!inside(match.real, real)) throw bad('outside')
  // Short names review 2 (M-6): a root that is a file, asked for itself, is no folder.
  if (!lstatOfPart(real)?.isDirectory()) throw bad('not_folder')
  if (touchesData(real)) throw bad('data')
  return real
}

export function createFolderAdapter(opts: {
  path: string
  roots: readonly string[]
  dataDir: string
}): DestinationAdapter {
  const dir = () => resolveFolder(opts.path, opts.roots, opts.dataDir)
  const pathOf = (key: string, create = false) => {
    const parts = assertSafePath(key)
    const base = dir()
    const full = join(base, ...parts)
    // Every use, not only a write: a link or junction planted later inside the layout must not let
    // a read, a listing or a delete reach outside the folder. Created one level at a time on writes.
    let at = base
    for (const p of parts.slice(0, -1)) {
      at = join(at, p)
      let st
      try {
        st = lstatSync(at)
      } catch {
        if (!create) return full
        try {
          mkdirSync(at, { mode: 0o700 })
        } catch (e) {
          // Review 9 (M-1): made meanwhile by another process: looked at like one already there.
          if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw notMade(e)
          // Review 10 (M-4): a lookup that fails here is a folder that cannot be made, not raw.
          try {
            st = lstatOrNull(at)
          } catch (again) {
            throw notMade(again)
          }
          if (!st) throw notMade(e)
          if (st.isSymbolicLink() || !st.isDirectory()) throw bad('layout')
        }
        continue
      }
      // Review 8 (I-2): planted inside the layout, not on the way to the folder the admin gave.
      if (st.isSymbolicLink() || !st.isDirectory()) throw bad('layout')
    }
    return full
  }
  /** Review 10 (M-4): a close the file system refuses is mapped too, and its partial removed. */
  const closed = async (handle: FileHandle, partial: string) => {
    try {
      await handle.close()
    } catch (e) {
      await rm(partial, { force: true }).catch(() => undefined)
      throw writeRefusal(e)
    }
  }
  /** Review 9 (M-2): a rename the file system refuses is mapped, and its partial removed. */
  const renamed = async (partial: string, full: string) => {
    try {
      await rename(partial, full)
    } catch (e) {
      await rm(partial, { force: true }).catch(() => undefined)
      // Review 11 (M-4): a folder planted at the name while the file was written (Windows' rename
      // says EPERM for it) is the layout, as it is before.
      const code = (e as NodeJS.ErrnoException).code
      if (code === 'EPERM' || code === 'EACCES') noFolderAt(full)
      throw writeRefusal(e)
    }
  }
  /** Review 10 (M-1): a folder (or anything not a file) planted at our file's own name. */
  const noFolderAt = (full: string) => {
    let st: Stats | null
    try {
      st = lstatOrNull(full)
    } catch (e) {
      throw notMade(e)
    }
    if (st && !st.isFile()) throw bad('layout')
  }
  const regularFile = (full: string) => {
    try {
      const st = lstatSync(full)
      return st.isFile() && !st.isSymbolicLink() ? st : null
    } catch {
      return null
    }
  }
  /**
   * Phase 3d-3b final review (A19): opened first, then checked — the open file must be a regular
   * file, the path must still lead to that very file (device and inode), and no link may have
   * appeared on the way meanwhile. Checking first and opening after left a window to swap in a link.
   * Null when there is no such object (missing, a folder, a link at its own name).
   */
  async function openRegular(key: string): Promise<{ handle: FileHandle; size: number } | null> {
    const full = pathOf(key)
    let handle: FileHandle
    try {
      // O_NOFOLLOW where the platform has it: a link at the object's own name is not followed.
      handle = await open(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code && ['ENOENT', 'EISDIR', 'ELOOP', 'EPERM', 'ENOTDIR', 'EACCES'].includes(code)) return null
      throw e
    }
    try {
      const opened = await handle.stat()
      pathOf(key) // the parents again: a link planted while opening is refused
      const now = lstatOrNull(full)
      if (
        !opened.isFile() ||
        !now ||
        now.isSymbolicLink() ||
        !now.isFile() ||
        now.ino !== opened.ino ||
        now.dev !== opened.dev
      ) {
        await handle.close()
        return null
      }
      return { handle, size: opened.size }
    } catch (e) {
      await handle.close().catch(() => undefined)
      throw e
    }
  }

  return {
    readBack: true,
    endpoint: () => null,
    caPem: () => undefined,
    async authCheck() {
      const d = dir()
      try {
        accessSync(d, constants.W_OK)
      } catch {
        throw new DestinationError('forbidden', 'The server cannot write into this folder')
      }
      return {}
    },
    async put(key, file, _resume, io, signal) {
      const full = pathOf(key, true)
      const existing = regularFile(full)
      if (existing) {
        // Phase 3d-3b final review (A5): a retry after the rename landed finds the object in place.
        // Accepted when it is this very backup (size, then digest — cheap on a local disk); any other
        // file is a conflict and is left alone (the send job removes an object that fails to verify).
        const same =
          existing.size === file.size &&
          (await (async () => {
            const found = await openRegular(key)
            if (!found) return false
            const h = createHash('sha256')
            try {
              for await (const c of found.handle.createReadStream({ autoClose: false, signal }))
                h.update(c as Buffer)
            } finally {
              await found.handle.close()
            }
            return safeEqual(h.digest('hex'), file.sha256)
          })())
        if (!same) throw new DestinationError('conflict', 'An object with this name already exists')
        io.progress(file.size)
        return {}
      }
      noFolderAt(full)
      const partial = `${full}.partial`
      await toFolder(() => rm(partial, { force: true }))
      const handle = await toFolder(() => open(partial, 'wx', 0o600))
      let sent = 0
      try {
        // Written through the handle itself, so it can be fsynced before the rename. Review 9
        // (I-1): the local file's read errors are its own, passed on as they are.
        for await (const chunk of createReadStream(file.path, { signal })) {
          await toFolder(() => handle.write(chunk as Buffer))
          sent += (chunk as Buffer).length
          io.progress(sent)
        }
        await toFolder(() => handle.sync())
      } catch (e) {
        await handle.close().catch(() => undefined)
        await rm(partial, { force: true }).catch(() => undefined)
        throw e
      }
      await closed(handle, partial)
      await renamed(partial, full)
      return {}
    },
    async putSmall(key, body, signal) {
      stopped(signal)
      const full = pathOf(key, true)
      noFolderAt(full)
      const partial = `${full}.partial`
      // Phase 3d-3b final review (A6): removed and created anew ("wx"), like put — opening with "w"
      // would write through a link or a hard link planted at this name.
      await toFolder(() => rm(partial, { force: true }))
      const handle = await toFolder(() => open(partial, 'wx', 0o600))
      try {
        await toFolder(() => handle.writeFile(body))
        await toFolder(() => handle.sync())
      } catch (e) {
        await handle.close().catch(() => undefined)
        await rm(partial, { force: true }).catch(() => undefined)
        throw e
      }
      await closed(handle, partial)
      if (signal.aborted) {
        // Review 10 (M-4): the stop is what is said, whatever the removal does.
        await rm(partial, { force: true }).catch(() => undefined)
        stopped(signal)
      }
      await renamed(partial, full)
    },
    async stat(key) {
      const st = regularFile(pathOf(key))
      return st ? { size: st.size, archived: false } : null
    },
    async get(key, offset) {
      const found = await openRegular(key)
      if (!found) throw new DestinationError('not_found', 'The backup is not in this folder')
      return found.handle.createReadStream({ start: offset })
    },
    async getSmall(key, limit) {
      const found = await openRegular(key)
      if (!found) return null
      try {
        if (found.size > limit) throw new DestinationError('too_large', 'The file is larger than expected')
        return await found.handle.readFile()
      } finally {
        await found.handle.close()
      }
    },
    async list(cursor, signal) {
      const base = dir()
      const items: RemoteItem[] = []
      const top = join(base, ...layoutRoot('').split('/'))
      // Real directories only, never followed through a link or junction (stat would follow one).
      const isDir = (p: string) => {
        try {
          const st = lstatSync(p)
          return st.isDirectory() && !st.isSymbolicLink()
        } catch {
          return false
        }
      }
      // Phase 3d-3b final review (A19): newest first (years and months in descending order), at
      // most MAX_ITEMS objects, and a stop request is honoured between folders.
      const names = async (p: string, shape?: RegExp) => {
        stopped(signal)
        const list = isDir(p) ? await readdir(p).catch(() => [] as string[]) : []
        return (shape ? list.filter((n) => shape.test(n)) : list).sort().reverse()
      }
      // Names first (cheap), newest first; only the page's objects are stat'ed (final gate: a page
      // used to stat every object of the folder). The cursor is an offset into the names.
      const keys: string[] = []
      years: for (const y of await names(top, /^\d{4}$/))
        for (const m of await names(join(top, y), /^\d{2}$/))
          for (const f of await names(join(top, y, m))) {
            const key = `${layoutRoot('')}/${y}/${m}/${f}`
            if (!isSafeKey(key, '')) continue
            keys.push(key)
            if (keys.length >= MAX_ITEMS) break years
          }
      keys.sort((a, b) => (a < b ? 1 : -1))
      let at = offsetOf(cursor)
      // STAT_BATCH at a time (review of the slow-find waits, minor: one after another, each opening
      // a handle on Windows), never more than the page has room for, so the cursor stays where the
      // page ends.
      while (at < keys.length && items.length < PAGE) {
        stopped(signal)
        const batch = keys.slice(at, at + Math.min(STAT_BATCH, PAGE - items.length))
        at += batch.length
        const stats = await Promise.all(
          batch.map((key) => lstat(join(base, ...key.split('/'))).catch(() => null)),
        )
        batch.forEach((key, i) => {
          const st = stats[i]
          // Not a regular file (a folder or a link shaped like a key): skipped, never followed.
          if (st?.isFile()) items.push({ key, size: st.size, modifiedAt: st.mtimeMs, archived: false })
        })
      }
      return { items, cursor: at < keys.length ? String(at) : null }
    },
    async remove(key) {
      await unlink(pathOf(key)).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== 'ENOENT') throw e
      })
    },
    async abandon(resume) {
      if (typeof resume.key === 'string') await rm(`${pathOf(resume.key)}.partial`, { force: true })
    },
  }
}
