// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { linkRefusedPage } from '../src/auth/launch'

/**
 * Languages (2026-10-29): the page a download link opened outside the app shows says where to
 * click it in the browser's own language first (of the app's ten), and in English always.
 */
describe('the page of a link opened outside the app', () => {
  it('speaks the browser’s language first, then English', () => {
    const page = linkRefusedPage('/', 'zh-CN,zh;q=0.9,en;q=0.8')
    expect(page).toContain('<h1 lang="zh-CN">')
    expect(page.indexOf('lang="zh-CN"')).toBeLessThan(page.indexOf('Open this link from Mongo Manager'))
    expect(page).not.toContain('lang="tr"')
    for (const [header, tag] of [
      ['tr-TR', 'tr'],
      ['ja', 'ja'],
      ['es-MX,es;q=0.9', 'es'],
      ['pt-BR', 'pt-BR'],
      ['ko-KR', 'ko'],
      ['de-DE', 'de'],
      ['fr-CA', 'fr'],
      ['ru', 'ru'],
    ])
      expect(linkRefusedPage('/', header), header).toContain(`<h1 lang="${tag}">`)
  })

  it('is English alone for a language the app does not have, or none', () => {
    for (const header of [undefined, '', 'nl-NL,nl;q=0.9', 'zh-TW', 'en-GB']) {
      const page = linkRefusedPage('/', header)
      expect(page, String(header)).toContain('Open this link from Mongo Manager')
      expect(page, String(header)).not.toMatch(/<h1 lang=/)
    }
  })

  // Review of the languages (minors 3 and 4): the browser's weights count, a refused language is not
  // spoken, Chinese is the app's one rule, and the English part is marked English.
  it('follows the header’s weights, the app’s rule for Chinese, and marks the English', () => {
    expect(linkRefusedPage('/', 'fr;q=0, ru;q=0.5')).toContain('<h1 lang="ru">')
    expect(linkRefusedPage('/', 'fr;q=0')).not.toMatch(/<h1 lang=/)
    expect(linkRefusedPage('/', 'de;q=0.2, ja;q=0.8')).toContain('<h1 lang="ja">')
    expect(linkRefusedPage('/', 'zh-MY')).toContain('<h1 lang="zh-CN">')
    expect(linkRefusedPage('/', 'zh-yue')).not.toMatch(/<h1 lang=/)
    expect(linkRefusedPage('/', 'tr')).toMatch(/^<!doctype html><html lang="en">/)
  })

  it('keeps the address safe in every language', () => {
    const page = linkRefusedPage('/a"b<c&/', 'fr')
    expect(page).not.toContain('a"b<c')
    expect(page.match(/href="\/a&quot;b&lt;c&amp;\/"/g)).toHaveLength(2)
  })
})
