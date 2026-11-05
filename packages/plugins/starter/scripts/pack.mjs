#!/usr/bin/env node
/**
 * Packs this plugin for Mongo Manager, with no dependencies (node:zlib and a minimal ustar writer).
 *
 *   node scripts/pack.mjs                     writes <id>-<version>.tgz in the plugin's folder
 *   node scripts/pack.mjs --folder <plugins>  also copies the plugin's files to <plugins>/<id>,
 *                                             e.g. <data-dir>/plugins, to try it before publishing
 *
 * The archive holds the plugin's files at its root, mongo-manager-plugin.json among them, as the app
 * reads an uploaded plugin. Files that are not part of the plugin are left out: hidden files and
 * folders (.git, .github, .gitignore), this scripts folder, node_modules, the AI assistant files,
 * package files and earlier archives. The checks below are the app's own limits; the app checks the
 * manifest in full when the plugin is installed.
 */
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MANIFEST = 'mongo-manager-plugin.json'
const MAX_FILES = 500
const MAX_BYTES = 25 * 1024 * 1024
const MAX_MANIFEST_BYTES = 64 * 1024

/** Never packed: what helps build the plugin but is not part of it. Edit to suit your project. */
const SKIP = new Set([
  'scripts',
  'node_modules',
  'test',
  'tests',
  'CLAUDE.md',
  'AGENTS.md',
  'GEMINI.md',
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
])
const skipped = (name) => name.startsWith('.') || SKIP.has(name) || name.endsWith('.tgz')

// The app's rules for a path inside a plugin (PluginPathSchema).
const PART = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$/
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i
const PROPERTY = /^(__proto__|constructor|prototype)$/i
const plainPath = (p) => {
  const parts = p.split('/')
  return (
    p.length <= 240 &&
    parts.length <= 16 &&
    parts.every((s) => PART.test(s) && !RESERVED.test(s) && !PROPERTY.test(s))
  )
}
const ID = /^[a-z0-9]+(-[a-z0-9]+)*$/
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/

function fail(message) {
  console.error(`pack: ${message}`)
  process.exit(1)
}

/**
 * A plugin file's bytes, opened once and then asked only of that open file, so what is checked is
 * what is packed: never through a link — refused by the open where the system can (O_NOFOLLOW) and,
 * where it cannot (Windows), by the entry's own kind and identity — and only a plain file.
 */
function readPlainFile(full, path) {
  let fd
  try {
    fd = openSync(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  } catch (e) {
    if (e.code === 'ELOOP') fail(`a plugin may not hold links: ${path}`)
    throw e
  }
  try {
    const opened = fstatSync(fd)
    if (!opened.isFile()) fail(`a plugin may hold only files and folders: ${path}`)
    if (constants.O_NOFOLLOW === undefined) {
      const entry = lstatSync(full)
      if (entry.isSymbolicLink() || entry.ino !== opened.ino || entry.dev !== opened.dev)
        fail(`a plugin may not hold links: ${path}`)
    }
    return readFileSync(fd)
  } finally {
    closeSync(fd)
  }
}

/** The plugin's files, by path relative to its folder (`/`-separated), in a stable order. */
function collect() {
  const files = []
  const walk = (rel) => {
    for (const entry of readdirSync(join(ROOT, ...rel.split('/').filter(Boolean)), { withFileTypes: true })) {
      if (skipped(entry.name)) continue
      const path = rel ? `${rel}/${entry.name}` : entry.name
      const full = join(ROOT, ...path.split('/'))
      // The entry's own kind (a link is never followed), then a file read from the one file opened.
      if (entry.isSymbolicLink()) fail(`a plugin may not hold links: ${path}`)
      if (!plainPath(path)) fail(`not a plain path (letters, digits, ".", "_" and "-" only): ${path}`)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile()) files.push({ path, data: readPlainFile(full, path) })
      else fail(`a plugin may hold only files and folders: ${path}`)
    }
  }
  walk('')
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const seen = new Set()
  for (const f of files) {
    const key = f.path.toLowerCase()
    if (seen.has(key)) fail(`a path is given twice (letter case aside): ${f.path}`)
    seen.add(key)
  }
  if (files.length > MAX_FILES) fail(`a plugin holds at most ${MAX_FILES} files (this one: ${files.length})`)
  const bytes = files.reduce((sum, f) => sum + f.data.length, 0)
  if (bytes > MAX_BYTES) fail(`a plugin holds at most 25 MB (this one: ${(bytes / 1048576).toFixed(1)} MB)`)
  return { files, bytes }
}

