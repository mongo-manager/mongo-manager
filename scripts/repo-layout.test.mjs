import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')

const READERS = readdirSync(root).filter((f) => /^(README(\.[a-z]{2})?|CHANGELOG|SECURITY)\.md$/.test(f))

// User request 2026-10-31: this is a new project, not an upgrade — no earlier version, no
// import from one, in what a reader opens first.
test('no README, changelog or policy speaks of an earlier version', () => {
  for (const name of READERS) {
    const text = readFileSync(join(root, name), 'utf8')
    assert.doesNotMatch(text, /import-legacy|backend\/data|version 1\b|upgrad\w* from/i, name)
  }
})

// User request 2026-10-31: the project is Mongo Manager, never "v2" — in no file of the repository.
// Other projects' names that carry one stay: the Go driver's module path, Pydantic v2, Workbox's cache.
const THEIRS = /mongo-driver\/v2\/|Pydantic v2|workbox-precache-v2/g
test('no tracked file calls the project "v2"', () => {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0')
  const found = []
  for (const name of files) {
    if (
      !name ||
      /\.(png|gif|mp4|webm|woff2?|ico|zip|tgz|jpe?g|pdf|xlsx|bin|snap)$|^pnpm-lock\.yaml$/.test(name)
    )
      continue
    // This test names what it looks for.
    if (name === 'scripts/repo-layout.test.mjs' || !existsSync(join(root, name))) continue
    const text = readFileSync(join(root, name), 'utf8').replace(THEIRS, '')
    if (/(^|[^a-z0-9])v2([^0-9a-z]|$)|version 2\b/im.test(text)) found.push(name)
  }
  assert.deepEqual(found, [])
})

const READMES = readdirSync(root).filter((f) => /^README(\.[a-z]{2})?\.md$/.test(f))

// User request 2026-10-31: the badges under the title (CI, npm, license, Node.js) are the one thing
// a README loads from the network — from shields.io and the project's own CI, and nowhere else.
const BADGE =
  /^\[!\[[^\]]+\]\((https:\/\/img\.shields\.io\/[^)\s]+|https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/workflows\/[\w.-]+\.yml\/badge\.svg[^)\s]*)\)\]\([^)\s]+\)$/

test('no README loads anything from the network but its badges (offline docs, spec §3.6)', () => {
  for (const name of READMES) {
    const lines = readFileSync(join(root, name), 'utf8').split(/\r?\n/)
    assert.equal(lines[0], '# Mongo Manager', name)
    for (const badge of lines[2].split(/(?<=\)) (?=\[)/)) assert.match(badge, BADGE, `${name}: ${badge}`)
    const rest = [lines[0], ...lines.slice(3)].join('\n')
    assert.doesNotMatch(rest, /<img[^>]+src="https?:|!\[[^\]]*\]\(https?:|srcset="https?:/, name)
  }
})

// Languages (user request 2026-10-29): every README offers every language, the English (global)
// one first and Turkish second; each names itself in bold and links the others, which all exist.
test('every README offers every language, English first and Turkish second', () => {
  // The line under the badges.
  const bar = (name) => readFileSync(join(root, name), 'utf8').split(/\r?\n/)[4]
  const order = (line) =>
    [...line.matchAll(/\[([^\]]+)\]\((README(?:\.[a-z]{2})?\.md)\)|\*\*([^*]+)\*\*/g)].map(
      (m) => m[2] ?? `self:${m[3]}`,
    )
  const english = order(bar('README.md'))
  assert.equal(english[0], 'self:English')
  assert.equal(english[1], 'README.tr.md')
  assert.deepEqual(
    english.slice(1).sort(),
    READMES.filter((f) => f !== 'README.md').sort(),
    'the English README links every translation',
  )
  for (const name of READMES) {
    const links = order(bar(name))
    assert.equal(links.length, READMES.length, name)
    assert.equal(links.filter((l) => l.startsWith('self:')).length, 1, name)
    // Itself in bold where the English one lists it; the others linked, in the same order.
    assert.deepEqual(
      links.map((l) => (l.startsWith('self:') ? name : l)),
      ['README.md', ...english.slice(1)],
      name,
    )
    for (const l of links) if (!l.startsWith('self:')) assert.ok(existsSync(join(root, l)), `${name} → ${l}`)
  }
})

// The updater (user request 2026-11-03): a fork that ships its own updates makes its own key.
test('every README tells a fork how to sign its own updates', () => {
  for (const name of READMES) {
    const text = readFileSync(join(root, name), 'utf8')
    for (const word of ['scripts/release-key.mjs', 'packages/shared/src/updates/source.ts', 'MM_RELEASE_SIGNING_KEY', 'RELEASE_PUBLIC_KEYS'])
      assert.ok(text.includes(word), `${name}: ${word}`)
  }
})

test('no README, changelog, site or npm page promises "no update checks" any more', () => {
  const files = [...READERS, 'packages/cli/README.md', 'site/index.html', 'site/i18n.js']
  for (const name of files) {
    const text = readFileSync(join(root, name), 'utf8')
    assert.doesNotMatch(text, /no telemetry, (no )?update checks|telemetri, güncelleme denetimi/i, name)
  }
})
