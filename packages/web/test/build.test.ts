// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const dist = join(import.meta.dirname, '..', 'dist')
// Read lazily: a skipped describe still runs its body during collection.
const html = () => readFileSync(join(dist, 'index.html'), 'utf8')
const assets = () => readdirSync(join(dist, 'assets'))

// CI's e2e job builds first and sets MM_REQUIRE_BUILD: there a missing build fails, never skips.
it.runIf(process.env.MM_REQUIRE_BUILD === '1')('has a production build to check', () => {
  expect(existsSync(join(dist, 'index.html'))).toBe(true)
})

describe.runIf(existsSync(join(dist, 'index.html')))('production build (CSP, offline)', () => {
  it('references only relative same-origin assets and has no inline code', () => {
    expect(html()).toContain('<base href="/"')
    expect(html()).toMatch(/src="\.\/assets\/[^"]+\.js"/)
    expect(html()).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/)
    expect(html()).not.toMatch(/<style/)
    expect(html()).not.toMatch(/https?:\/\//)
  })

  it('bundles the fonts as files, with no remote font URLs', () => {
    expect(assets().some((a) => a.endsWith('.woff2'))).toBe(true)
    const css = assets()
      .filter((a) => a.endsWith('.css'))
      .map((a) => readFileSync(join(dist, 'assets', a), 'utf8'))
      .join('\n')
    expect(css).not.toMatch(/fonts\.googleapis|fonts\.gstatic|url\(data:/)
  })
  it('keeps server-only code out of the bundle and splits dialogs and tab views', () => {
    const js = assets().filter((a) => a.endsWith('.js'))
    const code = js.map((a) => readFileSync(join(dist, 'assets', a), 'utf8')).join('\n')
    // A message only mongodb-connection-string-url contains (zod has its own "xn--" hostname regex).
    expect(code).not.toContain('expected connection string to start with')
    expect(js.some((a) => a.startsWith('ConnectionDialog'))).toBe(true)
    expect(js.some((a) => a.startsWith('ConnectionTab'))).toBe(true)
    expect(js.some((a) => a.startsWith('DocumentPage'))).toBe(true)
    expect(js.some((a) => a.startsWith('BulkDialog'))).toBe(true)
    expect(js.some((a) => a.startsWith('IndexesView'))).toBe(true)
  })

  it('keeps the chart library out of the entry chunk (phase 1j, Review Focus 3)', () => {
    const entry = /src="\.\/assets\/([^"]+\.js)"/.exec(html())![1]!
    const code = readFileSync(join(dist, 'assets', entry), 'utf8')
    expect(code).not.toMatch(/zrender|echarts/i)
    // ECharts is a chunk of its own, loaded with the first chart.
    expect(assets().some((a) => a.startsWith('echarts') && a.endsWith('.js'))).toBe(true)
  })
})
