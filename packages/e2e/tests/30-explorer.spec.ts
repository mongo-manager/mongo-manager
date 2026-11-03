import type { Page } from '@playwright/test'
import { expect, signIn, test } from '../fixtures'

/**
 * W1 (completion §2): the data explorer — headers that sort and resize, filter chips and
 * suggestions, a chart of the results, the query panel's Save and Run, pinned queries and Copy name.
 * It seeds its own collection, so it runs after 01-first-run alone.
 */
const COLL = 'w1sales'
const REGIONS = ['eu', 'us', 'apac'] as const

async function api(page: Page, method: 'post' | 'put', path: string, data: object) {
  const me = await (await page.request.get('api/auth/me')).json()
  const origin = new URL(page.url()).origin
  const res = await page.request[method](`api/${path}`, {
    data,
    headers: { 'x-csrf-token': me.csrfToken, origin },
  })
  expect(res.ok(), await res.text()).toBe(true)
  return res.json()
}

async function openSales(page: Page): Promise<string> {
  await signIn(page)
  await expect(page.getByRole('button', { name: /^Account menu/ })).toBeVisible()
  const connections = (await (await page.request.get('api/connections')).json()) as Array<{
    id: string
    name: string
  }>
  const id = connections.find((c) => c.name === 'Local test')!.id
  const base = `connections/${id}/databases/shop/collections/${COLL}`
  const count = await api(page, 'post', `${base}/count`, { filter: {} })
  if (!count.count)
    await api(page, 'post', `${base}/documents`, {
      documents: Array.from({ length: 12 }, (_, i) => ({
        n: { $numberInt: String(i) },
        region: REGIONS[i % 3],
        status: i % 4 === 0 ? 'open' : 'paid',
        total: { $numberInt: String((i * 7) % 50) },
      })),
    })
  await page.goto(`c/${id}/db/shop/coll/${COLL}`)
  await expect(page.locator('th[data-column="total"]')).toBeVisible()
  return id
}

const firstTotal = (page: Page) =>
  page.locator('tbody tr[data-row]').first().locator('td[data-field="total"]')

test('sorts by a header (asc, desc, none), shows it in the query, and resizes a column', async ({ page }) => {
  await openSales(page)
  const head = page.locator('th[data-column="total"]')
  await head.locator('button[data-sort]').click()
  await expect(head).toHaveAttribute('aria-sort', 'ascending')
  await expect(firstTotal(page)).toHaveText('0')
  // The query shows the sort it runs (Options' sort is the one source of truth), in the panel and the
  // Options count; the Options panel is not opened for it.
  const sortPart = page.locator('[data-query-panel] [data-query-part="sort"]')
  await expect(sortPart).toContainText('{ total: 1 }')
  await expect(page.getByRole('button', { name: 'Options, 1 set' })).toHaveAttribute('aria-expanded', 'false')
  await head.locator('button[data-sort]').click()
  await expect(head).toHaveAttribute('aria-sort', 'descending')
  await expect(firstTotal(page)).toHaveText('49')
  await head.locator('button[data-sort]').click()
  await expect(head).not.toHaveAttribute('aria-sort', /.+/)
  await expect(sortPart).toHaveCount(0)

  // Keyboard: Enter on the header sorts; the resize handle widens the column by arrows.
  await head.locator('button[data-sort]').focus()
  await page.keyboard.press('Enter')
  await expect(head).toHaveAttribute('aria-sort', 'ascending')
  const handle = page.getByRole('separator', { name: 'Width of column region' })
  await handle.focus()
  const before = Number(await handle.getAttribute('aria-valuenow'))
  await page.keyboard.press('Shift+ArrowRight')
  await expect(handle).toHaveAttribute('aria-valuenow', String(before + 64))
  await expect(page.locator('th[data-column="region"]')).toHaveCSS('width', `${before + 64}px`)
})

