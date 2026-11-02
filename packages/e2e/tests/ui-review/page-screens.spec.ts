import type { Page } from '@playwright/test'
import { expect, signIn, test } from '../../fixtures'

/**
 * UI redesign R3–R5: the connection and database tabs (the connection's Performance section too), and every page — destinations, schedules,
 * live sync, background jobs, SQL transfer, users, audit, plugins, library, AI settings, AI history,
 * account — light and dark, English and Turkish, at 1440×900; then sign-in in both themes.
 * Run: MM_UI_REVIEW=1 pnpm --filter @mongo-manager/e2e exec playwright test tests/01-first-run.spec.ts tests/ui-review/page-screens.spec.ts --project=chrome
 */
test.skip(!process.env.MM_UI_REVIEW, 'UI review runs on demand')

async function checkFit(page: Page, where: string) {
  const problems = (await page.evaluate(`(() => {
    const out = []
    if (document.documentElement.scrollWidth > window.innerWidth) out.push('page scrolls sideways')
    // Nothing inside the workspace's main area is wider than its box (a scroller of its own aside).
    for (const el of document.querySelectorAll('#main, #main *')) {
      const style = getComputedStyle(el)
      // Only a box that scrolls can scroll sideways (a truncated line is cut on purpose).
      if (style.overflowX !== 'auto' && style.overflowX !== 'scroll') continue
      // Hidden for screen readers only: one pixel, clipped on purpose.
      if (el.clientWidth < 2) continue
      if (el.scrollWidth <= el.clientWidth + 1) continue
      // A bar of tabs scrolls by design at a phone's width: fine while an arrow says more are there.
      if (el.hasAttribute('data-tabs-scroller')) {
        if (!el.parentElement.querySelector('[data-tabs-more]')) out.push('tabs cut off, no arrow: ' + el.getAttribute('aria-label'))
        continue
      }
      out.push('scrolls sideways: ' + (el.className || el.tagName).toString().slice(0, 60))
    }
    // Review of the Monitoring redesign (I-1): a table no wider than its box, and no control cut off by
    // a clipping ancestor (a data table's row menu was clipped, out of reach).
    for (const table of document.querySelectorAll('#main table')) {
      const box = table.parentElement
      if (box && box.clientWidth > 1 && table.scrollWidth > box.clientWidth + 1)
        out.push('table wider than its box: ' + (table.getAttribute('aria-label') || table.className).toString().slice(0, 60))
    }
    for (const el of document.querySelectorAll('#main button, #main a[href], #main input, #main select')) {
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
    // A page header's actions stay on its line.
    for (const el of document.querySelectorAll('#main header button')) {
      const r = el.getBoundingClientRect()
      if (r.height > 40) out.push('taller than one line: ' + (el.textContent || '').trim().slice(0, 40))
    }
    return out
  })()`)) as string[]
  expect(problems, where).toEqual([])
}

const PAGES = [
  'destinations',
  'schedules',
  'live-syncs',
  'jobs',
  'sql',
  'users',
  'audit',
  'plugins',
  'library',
  'ai-assistant',
  'ai-history',
  'account',
] as const

