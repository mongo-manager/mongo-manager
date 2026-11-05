// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { Page } from '@playwright/test'
import { expect, test } from '../../fixtures'

const ADA = '65a1b2c3d4e5f60718293a4b'
const LOST = '65a1b2c3d4e5f60718293a4c'

/** A connection, a database with customers and orders referring to them; the orders' address. */
async function shop(page: Page): Promise<string> {
  await page.goto('/')
  await page.getByRole('button', { name: 'Add connection' }).click()
  // User report 2026-10-16: the connection string is the form's first field and fills it by itself.
  await page.getByLabel('Connection string').fill(process.env.MM_E2E_MONGO_URI!)
  await page.getByLabel('Connection string').press('Enter')
  await expect(page.locator('[data-uri-status]')).toContainText('Read:')
  await page.getByLabel('Name', { exact: true }).fill('Wave 2')
  await page.getByLabel('Name', { exact: true }).press('Enter')
  await expect(page.getByText('Connection saved.')).toBeVisible()
  await page.getByRole('button', { name: 'New database' }).click()
  await page.getByLabel('Database name').fill('wave2')
  await page.getByLabel('First collection').fill('customers')
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await page.getByRole('button', { name: 'customers', exact: true }).click()
  await page.getByRole('button', { name: 'Add documents' }).first().click()
  await page
    .getByRole('textbox', { name: 'Document', exact: true })
    .fill(`{ _id: ObjectId('${ADA}'), name: 'Ada' }`)
  await page.getByRole('button', { name: 'Insert', exact: true }).click()
  await expect(page.locator('tbody tr')).toHaveCount(1)

  await page.getByRole('button', { name: 'Actions for wave2', exact: true }).click()
  await page.getByRole('menuitem', { name: 'New collection' }).click()
  await page.getByLabel('Collection name').fill('orders')
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  // The new collection opens in its tab.
  await expect(page.getByRole('tab', { name: 'wave2.orders' })).toHaveAttribute('aria-selected', 'true')
  for (const doc of [
    `{ customerId: ObjectId('${ADA}'), city: 'Izmir', total: 5, at: ISODate('2026-01-05T10:00:00Z'), items: [{ customerId: ObjectId('${ADA}'), qty: 2 }] }`,
    `{ customerId: ObjectId('${LOST}'), city: 'Ankara', total: 7, at: ISODate('2026-02-05T10:00:00Z') }`,
    `{ customerId: ObjectId('${ADA}'), city: 'Izmir', total: 'x', at: ISODate('2026-02-06T10:00:00Z') }`,
  ]) {
    await page.getByRole('button', { name: 'Add documents' }).first().click()
    await page.getByRole('textbox', { name: 'Document', exact: true }).fill(doc)
    await page.getByRole('button', { name: 'Insert', exact: true }).click()
    // Saved and closed before the next one: typed while it saves, a document waited on the old pane.
    await expect(page.locator('[data-document-page]')).toHaveCount(0)
  }
  await expect(page.locator('tbody tr')).toHaveCount(3)
  return page.url()
}

const PLUGINS = ['charts', 'schema-health', 'value-search', 'references', 'document-diff', 'sql-to-mongodb']

/**
 * Left as found for the tests after this one, even when this one fails halfway: a plugin it left
 * enabled made the next test fail to approve it.
 */
async function disableAll(page: Page, ids: string[]): Promise<void> {
  await page.goto('/plugins')
  for (const id of ids) {
    const disable = page.locator(`[data-plugin="${id}"]`).getByRole('button', { name: 'Disable' })
    if (await disable.isVisible()) await disable.click()
  }
}
test.afterEach(async ({ page }) => disableAll(page, PLUGINS))
const section = (page: Page, name: string) =>
  page.getByRole('tablist', { name: 'Collection sections' }).getByRole('tab', { name, exact: true })
// The section shown: a value search stays loaded, out of sight, after its tab (ui.keepOpen).
const frame = (page: Page) => page.frameLocator('[data-plugin-frame] iframe:visible')

