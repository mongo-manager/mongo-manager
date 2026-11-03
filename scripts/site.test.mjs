import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * The landing page (site/, 2026-10-31): every text in the ten languages, nothing loaded from
 * another site, and every file it names there.
 */
const root = join(import.meta.dirname, '..', 'site')
const html = readFileSync(join(root, 'index.html'), 'utf8')
const LANGS = ['en', 'tr', 'zh', 'ja', 'es', 'pt', 'ko', 'de', 'fr', 'ru']
// The page's own file, as the browser runs it: it sets window.MM_I18N.
globalThis.window = {}
await import(pathToFileURL(join(root, 'i18n.js')).href)
const I18N = globalThis.window.MM_I18N
const appJs = readFileSync(join(root, 'app.js'), 'utf8')

test('every language has every text the page and its script use', () => {
  const keys = new Set(
    [
      ...html.matchAll(/data-i18n(?:-html|-aria|-alt)?="([^"]+)"/g),
      ...html.matchAll(/data-label-(?:play|pause)="([^"]+)"/g),
    ].map((m) => m[1]),
  )
  // A whole key only: one put together at run time ('shots.' + a scene) is listed above.
  for (const m of appJs.matchAll(/\bt\('([a-z0-9.]*[a-z0-9])'/g)) keys.add(m[1])
  for (const shot of html.matchAll(/data-shot="([^"]+)"/g)) keys.add(`shots.${shot[1]}`)
  for (const mode of ['auto', 'light', 'dark']) keys.add(`theme.${mode}`)
  assert.deepEqual(Object.keys(I18N).sort(), [...LANGS].sort())
  for (const lang of LANGS) for (const key of keys) assert.ok(I18N[lang][key], `${lang} lacks ${key}`)
  // No language holds a key the others do not.
  const english = Object.keys(I18N.en).sort()
  for (const lang of LANGS) assert.deepEqual(Object.keys(I18N[lang]).sort(), english, lang)
})

test('the page names every placeholder its texts fill', () => {
  for (const lang of LANGS)
    for (const [key, text] of Object.entries(I18N[lang])) {
      const want = [...I18N.en[key].matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()
      const got = [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()
      assert.deepEqual(got, want, `${lang} ${key}`)
    }
})

test('French puts a narrow no-break space before its colons, semicolons and question marks', () => {
  for (const [key, text] of Object.entries(I18N.fr))
    assert.doesNotMatch(
      text.replace(/<code>[^<]*<\/code>|https?:\/\/\S+|\{\w+\}/g, ''),
      /(?<!\u202f)[:;?!]/,
      key,
    )
})

test('nothing is loaded from another site, and the policy says so', () => {
  assert.match(html, /default-src 'none'; script-src 'self'; style-src 'self'/)
  const loaded = [...html.matchAll(/<(?:script|img|video|source|link)\b[^>]*\b(?:src|href)="([^"]+)"/g)].map(
    (m) => m[1],
  )
  for (const url of loaded) {
    if (/^https:\/\/mongo-manager\.github\.io\//.test(url)) continue
    assert.doesNotMatch(url, /^(https?:)?\/\//, url)
  }
  // No inline script or style: the policy would refuse it.
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/)
  assert.doesNotMatch(html, /\sstyle="/)
  assert.doesNotMatch(readFileSync(join(root, 'styles.css'), 'utf8'), /@import|url\((?!["']?data:)/)
})

test('every file the page names is there', () => {
  for (const m of html.matchAll(/\b(?:src|href)="((?:assets\/|styles|theme-init|i18n|app)[^"#?]*)"/g))
    assert.ok(existsSync(join(root, m[1])), m[1])
})
