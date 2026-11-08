// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { readFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { expect, signIn, test } from '../../fixtures'

/**
 * UI redesign R2: the collection's other sections — Indexes (and Create index), Schema, Validation,
 * Explain, Watch and Overview — light and dark, English and Turkish, at 1440×900.
 * Run: MM_UI_REVIEW=1 pnpm --filter @mongo-manager/e2e exec playwright test tests/01-first-run.spec.ts tests/ui-review/collection-screens.spec.ts --project=chrome
 */
test.skip(!process.env.MM_UI_REVIEW, 'UI review runs on demand')

type Tree = { [key: string]: string | Tree }
const locales = Object.fromEntries(
  (['en', 'tr'] as const).map((l) => [
    l,
    JSON.parse(
      readFileSync(new URL(`../../../web/src/i18n/locales/${l}.json`, import.meta.url), 'utf8'),
    ) as Tree,
  ]),
) as Record<'en' | 'tr', Tree>
function say(lang: 'en' | 'tr', key: string): string {
  const value = key.split('.').reduce<string | Tree>((t, k) => (t as Tree)[k]!, locales[lang]) as string
  return value.split('|')[0]!.trim()
}

async function api(page: Page, method: 'GET' | 'POST', path: string, data?: object) {
  const me = await (await page.request.get('api/auth/me')).json()
  const res = await page.request.fetch(`api/${path}`, {
    method,
    ...(data ? { data } : {}),
    headers: { 'x-csrf-token': me.csrfToken, origin: new URL(page.url()).origin },
  })
  return res.status() === 204 ? null : res.json()
}

async function checkFit(page: Page, where: string) {
  const problems = (await page.evaluate(`(() => {
    const out = []
    if (document.documentElement.scrollWidth > window.innerWidth) out.push('page scrolls sideways')
    // Review of R3 (I-2): nothing inside a section's panel is wider than its box either.
    for (const el of document.querySelectorAll('[role="tabpanel"], [role="tabpanel"] *')) {
      const style = getComputedStyle(el)
      // Only a box that scrolls can scroll sideways (a truncated line is cut on purpose).
      if (style.overflowX !== 'auto' && style.overflowX !== 'scroll') continue
      // Hidden for screen readers only: one pixel, clipped on purpose.
      if (el.clientWidth < 2) continue
      if (el.scrollWidth > el.clientWidth + 1) out.push('scrolls sideways: ' + (el.className || el.tagName).toString().slice(0, 60))
    }
    // Review of the Monitoring redesign (I-1): a table no wider than its box, and no control cut off by
    // a clipping ancestor (a data table's row menu was clipped, out of reach).
    for (const table of document.querySelectorAll('[role="tabpanel"] table')) {
      const box = table.parentElement
      if (box && box.clientWidth > 1 && table.scrollWidth > box.clientWidth + 1)
        out.push('table wider than its box: ' + (table.getAttribute('aria-label') || table.className).toString().slice(0, 60))
    }
    for (const el of document.querySelectorAll('[role="tabpanel"] button, [role="tabpanel"] a[href], [role="tabpanel"] input, [role="tabpanel"] select')) {
      const r = el.getBoundingClientRect()
      if (r.width < 2) continue
      for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
        if (getComputedStyle(a).overflowX !== 'clip') continue
        const box = a.getBoundingClientRect()
        if (r.right > box.right + 1 || r.left < box.left - 1)
          out.push('clipped: ' + (el.getAttribute('aria-label') || el.textContent || el.tagName).trim().slice(0, 40))
        break
      }
    }
    for (const el of document.querySelectorAll('[role="tabpanel"] button')) {
      const r = el.getBoundingClientRect()
      if (r.height > 40) out.push('taller than one line: ' + (el.textContent || '').trim().slice(0, 40))
    }
    return out
  })()`)) as string[]
  expect(problems, where).toEqual([])
}