/** The manifest's essentials; the app checks every field when the plugin is installed. */
function readManifest(files) {
  const file = files.find((f) => f.path === MANIFEST)
  if (!file) fail(`no ${MANIFEST} in ${ROOT}`)
  if (file.data.length > MAX_MANIFEST_BYTES) fail(`${MANIFEST} is over 64 KB`)
  let manifest
  try {
    manifest = JSON.parse(file.data.toString('utf8'))
  } catch {
    fail(`${MANIFEST} is not valid JSON`)
  }
  if (typeof manifest.id !== 'string' || manifest.id.length > 64 || !ID.test(manifest.id))
    fail('the id is lowercase letters and digits, dash-separated, at most 64 characters')
  if (typeof manifest.version !== 'string' || !VERSION.test(manifest.version))
    fail('the version is major.minor.patch (semantic versioning)')
  if (typeof manifest.entry !== 'string' || !manifest.entry.endsWith('.html'))
    fail('the entry is an .html file of the plugin')
  if (!files.some((f) => f.path === manifest.entry))
    fail(`the entry ${manifest.entry} is not among the files`)
  return manifest
}

/** The digest the app shows an administrator: the SHA-256 of every path with its own SHA-256. */
function digestOf(files) {
  const lines = files
    .map((f) => f.path)
    .sort()
    .map(
      (p) =>
        `${p}\u0000${createHash('sha256')
          .update(files.find((f) => f.path === p).data)
          .digest('hex')}\n`,
    )
  return createHash('sha256').update(lines.join('')).digest('hex')
}

// ---- A minimal ustar archive: one header block per file, its bytes padded to 512, two empty blocks.

const BLOCK = 512

function octal(value, width) {
  return `${value.toString(8).padStart(width - 1, '0')}\0`
}

/** A path as ustar's name (100 bytes) and prefix (155 bytes), split on a "/". */
function splitPath(path) {
  if (path.length <= 100) return { name: path, prefix: '' }
  for (let i = path.length - 1; i > 0; i--) {
    if (path[i] !== '/') continue
    const prefix = path.slice(0, i)
    const name = path.slice(i + 1)
    if (prefix.length <= 155 && name.length <= 100 && name.length > 0) return { name, prefix }
  }
  fail(`a path is too long for the archive: ${path}`)
}

function header(path, size, mtime) {
  const h = Buffer.alloc(BLOCK)
  const { name, prefix } = splitPath(path)
  h.write(name, 0, 100, 'ascii')
  h.write(octal(0o644, 8), 100, 8, 'ascii')
  h.write(octal(0, 8), 108, 8, 'ascii')
  h.write(octal(0, 8), 116, 8, 'ascii')
  h.write(octal(size, 12), 124, 12, 'ascii')
  h.write(octal(mtime, 12), 136, 12, 'ascii')
  h.write('        ', 148, 8, 'ascii')
  h.write('0', 156, 1, 'ascii')
  h.write('ustar\0', 257, 6, 'ascii')
  h.write('00', 263, 2, 'ascii')
  h.write(octal(0, 8), 329, 8, 'ascii')
  h.write(octal(0, 8), 337, 8, 'ascii')
  h.write(prefix, 345, 155, 'ascii')
  let sum = 0
  for (const byte of h) sum += byte
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
  return h
}

function tar(files, mtime) {
  const parts = []
  for (const f of files) {
    parts.push(header(f.path, f.data.length, mtime), f.data)
    const pad = (BLOCK - (f.data.length % BLOCK)) % BLOCK
    if (pad) parts.push(Buffer.alloc(pad))
  }
  parts.push(Buffer.alloc(BLOCK * 2))
  const body = Buffer.concat(parts)
  // Padded to a whole record of 20 blocks, as tar tools write.
  const record = BLOCK * 20
  return Buffer.concat([body, Buffer.alloc((record - (body.length % record)) % record)])
}

/**
 * `~` as the home folder: cmd and Windows PowerShell pass it on as written. The separator after it is
 * either slash (CI 2026-10-18: on Linux, `~\plugins` was joined as a folder named `\plugins`). A
 * backslash past it, on a system where it is no separator, would name one folder where several were
 * meant, and a `~` left over is one a shell dropped the backslash after: both are refused, as no
 * folder anyone meant (review 2026-10-18, minors 1 and 2).
 */
