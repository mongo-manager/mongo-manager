// Scans packages/*/src for constructs banned by the security spec (§5 S6, S7).
import { execFileSync } from 'node:child_process'
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
} from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const RULES = [
  {
    id: 'eval',
    // Called (optionally chained), reached indirectly as (0, eval) or [eval][0], kept in a name, handed
    // to Reflect, or named by a string key.
    re: /\beval\s*(?:\?\.\s*)?\(|[(,[]\s*eval\s*[)\]]|=\s*eval\s*(?:[;,)]|$)|\bReflect\s*\.\s*(?:apply|construct)\s*\(\s*eval\b|\[\s*["'`]eval["'`]\s*\]/,
    message: 'eval() is forbidden (spec §5 S7)',
  },
  {
    id: 'new-function',
    // Bare, with new, through the global object, its own methods or Reflect, or named by a string
    // key; and any function's constructor called, which is Function (or its async or generator
    // kin). Another object's Function method is its own.
    re: /\bnew\s+Function\s*\(|\bnew\s*\(\s*Function\s*\)|(?<![\w$.])Function\s*\(|\b(?:globalThis|window|self|global)\s*\.\s*Function\s*\(|\bFunction\s*\.\s*(?:apply|call|bind|prototype)\b|\bReflect\s*\.\s*(?:apply|construct)\s*\(\s*Function\b|\.constructor\s*(?:\?\.\s*)?\(|\.constructor\s*\.\s*constructor\b|\[\s*["'`]Function["'`]\s*\]/,
    message: 'The Function constructor is forbidden (spec §5 S7)',
  },
  {
    id: 'string-timer',
    re: /\bset(?:Timeout|Interval)\s*\(\s*["'`]/,
    message: 'A timer given code as text runs it like eval (spec §5 S7)',
  },
  {
    id: 'vm',
    // Imported, required (also through createRequire's function), in any quotes.
    re: /(?:from\s+|require\s*\(\s*|import\s*\(\s*|\)\s*\(\s*)['"`](?:node:)?vm['"`]/,
    message: 'node:vm is not a security boundary and is forbidden (spec §5 S7)',
  },
  { id: 'v-html', re: /\bv-html\b/, message: 'v-html is forbidden (spec §5 S6)' },
  {
    id: 'unseen-character',
    // Short names reviews 7 and 8: a bidi control, a zero-width, a tag or another unseen character in
    // source makes code read one way and run another (Trojan Source, CVE-2021-42574), or hides text
    // (tag characters). Written as a \u escape, it is seen; raw, it is refused. Every default-ignorable
    // and format character, line and paragraph separators and the braille blank — but the two
    // variation selectors an emoji is written with (VS15, VS16). A joined emoji (a family) or a tag
    // flag is written with escapes too: its joiner and tags are unseen characters (review 9, M-5).
    // Review 11 (M-6): a variation selector only right after an emoji or a keycap's digit: one after
    // anything else (a letter, or another selector, as in a run of them) spells hidden text.
    // Review 12 (M-8): a digit's only before the keycap mark, and none after an unassigned code
    // point. (M-9): control characters too (not tab, line feed, form feed), and a carriage return
    // not followed by a line feed — a JavaScript line end that hides what comes before it. Review 13
    // (M-6), 14 (M5): \p{Cn} follows the Unicode version of the Node that runs it — CI runs this on
    // 24 and 26, so a code point assigned only in 26's selects differently on the two.
    // eslint-disable-next-line no-control-regex -- control characters are what this rule finds
    re: /(?<![#*0-9\p{Extended_Pictographic}])[\uFE0E\uFE0F]|[#*0-9][\uFE0E\uFE0F](?!\u20E3)|\p{Cn}[\uFE0E\uFE0F]|(?![\uFE0E\uFE0F])[\p{Default_Ignorable_Code_Point}\p{Cf}\p{Zl}\p{Zp}\u2800]|[\x01-\x08\x0B\x0E-\x1F\x7F-\x9F]|\r/u,
    message:
      'An unseen character (bidi control, zero-width, tag, filler, control character, lone carriage return) is forbidden: write it as a \\u escape (a lone carriage return: save the file with LF line endings; a BOM at the start of a file: save it without one)',
    // Review 8 (M-9): tests, scripts and JSON (the locales) too — they run in CI and ship.
    everywhere: true,
  },
  {
    id: 'raw-http',
    // Phase 3d-3b final review B28: any network module, in any import form, with or without "node:".
    re: /\bfetch\s*\(|\bhttps?\.request\s*\(|\bhttps?\.get\s*\(|(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*|\bimport\s+)['"](?:node:)?(?:https?|http2|tls|net|dgram|undici)['"]/,
    // The backup code and the destination routes; net/egress.ts is the one place that may.
    only: /packages\/server\/src\/(?:backup\/|routes\/destinations\.ts$)/,
    message: 'Destinations reach the network only through net/egress.ts (phase 3d-3b spec §3)',
  },
]

const EXT = /\.(ts|tsx|mts|cts|js|mjs|cjs|vue)$/
/**
 * Review 8 (M-9): where only the rules marked `everywhere` apply — tests, scripts, configs, JSON,
 * HTML and workflows (review 9, M-4).
 */
const EXT_EVERYWHERE =
  /(?:\.(?:ts|tsx|mts|cts|js|mjs|cjs|vue|json|html|ya?ml|css|svg|webmanifest|conf|service|plist|sh|ps1|toml|md|txt|sql|snap)|(?:^|[\\/])(?:Dockerfile|Caddyfile|LICENSE|\.gitignore|\.gitattributes|\.editorconfig|\.dockerignore|\.prettierignore|\.npmrc))$/
/** Not ours, or made by a build or a test run. */
const SKIP = new Set([
  'node_modules',
  'dist',
  'coverage',
  'test-results',
  'playwright-report',
  '.vite',
  '.turbo',
])

/**
 * Narrow, documented exceptions. The shell worker (phase 3a-1 §3.2) is the one place that runs
 * untrusted code, and its sandbox is built FROM these constructs, not undermined by them:
 * - node:vm runs mongosh in a context whose codeGeneration is disabled, on top of the process-wide
 *   --disallow-code-generation-from-strings; vm is not trusted as the boundary — the process, the
 *   permission model and the disabled code generation are.
 * - `new Function('return 1')` is the sandbox self-check: it MUST throw, proving code generation is
 *   off, or the worker refuses to run.
 * Each entry is a specific file and rule; nothing else is exempt.
 */
const ALLOW = [
  { file: 'packages/server/src/shell/worker/runtime.ts', rules: ['vm'] },
  { file: 'packages/server/src/shell/worker/entry.ts', rules: ['new-function'] },
]
/** Generated build artifacts (e.g. the mongosh runtime-support stub) are not source; skip them. */
const GENERATED = /\.generated\.(c?js|ts)$/

function allowed(file, rule) {
  const norm = file.split('\\').join('/')
  return ALLOW.some((a) => norm.endsWith(a.file) && a.rules.includes(rule))
}

export function findForbidden(text, file, { everywhereOnly = false } = {}) {
  if (GENERATED.test(file)) return []
  const hits = []
  text.split(/\r?\n/).forEach((line, i) => {
    for (const rule of RULES) {
      if (everywhereOnly && !rule.everywhere) continue
      if (rule.only && !rule.only.test(file.split('\\').join('/'))) continue
      if (rule.re.test(line) && !allowed(file, rule.id))
        hits.push({ file, line: i + 1, rule: rule.id, message: rule.message })
    }
  })
  return hits
}

/**
 * Review 10 (M-2): one entry that cannot be looked at (a dangling link, a file gone meanwhile) is
 * skipped alone, never the rest of its folder; links are not followed. A folder that cannot be
 * read at all fails the check rather than passing it unseen.
 */
function walk(dir, out, ext = EXT) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue
    const path = join(dir, name)
    let st
    try {
      st = lstatSync(path)
    } catch (e) {
      if (e.code === 'ENOENT') continue
      throw e
    }
    if (st.isSymbolicLink()) continue
    if (st.isDirectory()) walk(path, out, ext)
    else if (ext.test(name)) out.push(path)
  }
  return out
}
const walkIfThere = (dir, out, ext) => {
  let st
  try {
    st = lstatSync(dir)
  } catch (e) {
    if (e.code === 'ENOENT') return
    throw e
  }
  if (st.isDirectory()) walk(dir, out, ext)
}

/** The files git keeps or would add (not those it ignores), or null outside a git checkout. */
function gitFiles(root) {
  try {
    const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    })
    return out.split('\0').filter(Boolean)
  } catch {
    return null
  }
}

function listDir(dir) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/** Review 11 (M-5): a file larger than this is not read whole; it is reported, never passed. */
const MAX_READ = 32 * 1024 * 1024
/**
 * Review 10 (M-3): a listed file's text — UTF-16 by its BOM, else UTF-8 — or null for one that is
 * not ours to read: gone, a link (review 11, M-5: never followed), not a file, or, for a name that
 * is not a known text kind, a NUL in its first 8 KB (binary). A known text file with a NUL in it is
 * read all the same (review 11, I-1: a NUL must not hide a test or a script from the check).
 */
function textOf(path, known = EXT_EVERYWHERE.test(path)) {
  // CodeQL js/file-system-race: the file is opened once and everything after is asked of that open
  // file, so what is checked is what is read. A link is never followed: refused by the open where the
  // system can (O_NOFOLLOW), and, where it cannot (Windows), found by its own entry and refused too.
  // Never blocks on a FIFO (O_NONBLOCK where there is one).
  let fd
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ELOOP' || e.code === 'EISDIR') return null
    throw e
  }
  try {
    return textOfOpen(fd, path, known)
  } finally {
    closeSync(fd)
  }
}

function textOfOpen(fd, path, known) {
  const st = fstatSync(fd)
  if (!st.isFile()) return null
  if (constants.O_NOFOLLOW === undefined) {
    let entry
    try {
      entry = lstatSync(path)
    } catch (e) {
      if (e.code === 'ENOENT') return null
      throw e
    }
    // A link, or an entry that is no longer the file opened: not ours to read.
    if (entry.isSymbolicLink() || entry.ino !== st.ino || entry.dev !== st.dev) return null
  }
  // Review 12 (M-5): a file of another kind is looked at by its head first — binary is not read,
  // whatever its size or its first bytes.
  if (!known) {
    const head = Buffer.alloc(Math.min(8192, st.size))
    readSync(fd, head, 0, head.length, 0)
    // Review 13 (M-1): UTF-16 (by its BOM) is text full of NUL bytes, not binary.
    const utf16 = (head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff)
    if (!utf16 && head.includes(0)) return null
  }
  if (st.size > MAX_READ) return { tooLarge: true }
  const bytes = readFileSync(fd)
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { text: bytes.subarray(2).toString('utf16le') }
  // Review 12 (M-4): an odd last byte is not half a character to swap.
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    const body = Buffer.from(bytes.subarray(2, 2 + ((bytes.length - 2) & ~1)))
    return { text: body.swap16().toString('utf16le') }
  }
  return { text: bytes.toString('utf8') }
}

/** Review 12 (M-7): one file through the rules, its NUL reported, whichever pass reads it. */
function checkFile(f, root, options) {
  const read = textOf(f, options.everywhereOnly ? undefined : true)
  const file = relative(root, f)
  if (read === null) return []
  if (read.tooLarge)
    return [
      { file, line: 0, rule: 'unseen-character', message: `Too large to check (over ${MAX_READ} bytes)` },
    ]
  const hits = findForbidden(read.text, file, options)
  // Review 11 (I-1): a NUL in a text file is reported where it is. Review 12 (M-6): with the way out.
  const at = read.text.indexOf('\0')
  if (at >= 0)
    hits.push({
      file,
      line: read.text.slice(0, at).split('\n').length,
      rule: 'unseen-character',
      message:
        'A NUL in a text file is forbidden: it would hide the file from this check. Write it as \\0 or \\u0000, or give a binary fixture a binary extension',
    })
  return hits
}

/** Not read by the `everywhere` rules: the server's data (never), and the docs. */
const NOT_OURS = /^(?:backend|docs)\//

export function scan(root) {
  const packagesDir = join(root, 'packages')
  const pluginsDir = join(packagesDir, 'plugins')
  const files = []
  // Every package's src/, and each plugin's (plan 1a deferred minor: the plugins were never scanned).
  const sources = [
    ...listDir(packagesDir).map((pkg) => join(packagesDir, pkg, 'src')),
    ...listDir(pluginsDir).map((plugin) => join(pluginsDir, plugin, 'src')),
  ]
  for (const src of sources) walkIfThere(src, files, EXT)
  // Reviews 8 (M-9), 9 (M-4) and 10 (M-3): the rules marked `everywhere` over the rest that runs or
  // ships. In a git checkout, every text file git keeps or would add (not what it ignores, such as
  // the web app copied into the CLI's public folder) — configs, styles, unit files, Dockerfiles,
  // workflows, HTML, JSON — but backend/ (the server's data, never read) and docs/. Outside one,
  // every package and plugin whole, the repository's scripts, workflows and deploy files, and its
  // top-level files, by extension.
  const kept = gitFiles(root)
  let more
  if (kept) {
    more = kept
      .filter((rel) => !NOT_OURS.test(rel) && !rel.split('/').some((part) => SKIP.has(part)))
      .map((rel) => join(root, rel))
  } else {
    more = []
    for (const dir of [
      ...listDir(packagesDir)
        .filter((pkg) => pkg !== 'plugins')
        .map((pkg) => join(packagesDir, pkg)),
      ...listDir(pluginsDir).map((plugin) => join(pluginsDir, plugin)),
      join(root, 'scripts'),
      join(root, '.github'),
      join(root, 'deploy'),
    ])
      walkIfThere(dir, more, EXT_EVERYWHERE)
    for (const name of listDir(root)) {
      const path = join(root, name)
      try {
        if (EXT_EVERYWHERE.test(name) && lstatSync(path).isFile()) more.push(path)
      } catch {
        // gone meanwhile
      }
    }
  }
  const seen = new Set(files)
  return [
    ...files.flatMap((f) => checkFile(f, root, {})),
    ...more.filter((f) => !seen.has(f)).flatMap((f) => checkFile(f, root, { everywhereOnly: true })),
  ]
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const hits = scan(process.cwd())
  for (const h of hits) console.error(`${h.file}:${h.line} [${h.rule}] ${h.message}`)
  if (hits.length > 0) process.exit(1)
  console.log('check-forbidden: OK')
}
