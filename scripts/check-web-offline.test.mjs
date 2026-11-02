import { test } from 'node:test'
import assert from 'node:assert/strict'
import { offlineProblems } from './check-web-offline.mjs'

test('HTML may not load, prefetch or preconnect anything from another origin (final review Minor 5)', () => {
  assert.deepEqual(
    offlineProblems('<script src="./assets/a.js"></script><link href="/x.css">', 'index.html'),
    [],
  )
  for (const html of [
    '<script src="https://cdn.example.com/vue.js"></script>',
    '<link rel="preconnect" href="https://fonts.gstatic.com">',
    '<link rel="dns-prefetch" href="//fonts.googleapis.com">',
    "<img src='http://tracker.example/p.gif'>",
    '<meta http-equiv="refresh" content="0; url=https://example.com/">',
  ]) {
    assert.equal(offlineProblems(html, 'index.html').length, 1, html)
  }
  // The SVG namespace is an identifier, not a request.
  assert.deepEqual(offlineProblems('<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'a.svg'), [])
})

test('CSS may not import or reference anything from another origin', () => {
  assert.deepEqual(offlineProblems('@font-face{src:url(./a.woff2)} a{background:url("/b.png")}', 'a.css'), [])
  assert.equal(
    offlineProblems('@import url(https://fonts.googleapis.com/css2?family=Outfit);', 'a.css').length,
    1,
  )
  assert.equal(offlineProblems("@import 'https://x.example/a.css';", 'a.css').length, 1)
  assert.equal(offlineProblems('a{background:url(//x.example/b.png)}', 'a.css').length, 1)
})

test('the web app manifest may only name relative URLs (phase 1g-2)', () => {
  const ok = JSON.stringify({ start_url: './', scope: './', icons: [{ src: 'favicon.svg' }] })
  assert.deepEqual(offlineProblems(ok, 'manifest.webmanifest'), [])
  const bad = JSON.stringify({ start_url: './', icons: [{ src: 'https://cdn.example/icon.png' }] })
  assert.equal(offlineProblems(bad, 'manifest.webmanifest').length, 1)
  assert.equal(
    offlineProblems(JSON.stringify({ start_url: '//evil.example/' }), 'manifest.webmanifest').length,
    1,
  )
})
