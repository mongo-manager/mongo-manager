// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, openAccount, signIn, test } from '../fixtures'

/**
 * Languages (user request 2026-10-29): each language the app offers is chosen in Account settings,
 * speaks on every part of the page, stays after a reload, has its docs, and its longer words never
 * make the window scroll.
 */
const LOCALES = join(import.meta.dirname, '..', '..', 'web', 'src', 'i18n', 'locales')
type Tree = { [key: string]: string | Tree }
const words = (lang: string) => JSON.parse(readFileSync(join(LOCALES, `${lang}.json`), 'utf8')) as Tree
const at = (tree: Tree, path: string) =>
  path.split('.').reduce<Tree | string>((t, k) => (t as Tree)[k]!, tree) as string
const TAG: Record<string, string> = { zh: 'zh-CN', pt: 'pt-BR' }
const LANGUAGES = readdirSync(LOCALES)
  .map((f) => f.replace(/\.json$/, ''))
  .filter((l) => l !== 'en' && l !== 'tr')
  .sort()

const still = (page: Page) =>
  page
    .locator('html')
    .evaluate((doc) => ({ scrollY: doc.scrollTop, overflow: doc.scrollHeight - doc.clientHeight }))

test('every language is chosen, speaks on the page, stays after a reload and has its docs', async ({
  page,
}) => {
  test.setTimeout(240_000)
  await page.setViewportSize({ width: 1280, height: 720 })
  await signIn(page)
  expect(LANGUAGES.length).toBeGreaterThanOrEqual(4)
  for (const lang of LANGUAGES) {
    const w = words(lang)
    await openAccount(page)
    await page.getByLabel('Language', { exact: true }).selectOption(lang)
    await expect(page.locator('html')).toHaveAttribute('lang', TAG[lang] ?? lang)
    // The sidebar, the page's own title and its sections, all in the language.
    await expect(page.getByRole('navigation', { name: at(w, 'layout.app') })).toBeVisible()
    await expect(page.getByRole('heading', { name: at(w, 'security.title') })).toBeVisible()
    await expect(page.getByRole('navigation', { name: at(w, 'account.sections') })).toBeVisible()
    expect(await still(page), lang).toEqual({ scrollY: 0, overflow: 0 })

    await page.reload()
    await expect(page.locator('html')).toHaveAttribute('lang', TAG[lang] ?? lang)
    await expect(page.getByRole('navigation', { name: at(w, 'layout.app') })).toBeVisible()

    const docs = await page.request.get(`/docs/${lang}/index.html`)
    expect(docs.status(), lang).toBe(200)
    expect(await docs.text(), lang).toContain(`<html lang="${TAG[lang] ?? lang}">`)

    // Back to English, from the language's own words.
    const menu = at(w, 'header.accountMenu')
      .split('{name}')
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')
    await page.getByRole('button', { name: new RegExp(`^${menu}$`) }).click()
    await page.getByRole('menuitem', { name: at(w, 'header.settings') }).click()
    await page.getByLabel(at(w, 'account.preferences.language'), { exact: true }).selectOption('en')
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  }
})

// Longer words (Russian, German, French) stay in the sections' column at every wide width, in every
// language: none runs into the cards beside it (review of the last four languages, minor 27).
test('keeps every language’s account sections clear of the cards', async ({ page }) => {
  test.setTimeout(240_000)
  await signIn(page)
  await expect(page.getByRole('navigation').first()).toBeVisible()
  for (const width of [1024, 1280])
    for (const lang of ['en', 'tr', ...LANGUAGES]) {
      await page.setViewportSize({ width, height: 720 })
      await page.evaluate((l) => {
        const prefs = JSON.parse(localStorage.getItem('mm:preferences') ?? '{}')
        localStorage.setItem('mm:preferences', JSON.stringify({ ...prefs, locale: l }))
      }, lang)
      await page.goto('/account')
      const w = words(lang)
      const nav = page.getByRole('navigation', { name: at(w, 'account.sections') })
      await expect(nav).toBeVisible()
      const sticking = await nav.evaluate((el) => {
        const cards = el.nextElementSibling!.getBoundingClientRect().left
        return [...el.querySelectorAll('button')]
          .filter((b) => b.getBoundingClientRect().right > cards - 1 || b.scrollWidth > b.clientWidth + 1)
          .map((b) => b.textContent?.trim())
      })
      expect(sticking, `${lang} at ${width}px`).toEqual([])
    }
})