test('the collection sections in both themes and languages (UI redesign R2)', async ({ page }) => {
  test.setTimeout(900_000)
  await signIn(page)
  await expect(page.getByRole('button', { name: /^Account menu/ })).toBeVisible()
  const conn = ((await api(page, 'GET', 'connections')) as Array<{ id: string; name: string }>).find(
    (c) => c.name === 'Local test',
  )!.id
  const base = `connections/${conn}/databases/review/collections/products`
  const existing = (await api(page, 'POST', `${base}/count`, { filter: {} })) as { count?: number }
  if (!existing?.count) {
    await api(page, 'POST', `${base}/documents`, {
      documents: Array.from({ length: 48 }, (_, i) => ({
        sku: `SKU-${2000 + i}`,
        name: ['Kettle', 'Lamp', 'Desk', 'Chair', 'Mug', 'Shelf'][i % 6],
        price: 9.5 + i * 3.25,
        stock: i % 7 === 0 ? null : 3 + (i % 11),
        active: i % 5 !== 0,
        tags: i % 3 === 0 ? ['new', 'eco'] : ['eco'],
        dims: { w: 10 + i, h: 20 + (i % 4) },
        addedAt: { $date: new Date(Date.UTC(2026, 6, 1 + (i % 28))).toISOString() },
      })),
    })
    await api(page, 'POST', `${base}/indexes`, { key: { sku: 1 }, options: { unique: true } })
    await api(page, 'POST', `${base}/indexes`, { key: { name: 1, price: -1 }, options: {} })
    await api(page, 'POST', `${base}/indexes`, {
      key: { addedAt: 1 },
      options: { expireAfterSeconds: 31536000 },
    })
  }

  for (const theme of ['light', 'dark'] as const)
    for (const lang of ['en', 'tr'] as const) {
      const S = (key: string) => say(lang, key)
      await page.setViewportSize({ width: 1440, height: 900 })
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
      await page.evaluate(
        ([th, l]) => {
          localStorage.setItem('mm:preferences', JSON.stringify({ theme: th, locale: l, accent: 'emerald' }))
          localStorage.removeItem('mm:tabs')
          localStorage.removeItem('mm:layout')
        },
        [theme, lang] as const,
      )
      await page.goto(`c/${conn}/db/review/coll/products`)
      const dir = `test-results/ui-review/collection-${theme}-${lang}`
      const shot = async (name: string) => {
        await page.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))')
        await checkFit(page, `${dir} ${name}`)
        await page.screenshot({ path: `${dir}-${name}.png` })
      }
      const section = (key: string) => page.getByRole('tab', { name: S(`documents.sections.${key}`) }).click()

      await section('indexes')
      await expect(page.getByText('sku_1', { exact: true })).toBeVisible()
      await shot('01-indexes')
      await page
        .getByRole('button', { name: S('indexes.create') })
        .first()
        .click()
      await expect(page.getByRole('dialog')).toBeVisible()
      await page.getByRole('textbox', { name: S('indexes.fieldN').replace('{n}', '1') }).fill('price')
      await shot('02-index-create')
      await page.getByRole('button', { name: S('indexes.moreOptions') }).click()
      await shot('03-index-create-more')
      await page.keyboard.press('Escape')

      await section('schema')
      await shot('04-schema-empty')
      await page.getByRole('button', { name: S('schema.analyse') }).click()
      await expect(page.locator('[data-field="price"]')).toBeVisible()
      await page.locator('[data-field="price"] button[aria-expanded]').click()
      await shot('05-schema')

      await section('validation')
      await expect(page.getByRole('textbox', { name: S('validation.rules') })).toBeVisible()
      await shot('06-validation')
      await page.getByRole('button', { name: S('validation.test') }).click()
      await expect(page.locator('[data-validation-test]')).toBeVisible()
      await shot('07-validation-tested')

      await section('explain')
      await shot('08-explain-empty')
      await page.getByRole('button', { name: S('explain.run'), exact: true }).click()
      await expect(page.locator('[data-explain-summary]')).toBeVisible()
      await shot('09-explain')

      await section('watch')
      await shot('10-watch')
      await section('overview')
      await expect(page.locator('figure').first()).toBeVisible()
      await shot('11-overview')
    }
})