// Plugins wave 2 (user request 2026-10-10): charts, schema health, value search, references and
// document diff, and the Documents query as code — in Chrome, on the app's own data.
test('the wave 2 plugins and Export to Language, each on real data', async ({ page }) => {
  const orders = await shop(page)
  await page.goto('/plugins')
  for (const id of PLUGINS) {
    const card = page.locator(`[data-plugin="${id}"]`)
    await card.getByRole('button', { name: 'Approve and enable' }).click()
    await page.locator('[data-test="confirm"]').click()
    await expect(card.locator('[data-plugin-status]')).toHaveText('Enabled')
  }

  await page.goto(orders)
  // References: the referenced customer's name beside its id, and a dangling one said to be missing.
  await expect(page.locator('[data-plugin-cell]', { hasText: '→ Ada' }).first()).toBeVisible()
  await expect(page.locator('[data-plugin-cell]', { hasText: '→ not found' })).toHaveCount(1)
  // …and inside an array of documents (user report: items.productId had no reference).
  await page.getByRole('button', { name: /^Show items of document/ }).click()
  await page.getByRole('button', { name: 'Expand 0' }).click()
  await expect(page.getByRole('dialog').locator('[data-plugin-cell]', { hasText: '→ Ada' })).toBeVisible()
  await page.keyboard.press('Escape')
  await section(page, 'References').click()
  await frame(page).getByRole('button', { name: 'Find references' }).click()
  const relation = frame(page).locator('[data-relation="customerId"]')
  await expect(relation).toContainText('customers')
  await expect(relation).toContainText('50%')

  // Charts: orders by city, a row shown in Documents.
  await section(page, 'Charts').click()
  await frame(page).locator('#field').selectOption('city')
  await frame(page).getByRole('button', { name: 'Draw' }).click()
  await expect(frame(page).locator('#summary tbody tr')).toHaveCount(2)
  await expect(frame(page).locator('#summary tbody tr').first()).toContainText('Izmir')
  await expect(frame(page).locator('#chart svg rect').first()).toBeVisible()
  // The data under the chart is folded (redesign 2026-10-10).
  await frame(page).locator('#data > summary').click()
  await frame(page).locator('#summary tbody tr').first().getByRole('button', { name: 'Show' }).click()
  await expect(section(page, 'Documents')).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('tbody tr')).toHaveCount(2)

  // Export to Language: the query in use as a driver program.
  await page.locator('[data-query-panel]').getByRole('button', { name: 'Export to a driver' }).click()
  await expect(page.locator('[data-export-code]')).toContainText('coll.find(filter')
  await expect(page.locator('[data-export-code]')).toContainText('city')
  await page.keyboard.press('Escape')

  // Schema health: "total" holds a number and a string.
  await section(page, 'Health').click()
  await frame(page).getByRole('button', { name: 'Check' }).click()
  await expect(frame(page).locator('[data-finding="mixedTypes"]')).toContainText('total')

  // Value search: the whole collection by default (redesign 2026-10-10); within the current
  // query (Izmir) only when the Documents filter is chosen.
  await section(page, 'Search').click()
  await frame(page).locator('#term').fill('ankara')
  await frame(page).getByRole('button', { name: 'Search', exact: true }).click()
  await expect(frame(page).locator('.vs-row')).toHaveCount(1)
  await expect(frame(page).locator('.vs-row')).toContainText('city')
  await frame(page).locator('#scope').getByRole('radio', { name: 'Documents filter' }).click()
  await expect(frame(page).getByText('Nothing found')).toBeVisible()
  // User report 2026-10-16: a result opened in Documents, and back in Search the results are still
  // there; the one-document filter Open left is not offered as the Documents filter.
  await frame(page).getByRole('button', { name: 'Search the whole collection' }).click()
  await expect(frame(page).locator('.vs-row')).toHaveCount(1)
  await frame(page).locator('.vs-row').getByRole('button', { name: 'Open' }).click()
  await expect(section(page, 'Documents')).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('tbody tr')).toHaveCount(1)
  await section(page, 'Search').click()
  await expect(frame(page).locator('.vs-row')).toHaveCount(1)
  await expect(frame(page).locator('.vs-scope')).toBeHidden()

  // SQL: a JOIN runs here, the joined customer's fields as columns; Format lays the SQL out
  // (user request 2026-10-10).
  await section(page, 'SQL').click()
  await frame(page)
    .locator('#sql')
    .fill(
      'select o.city, c.name from orders o join customers c on o.customerId = c._id where o.city = ' +
        "'Izmir'",
    )
  await frame(page).locator('#format').click()
  await expect(frame(page).locator('#sql')).toHaveValue(
    [
      'SELECT',
      '  o.city,',
      '  c.name',
      'FROM orders o',
      'JOIN customers c',
      '  ON o.customerId = c._id',
      "WHERE o.city = 'Izmir'",
    ].join('\n'),
  )
  await frame(page).locator('#run').click()
  await expect(frame(page).locator('#results thead')).toContainText('c.name')
  await expect(frame(page).locator('#results tbody tr')).toHaveCount(2)
  await expect(frame(page).locator('#results tbody')).toContainText('Ada')

  // Document diff: one order beside another.
  await section(page, 'Documents').click()
  const filter = page.getByRole('search', { name: 'Filter' }).getByRole('textbox').first()
  await filter.fill('')
  await filter.press('Enter')
  await expect(page.locator('tbody tr')).toHaveCount(3)
  await page
    .locator('tbody')
    .getByRole('button', { name: /^Actions for/ })
    .first()
    .click()
  await page.getByRole('menuitem', { name: 'Compare with…' }).click()
  const diff = page.frameLocator('[role="dialog"] [data-plugin-frame] iframe')
  await diff.locator('#list').selectOption({ index: 1 })
  await expect(diff.locator('[data-kind="changed"]').first()).toBeVisible()
  await expect(diff.locator('#status')).toContainText('changed')
  await page.keyboard.press('Escape')
})