function expandHome(p) {
  if (p === '~') return homedir()
  if (/^~[\\/]/.test(p)) {
    if (process.platform !== 'win32' && p.slice(2).includes('\\'))
      fail(`${p}: put / between folders on this system, e.g. ~/.mongo-manager/plugins`)
    return join(homedir(), p.slice(2))
  }
  if (p.startsWith('~'))
    fail(
      `${p} is not read as the home folder: write ~/ before the folder (a shell drops an unquoted ` +
        'backslash), or ./ before a folder of that name',
    )
  return p
}

/**
 * Windows drops a dot or space at the end of a folder's name as it opens it, yet makes the folder
 * with it, which Explorer then cannot remove (review 2026-10-18, minor 7). The path's root (a drive,
 * a share, \\.\) is not a folder name (review 2026-10-18, minor 6).
 */
function plainOnWindows(p) {
  if (process.platform !== 'win32') return
  const abs = resolve(p)
  const part = abs
    .slice(win32.parse(abs).root.length)
    .split(/[\\/]/)
    .find((name) => /[. ]$/.test(name))
  if (part) fail(`${p}: a folder name may not end in a dot or a space on Windows ("${part}")`)
}

/** A path's real path: its nearest folder that is there with every link followed, then the rest. */
function realOf(p) {
  let at = resolve(p)
  const rest = []
  while (!existsSync(at) && dirname(at) !== at) {
    rest.unshift(basename(at))
    at = dirname(at)
  }
  return join(
    readable(p, () => realpathSync.native(at)),
    ...rest,
  )
}

/** What went wrong, in words: Node's own rmSync throws with an empty code (review 2026-10-18, minor 2). */
const why = (e) => e.code || e.message

/** While set, `readable` throws what went wrong instead of stopping the run: after the copy is in. */
let copied = false

/** What `read` gives, or a plain refusal that names the path (review 2026-10-18, minor 1). */
function readable(p, read) {
  try {
    return read()
  } catch (e) {
    if (copied) throw e
    fail(`${p} cannot be read (${why(e)}): nothing was copied`)
  }
}

/**
 * Whether two paths are one folder, however each names it: its device and file number, where the
 * file system gives one (some shares give 0 for every file), and the same names in both (a file
 * number is not unique on every file system) (review 2026-10-18, minor 5).
 */
function sameFolder(a, b) {
  const x = readable(a, () => statSync(a, { bigint: true, throwIfNoEntry: false }))
  const y = readable(b, () => statSync(b, { bigint: true, throwIfNoEntry: false }))
  if (!x || !y || x.ino === 0n || x.dev !== y.dev || x.ino !== y.ino) return false
  const names = (d) => readable(d, () => readdirSync(d).sort().join('\n'))
  return names(a) === names(b)
}

/** Whether `inner` is `outer` itself or inside it (letter case aside on Windows). */
function within(inner, outer) {
  const rel = relative(outer, inner)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Whether the folder is, holds or is inside the plugin's own: as written, by real path, or as one
 * folder of the file system, which a share, a bind mount or a folder that ignores letter case names
 * another way (review 2026-10-18, important 1).
 */
function ownFolder(target) {
  const root = readable(ROOT, () => realpathSync.native(ROOT))
  const real = realOf(target)
  if (within(target, ROOT) || within(ROOT, target) || within(real, root) || within(root, real)) return true
  for (let at = resolve(target); ; at = dirname(at)) {
    if (sameFolder(at, ROOT)) return true
    if (dirname(at) === at) break
  }
  for (let at = ROOT; ; at = dirname(at)) {
    if (sameFolder(at, target)) return true
    if (dirname(at) === at) return false
  }
}

/** The mount points of Linux, as /proc/self/mountinfo names them (octal escapes read). */
function mountPoints() {
  if (process.platform !== 'linux') return []
  let text
  try {
    text = readFileSync('/proc/self/mountinfo', 'utf8')
  } catch {
    return null
  }
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split(' ')[4].replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8))))
}

/**
 * The first entry of a folder that this script would not have put there, or null: anything it skips
 * (scripts, hidden entries, AI files, packages, tests), a link, or a folder of another device, at any
 * depth (a mount: deleting it empties what is mounted; review 2026-10-18, important 1). The plugin's
 * own folder always holds its scripts, so however a path names it, it is never one; nor is another
 * clone of the plugin with its history and work. A Finder .DS_Store is no one's work.
 */