test('the tabs and pages in both themes and languages (UI redesign R3–R5)', async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(900_000)
  await signIn(page)
  await expect(page.getByRole('button', { name: /^Account menu/ })).toBeVisible()

  const list = (await (await page.request.get('api/connections')).json()) as Array<{
    id: string
    name: string
  }>
  const conn = list.find((c) => c.name === 'Local test')!.id
  // A database with collections to list (the collection review fills it further when it runs first).
  const me = (await (await page.request.get('api/auth/me')).json()) as { csrfToken: string }
  const headers = { 'x-csrf-token': me.csrfToken, origin: new URL(page.url()).origin }
  for (const coll of ['products', 'orders', 'customers'])
    await page.request.post(`api/connections/${conn}/databases/review/collections/${coll}/documents`, {
      data: { documents: [{ seeded: true }] },
      headers,
    })

  for (const theme of ['light', 'dark'] as const)
    for (const lang of ['en', 'tr'] as const) {
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
      const dir = `test-results/ui-review/pages-${theme}-${lang}`
      const shot = async (name: string) => {
        await page.waitForLoadState('networkidle')
        await page.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))')
        await checkFit(page, `${dir} ${name}`)
        await page.screenshot({ path: `${dir}-${name}.png` })
      }

      await page.goto(`c/${conn}`)
      await expect(page.locator('#main header h2').first()).toBeVisible()
      await shot('01-connection')
      // UI redesign R3 (Monitoring): the connection's Performance section, live and a stored span.
      await page.getByRole('tab', { name: lang === 'tr' ? 'Performans' : 'Performance' }).click()
      await expect(page.locator('#main [data-performance]')).toBeVisible()
      // A second sample, so the rates have something to compare with.
      await expect(page.locator('#main [data-performance] canvas').first()).toBeVisible({ timeout: 15_000 })
      await page.waitForTimeout(4_000)
      await shot('01b-performance')
      await page
        .getByRole('radiogroup', { name: lang === 'tr' ? 'Zaman aralığı' : 'Time span' })
        .getByRole('radio', { name: lang === 'tr' ? '24 saat' : '24 hours' })
        .click()
      await shot('01c-performance-24h')
      await page.locator('#main [data-operations]').scrollIntoViewIfNeeded()
      await shot('01d-performance-operations')
      await page.locator('#main [data-profiler]').scrollIntoViewIfNeeded()
      await shot('01e-performance-profiler')
      await page.goto(`c/${conn}/db/review`)
      await expect(page.locator('#main table').first()).toBeVisible()
      await shot('02-database')
      // User request 2026-10-24: the database's Backups and Personal data tabs, a rule's pickers open.
      await page.locator('#main [role="tab"][id$="-backups"]').click()
      await expect(page.locator('#main [id^="backups-"]').first()).toBeVisible()
      await shot('02b-database-backups')
      await page.locator('#main [role="tab"][id$="-personalData"]').click()
      const rules = page.locator('#main [data-personal-data]')
      await expect(rules).toBeVisible()
      await shot('02c-database-personal')
      await rules.locator('[data-rule-coll] button').click()
      await page.getByRole('option').filter({ has: page.getByText('orders', { exact: true }) }).click()
      await rules.locator('[data-rule-field] button').click()
      await expect(page.getByRole('listbox')).toBeVisible()
      await page.waitForLoadState('networkidle')
      await page.screenshot({ path: `${dir}-02d-database-personal-pick.png` })
      await page.keyboard.press('Escape')
      let n = 3
      for (const path of PAGES) {
        await page.goto(path)
        await expect(page.locator('#main header h2').first()).toBeVisible()
        await shot(`${String(n++).padStart(2, '0')}-${path}`)
      }
    }

  // Review of R3–R5 (I-2): a phone's width, where a header's actions go under its title.
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  await page.evaluate(() => {
    localStorage.setItem(
      'mm:preferences',
      JSON.stringify({ theme: 'light', locale: 'tr', accent: 'emerald' }),
    )
    localStorage.removeItem('mm:tabs')
    localStorage.removeItem('mm:layout')
  })
  for (const path of [
    `c/${conn}`,
    'jobs',
    'library',
    'destinations',
    'ai-history',
    'account',
    'users',
  ] as const) {
    await page.goto(path)
    await expect(page.locator('#main header h2').first()).toBeVisible()
    await page.waitForLoadState('networkidle')
    await page.screenshot({ path: `test-results/ui-review/pages-narrow-${path.replaceAll('/', '_')}.png` })
    await checkFit(page, `narrow ${path}`)
  }

  // UI redesign R3 (Monitoring): Performance at a phone's width — the header's span and menus wrap
  // under the title; each table drops its least needed columns and shares its box (long values end in
  // an ellipsis in their own cell), keeps its row menus in reach, and nothing scrolls sideways.
  await page.goto(`c/${conn}`)
  await page.getByRole('tab', { name: 'Performans' }).click()
  await expect(page.locator('#main [data-performance]')).toBeVisible()
  await page.waitForLoadState('networkidle')
  await page.screenshot({ path: 'test-results/ui-review/pages-narrow-performance.png', fullPage: true })
  await checkFit(page, 'narrow performance')
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
    await page.evaluate((th) => {
      localStorage.setItem('mm:preferences', JSON.stringify({ theme: th, locale: 'en', accent: 'emerald' }))
    }, theme)
    await page.reload()
    await page.getByRole('tab', { name: 'Performance' }).click()
    await expect(page.locator('#main [data-performance]')).toBeVisible()
    await page.waitForLoadState('networkidle')
    await page.screenshot({ path: `test-results/ui-review/pages-narrow-performance-${theme}-en.png` })
    await checkFit(page, `narrow performance ${theme}`)
  }

  // Sign-in, signed out in a context of its own.
  for (const theme of ['light', 'dark'] as const) {
    const context = await browser.newContext({ baseURL, colorScheme: theme, reducedMotion: 'reduce' })
    const signedOut = await context.newPage()
    await signedOut.setViewportSize({ width: 1440, height: 900 })
    await signedOut.goto('login')
    await expect(signedOut.getByRole('heading', { level: 1 })).toBeVisible()
    await signedOut.screenshot({ path: `test-results/ui-review/pages-${theme}-login.png` })
    await context.close()
  }
})
