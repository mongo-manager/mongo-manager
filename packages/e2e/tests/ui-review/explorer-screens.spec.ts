import { readFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { expect, signIn, test } from '../../fixtures'

/**
 * W1 (completion §2): the data explorer's screens — sorted and resized columns with the header
 * menu, filter and suggestion chips, the query panel's Save and Run, the chart view (bars in series,
 * a pie, points) — light and dark, English and Turkish at 1440×900, and the narrow phone width.
 * Run: MM_UI_REVIEW=1 pnpm --filter @mongo-manager/e2e exec playwright test tests/01-first-run.spec.ts tests/ui-review/explorer-screens.spec.ts --project=chrome
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
function say(lang: 'en' | 'tr', key: string, values: Record<string, string> = {}): string {
  const value = key.split('.').reduce<string | Tree>((t, k) => (t as Tree)[k]!, locales[lang]) as string
  return value
    .split('|')[0]!
    .trim()
    .replace(/\{(\w+)\}/g, (_, k: string) => values[k] ?? '')
}

async function api(page: Page, method: 'GET' | 'POST', path: string, data?: object) {
  const me = await (await page.request.get('api/auth/me')).json()
  const res = await page.request.fetch(`api/${path}`, {
    method,
    ...(data ? { data } : {}),
    headers: { 'x-csrf-token': me.csrfToken, origin: new URL(page.url()).origin },
  })
  expect(res.ok(), await res.text()).toBe(true)
  return res.status() === 204 ? null : res.json()
}

async function noSidewaysScroll(page: Page, where: string) {
  const wide = await page.evaluate('document.documentElement.scrollWidth > window.innerWidth')
  expect(wide, `${where}: the page scrolls sideways`).toBe(false)
}

test('the data explorer in both themes and languages, and narrow (W1)', async ({ page }) => {
  test.setTimeout(900_000)
  await signIn(page)
  await expect(page.getByRole('button', { name: /^Account menu/ })).toBeVisible()
  const conn = ((await api(page, 'GET', 'connections')) as Array<{ id: string; name: string }>).find(
    (c) => c.name === 'Local test',
  )!.id
  const base = `connections/${conn}/databases/review/collections/sales`
  const existing = (await api(page, 'POST', `${base}/count`, { filter: {} })) as { count: number }
  if (existing.count < 30) {
    const statuses = ['paid', 'paid', 'shipped', 'pending', 'refunded']
    const regions = ['Europe', 'North America', 'Asia', 'Europe']
    await api(page, 'POST', `${base}/documents`, {
      documents: Array.from({ length: 60 }, (_, i) => ({
        orderNo: `ORD-${10001 + i}`,
        status: statuses[i % statuses.length],
        region: regions[i % regions.length],
        channel: i % 3 ? 'web' : 'store',
        items: 1 + (i % 4),
        total: 40 + ((i * 37.5) % 900),
        createdAt: { $date: new Date(Date.UTC(2026, 8, 1 + (i % 28), 9 + (i % 10))).toISOString() },
        ...(i % 5 === 0 ? { coupon: `SAVE${i}` } : {}),
      })),
    })
  }

  type Run = { size: { width: number; height: number }; theme: 'light' | 'dark'; lang: 'en' | 'tr' }
  const runs: Run[] = []
  for (const theme of ['light', 'dark'] as const)
    for (const lang of ['en', 'tr'] as const) runs.push({ size: { width: 1440, height: 900 }, theme, lang })
  runs.push({ size: { width: 390, height: 844 }, theme: 'light', lang: 'en' })

  for (const { size, theme, lang } of runs) {
    const S = (key: string, values: Record<string, string> = {}) => say(lang, key, values)
    await page.setViewportSize(size)
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
    await page.evaluate(
      ([th, l]) => {
        localStorage.setItem('mm:preferences', JSON.stringify({ theme: th, locale: l, accent: 'emerald' }))
        localStorage.removeItem('mm:tabs')
        localStorage.removeItem('mm:layout')
      },
      [theme, lang] as const,
    )
    await page.goto(`c/${conn}/db/review/coll/sales`)
    await expect(page.locator('th[data-column="total"]')).toBeVisible()
    const dir = `test-results/ui-review/explorer-${size.width}-${theme}-${lang}`
    const shot = async (name: string) => {
      await page.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))')
      await page.screenshot({ path: `${dir}-${name}.png` })
    }
    // Suggestions come from a sample: wait for them.
    await expect(page.getByRole('group', { name: S('explorer.suggest.label') })).toBeVisible()
    await shot('01-suggestions')

    const filter = page.getByRole('textbox', { name: S('query.filter'), exact: true })
    await filter.fill("{ status: 'paid', total: { $gt: 100 } }")
    await filter.press('Enter')
    await page.locator('th[data-column="total"] button[data-sort]').click()
    await page.locator('th[data-column="total"] button[data-sort]').click()
    await page.locator('th[data-column="region"] button[data-sort]').click({ modifiers: ['Shift'] })
    const handle = page.getByRole('separator', { name: S('explorer.column.resize', { name: 'orderNo' }) })
    await handle.focus()
    await page.keyboard.press('Shift+ArrowRight')
    await expect(page.locator('[data-filter-chips] [data-chip]')).toHaveCount(2)
    await noSidewaysScroll(page, `${dir} table`)
    await shot('02-sorted-chips-panel')
    if (size.width >= 1024) {
      await page.locator('th[data-column="total"]').hover()
      await page.getByRole('button', { name: S('explorer.column.menu', { name: 'total' }) }).click()
      await shot('03-header-menu')
      await page.keyboard.press('Escape')
    }

    await filter.fill('')
    await filter.press('Enter')
    await page.getByRole('radio', { name: S('documents.view.chart') }).click()
    const chart = page.locator('[data-results-chart]')
    await chart.getByLabel(S('explorer.chart.x')).selectOption('region')
    await chart.getByLabel(S('explorer.chart.group')).selectOption('status')
    await expect(chart.locator('canvas').first()).toBeVisible()
    await noSidewaysScroll(page, `${dir} chart`)
    await shot('04-chart-bars')
    await chart.getByRole('radio', { name: S('explorer.chart.kinds.pie') }).click()
    await expect(chart.locator('canvas').first()).toBeVisible()
    await shot('05-chart-pie')
    await chart.getByRole('radio', { name: S('explorer.chart.kinds.scatter') }).click()
    await chart.getByLabel(S('explorer.chart.x')).selectOption('items')
    await chart.getByLabel(S('explorer.chart.yAxis')).selectOption('total')
    await expect(chart.locator('canvas').first()).toBeVisible()
    await shot('06-chart-scatter')
    await chart.getByRole('radio', { name: S('explorer.chart.kinds.bar') }).click()
    await page.getByRole('radio', { name: S('documents.view.table') }).click()
  }
})