function notCopied(dir, dev = readable(dir, () => lstatSync(dir)).dev) {
  for (const entry of readable(dir, () => readdirSync(dir, { withFileTypes: true }))) {
    const path = join(dir, entry.name)
    if (entry.name === '.DS_Store' && entry.isFile()) continue
    if (skipped(entry.name) || entry.isSymbolicLink()) return path
    if (!entry.isFile() && !entry.isDirectory()) return path
    if (entry.isDirectory()) {
      if (readable(path, () => lstatSync(path)).dev !== dev) return path
      const found = notCopied(path, dev)
      if (found) return found
    }
  }
  return null
}

/**
 * Why a folder that is there may not be deleted as an old copy of the plugin, or null: one of
 * another plugin, one with a file system mounted at it or in it (by the path given and by its real
 * path, as /proc/self/mountinfo names it: a link on the way hid one; review of d138ca9b, important 1),
 * one mounted of its own (review of d138ca9b, minor 5), or one holding what the script never copies.
 */
function notReplaceable(dir, id) {
  const stat = readable(dir, () => lstatSync(dir))
  let same
  try {
    same = stat.isDirectory() && JSON.parse(readFileSync(join(dir, MANIFEST), 'utf8')).id === id
  } catch {
    same = false
  }
  if (!same) return `${dir} exists and is not this plugin's folder`
  const mounts = mountPoints()
  if (mounts === null) return `${dir}: what is mounted where could not be read`
  const real = realOf(dir)
  const mounted = mounts.find((m) => within(m, resolve(dir)) || within(m, real))
  if (mounted) return `${dir} has a file system mounted at ${mounted}`
  if (readable(dirname(dir), () => statSync(dirname(dir))).dev !== stat.dev)
    return `${dir} is a file system of its own`
  const found = notCopied(dir)
  if (found)
    return `${dir} holds ${found}, which the script never copies (it may be the plugin itself or another clone)`
  return null
}

/** Why the target may not be written or replaced, or null: checked before anything is written. */
function refusal(target, id) {
  if (ownFolder(target))
    return `${target} is the plugin's own folder, inside it or around it: give the app's plugins folder`
  // A link that leads nowhere is there too (review of 4dde2064, minor 5).
  if (!lstatSync(target, { throwIfNoEntry: false })) return null
  const reason = notReplaceable(target, id)
  return reason && `${reason}: nothing was copied`
}

/**
 * Where --folder copies the plugin: <plugins>/<id>. Never the plugin's own folder, inside it, or a
 * folder holding it: replacing that would delete the plugin being packed (review 2026-10-11), the
 * way to it through a link included (review 2026-10-18: a plugins folder that was a link to the
 * one holding the plugin deleted all but the files packed: scripts, .git and the rest).
 */
function copyTarget(pluginsDir, id) {
  const folder = expandHome(pluginsDir)
  plainOnWindows(folder)
  const target = join(resolve(folder), id)
  const refused = refusal(target, id)
  if (refused) fail(refused)
  return target
}

/**
 * An old copy not to be deleted, moved to a name the server's scan leaves alone: it deletes every
 * .old- folder beside a plugin's, unchecked, at each Scan again (review of f8293686, minor 1).
 */
function keep(old, id, reason) {
  const kept = join(dirname(old), `.pack-kept-${id}.${randomUUID()}`)
  try {
    renameSync(old, kept)
    // Said of where it is now (review of 4dde2064, minor 2).
    console.error(`the last copy is kept, not deleted, at ${kept}: ${reason.split(old).join(kept)}`)
  } catch (e) {
    console.error(
      `the last copy is kept, not deleted, at ${old}: ${reason}; it could not be moved aside (${why(e)})` +
        (basename(old).startsWith('.old-')
          ? ': move it out of the plugins folder before you use Scan again in the app, which deletes it'
          : ''),
    )
  }
}

/**
 * Copies the files to <plugins>/<id> as the server installs an upload: written beside it first, then
 * swapped in, so a copy that stops leaves the folder as it was, never half deleted (review
 * 2026-10-18, minor 1). The old copy, set aside, has the server's own name, which its scan puts back
 * after a crash; the new one, while it is written, a name the scan leaves alone (it deletes its own
 * staging folders, at every Scan again: review of d138ca9b, minor 1).
 */