test('filter chips remove a condition and run; a suggestion adds one', async ({ page }) => {
  await openSales(page)
  const filter = page.getByRole('textbox', { name: 'Filter', exact: true })
  await filter.fill('{ status: "paid", total: { $gt: 20 } }')
  await filter.press('Enter')
  const chips = page.getByRole('group', { name: 'Conditions of the filter in use' })
  await expect(chips.getByRole('group', { name: 'status = "paid"' })).toBeVisible()
  await expect(chips.getByRole('group', { name: 'total > 20' })).toBeVisible()
  await expect(chips.locator('[data-chip]')).toHaveCount(2)
  await chips.getByRole('button', { name: 'Remove the condition status = "paid"' }).click()
  await expect(filter).toHaveValue('{ total: { $gt: 20 } }')
  await expect(chips.locator('[data-chip]')).toHaveCount(1)
  await expect(chips.getByRole('group', { name: 'total > 20' })).toBeVisible()
  await chips.locator('[data-chip]').first().focus()
  await page.keyboard.press('Delete')
  await expect(filter).toHaveValue('')
  await expect(chips).toHaveCount(0)

  // Suggestions come from a small schema sample: the common status is offered, and adds itself.
  const suggestions = page.getByRole('group', { name: 'Suggested conditions' })
  await suggestions.getByRole('button', { name: 'Add status = "paid" to the filter' }).click()
  await expect(filter).toHaveValue('{ status: "paid" }')
  await expect(page.getByRole('group', { name: 'Conditions of the filter in use' })).toContainText(
    'status = "paid"',
  )
})

test('draws the results as a chart, bar then pie, with the app’s own tooltip', async ({ page }) => {
  await openSales(page)
  await page.getByRole('radio', { name: 'Chart' }).click()
  const chart = page.locator('[data-results-chart]')
  await chart.getByLabel('X axis').selectOption('region')
  await expect(chart.locator('figcaption')).toHaveText('Count by region')
  const canvas = chart.locator('canvas').first()
  await expect(canvas).toBeVisible()
  // The numbers are in a table for screen readers.
  // The groups come in the results' order: newest first since 2026-11-02 (the last inserted is apac).
  await expect(chart.locator('.sr-only table td')).toContainText(['apac', '4', 'us', '4', 'eu', '4'])
  await chart.getByLabel('Measure').selectOption('sum')
  await chart.getByLabel('Value').selectOption('total')
  await expect(chart.locator('figcaption')).toHaveText('Sum of total by region')
  await chart.getByRole('radio', { name: 'Pie' }).click()
  await expect(chart.getByLabel('Slices')).toHaveValue('region')
  await expect(canvas).toBeVisible()
  // Pointing at the pie shows the app's tooltip, as text above the page.
  const box = (await canvas.boundingBox())!
  await page.mouse.move(box.x + box.width / 2 + box.height * 0.26, box.y + box.height * 0.45)
  await expect(page.locator('[data-chart-tip]')).toBeVisible()
})

test('the panel saves the query in use, pinned first on the Queries page; Copy name copies', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await openSales(page)
  const filter = page.getByRole('textbox', { name: 'Filter', exact: true })
  await filter.fill('{ region: "eu" }')
  await filter.press('Enter')
  const panel = page.locator('[data-query-panel]')
  await panel.getByRole('button', { name: 'Run', exact: true }).click()
  await panel.getByRole('button', { name: 'Save the query in use as a favourite' }).click()
  const save = page.getByRole('dialog', { name: 'Save as favourite' })
  await save.getByLabel('Name').fill('W1 Europe')
  await save.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText('Saved "W1 Europe" as a favourite.')).toBeVisible()

  // Copy name, from a column's menu.
  await page.locator('th[data-column="total"]').hover()
  await page.getByRole('button', { name: 'Options for column total' }).click()
  await page.getByRole('menuitem', { name: 'Copy name' }).click()
  await expect(page.getByText('Copied “total”.')).toBeVisible()
  expect(await page.evaluate('navigator.clipboard.readText()')).toBe('total')

  // The Queries page, by its shortcut, on this connection.
  await page.keyboard.press('Control+Shift+L')
  const list = page.locator('[data-library-page]')
  await expect(list).toBeVisible()
  const row = list.locator('[data-library-item]', { hasText: 'W1 Europe' })
  await row.getByRole('button', { name: 'Pin W1 Europe' }).click()
  await expect(list.locator('[data-library-item]').first()).toContainText('W1 Europe')
  await expect(list.locator('[data-library-item]').first()).toContainText('Pinned')
  await list.locator('[data-library-item]').first().getByRole('button', { name: 'Unpin W1 Europe' }).click()
  await expect(list.locator('[data-library-item]', { hasText: 'W1 Europe' })).not.toContainText('Pinned')
})