function copyTo(target, id, files) {
  // Asked again just before anything is replaced, for what changed on its way since.
  const refused = refusal(target, id)
  if (refused) fail(refused)
  const plugins = dirname(target)
  const staging = join(plugins, `.pack-${id}.${randomUUID()}`)
  const old = join(plugins, `.old-${id}.${randomUUID()}`)
  let setAside = false
  try {
    mkdirSync(plugins, { recursive: true })
    mkdirSync(staging)
    for (const f of files) {
      const file = join(staging, ...f.path.split('/'))
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, f.data, { flag: 'wx' })
    }
    if (lstatSync(target, { throwIfNoEntry: false })) {
      renameSync(target, old)
      setAside = true
    }
    renameSync(staging, target)
  } catch (e) {
    // The old copy back first: a part copy that cannot be deleted must not keep it away
    // (review of d138ca9b, minor 2).
    try {
      if (existsSync(old) && !existsSync(target)) renameSync(old, target)
    } catch {
      // Said below.
    }
    try {
      rmSync(staging, { recursive: true, force: true })
    } catch {
      // Said below.
    }
    // A folder put at the target while the old copy was aside is not the old copy: that one is kept
    // where the server's scan leaves it (review of 4dde2064, minor 1).
    const taken = setAside && existsSync(old) && existsSync(target)
    if (taken) keep(old, id, `a folder was put at ${target} while the copy was swapped in`)
    const where = taken
      ? `a folder was put there while the copy was swapped in, and was left alone`
      : existsSync(target)
        ? 'the folder was left as it was'
        : existsSync(old)
          ? `the last copy is at ${old}: give it back the name ${basename(target)} (Scan again in the app ` +
            'also puts it back)'
          : 'nothing was copied'
    const part = existsSync(staging) ? `; a part copy is left at ${staging}: delete it` : ''
    fail(`${target}: the copy stopped (${why(e)}); ${where}${part}; copy again once that is put right`)
  }
  // Asked once more of the old copy before it is deleted: the server's scan sees its name too, and
  // something may have been put in it since it was judged (review of d138ca9b, minor 3; review of
  // f8293686, minor 3). The copy is in: what goes wrong now is said, not a copy that failed, and an
  // old copy the scan cleared already leaves nothing to do (review of f8293686, minor 2).
  copied = true
  // Out of the scan's way at once, under a name it leaves alone, before it is judged (review of
  // 4dde2064, minor 4); the .old- name served only while the swap could stop half way.
  let aside = old
  if (existsSync(old))
    try {
      aside = join(plugins, `.pack-old-${id}.${randomUUID()}`)
      renameSync(old, aside)
    } catch {
      aside = old
    }
  let kept
  try {
    kept = existsSync(aside) ? notReplaceable(aside, id) : null
  } catch (e) {
    kept = `${aside} cannot be read (${why(e)})`
  }
  if (!existsSync(aside)) kept = null
  if (kept) keep(aside, id, kept)
  else
    try {
      rmSync(aside, { recursive: true, force: true })
    } catch (e) {
      if (existsSync(aside))
        console.error(`the last copy, at ${aside}, could not all be deleted (${why(e)}): delete it by hand`)
    }
  return target
}

const args = process.argv.slice(2)
const folderAt = args.indexOf('--folder')
if (folderAt !== -1 && !args[folderAt + 1])
  fail('--folder needs the plugins folder, e.g. ~/.mongo-manager/plugins')

const { files, bytes } = collect()
const manifest = readManifest(files)
// Checked before anything is written.
const target = folderAt === -1 ? null : copyTarget(args[folderAt + 1], manifest.id)
// The release day as the files' time, so the same files give the same archive.
const day = typeof manifest.publishedAt === 'string' ? Date.parse(`${manifest.publishedAt}T00:00:00Z`) : NaN
const mtime = Math.floor((Number.isFinite(day) ? day : Date.now()) / 1000)
const out = join(ROOT, `${manifest.id}-${manifest.version}.tgz`)
writeFileSync(out, gzipSync(tar(files, mtime), { level: 9 }))

console.log(`Packed ${files.length} files (${(bytes / 1024).toFixed(1)} KB):`)
for (const f of files) console.log(`  ${f.path}`)
console.log(`\n${out}`)
console.log(`digest (sha256): ${digestOf(files)}`)
if (target) console.log(`copied to ${copyTo(target, manifest.id, files)}`)
