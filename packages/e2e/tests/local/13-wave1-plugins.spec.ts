import type { Page } from '@playwright/test'
import { expect, test } from '../../fixtures'

/** A connection, a database and a collection holding these documents; the collection's address. */
async function people(page: Page): Promise<string> {
  await page.goto('/')
  await page.getByRole('button', { name: 'Add connection' }).click()
  // User report 2026-10-16: the connection string is the form's first field and fills it by itself.
  await page.getByLabel('Connection string').fill(process.env.MM_E2E_MONGO_URI!)
  await page.getByLabel('Connection string').press('Enter')
  await expect(page.locator('[data-uri-status]')).toContainText('Read:')
  await page.getByLabel('Name', { exact: true }).fill('Wave 1')
  await page.getByLabel('Name', { exact: true }).press('Enter')
  await expect(page.getByText('Connection saved.')).toBeVisible()
  await page.getByRole('button', { name: 'New database' }).click()
  await page.getByLabel('Database name').fill('wave')
  await page.getByLabel('First collection').fill('people')
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await page.getByRole('button', { name: 'people', exact: true }).click()
  for (const doc of [
    "{ name: 'Ada', email: 'ada@example.com', age: 36 }",
    "{ name: 'Bob', email: 'ADA@example.com', age: 20 }",
    "{ name: 'Cem', email: 'cem@example.com', age: 41 }",
  ]) {
    await page.getByRole('button', { name: 'Add documents' }).first().click()
    await page.getByRole('textbox', { name: 'Document', exact: true }).fill(doc)
    await page.getByRole('button', { name: 'Insert', exact: true }).click()
    // Saved and closed before the next one: typed while it saves, a document waited on the old pane.
    await expect(page.locator('[data-inspector]')).toHaveCount(0)
  }
  await expect(page.locator('tbody tr')).toHaveCount(3)
  return page.url()
}

async function approve(page: Page, id: string): Promise<void> {
  const card = page.locator(`[data-plugin="${id}"]`)
  await card.getByRole('button', { name: 'Approve and enable' }).click()
  await page.locator('[data-test="confirm"]').click()
  await expect(card.locator('[data-plugin-status]')).toHaveText('Enabled')
}

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

const WAVE1 = ['time-hints', 'duplicate-finder', 'sql-to-mongodb']
test.afterEach(async ({ page }) => disableAll(page, WAVE1))

const section = (page: Page, name: string) =>
  page.getByRole('tablist', { name: 'Collection sections' }).getByRole('tab', { name, exact: true })

// Plugins wave 1 (user request 2026-10-10): SQL to MongoDB, time hints and the duplicate finder,
// in Chrome, through the app's own Documents.
test('the wave 1 plugins: time hints, duplicates and SQL, each landing in Documents', async ({ page }) => {
  const url = await people(page)
  await page.goto('/plugins')
  for (const id of WAVE1) await approve(page, id)

  await page.goto(url)
  // Time hints (user request 2026-10-13): when each ObjectId was made, in a tooltip its cell shows —
  // the whole id, then the time under the plugin's name — never written beside it.
  const tooltip = page.getByRole('tooltip', { includeHidden: true })
  await page.locator('td[data-field="_id"]').first().hover()
  await expect(tooltip).toContainText(/ObjectId\(["'][0-9a-f]{24}["']\)\s*Time hints: .*\d{4}/)
  await expect(page.locator('[data-plugin-cell]')).toHaveCount(0)
  // User report 2026-10-13: in a collection of many fields, beside an _id the date was cut to "…".
  // The value is whole, and its date is in the tooltip over it.
  await page.goto(url.replace(/\/db\/.*$/, ''))
  await page.getByRole('button', { name: 'New database' }).click()
  await page.getByLabel('Database name').fill('wavewide')
  await page.getByLabel('First collection').fill('orders')
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await page.getByRole('button', { name: 'orders', exact: true }).click()
  await page.getByRole('button', { name: 'Add documents' }).first().click()
  await page
    .getByRole('textbox', { name: 'Document', exact: true })
    .fill(
      "{ orderNo: 'ORD-10001', customerId: ObjectId('6ac625df13a09509ca0da19c'), status: 'shipped', " +
        "items: [{ q: 1 }, { q: 2 }], total: NumberDecimal('234.20'), currency: 'EUR', tags: [], " +
        "note: 'leave at the door please', createdAt: ISODate('2026-10-07T10:58:00Z'), city: 'Amsterdam' }",
    )
  await page.getByRole('button', { name: 'Insert', exact: true }).click()
  await expect(page.locator('tbody tr')).toHaveCount(1)
  for (const field of ['_id', 'customerId']) {
    const cell = page.locator(`td[data-field="${field}"]`).first()
    await expect(cell.locator('[data-plugin-cell]')).toHaveCount(0)
    const fits = await cell.evaluate((td) => {
      // The browser's boxes (this package is typed for Node, not the DOM).
      type Box = { scrollWidth: number; clientWidth: number; getBoundingClientRect(): { right: number } }
      const value = td.querySelector('[data-plugin-tip]') as unknown as Box | null
      return {
        valueInside: !!value && value.getBoundingClientRect().right <= td.getBoundingClientRect().right,
        valueWhole: !!value && value.scrollWidth <= value.clientWidth,
      }
    })
    expect([field, fits]).toEqual([field, { valueInside: true, valueWhole: true }])
    await cell.hover()
    // customerId was made on 7 Oct 2026; the _id, now.
    const said = field === '_id' ? /[0-9a-f]{24}[\s\S]*\d{4}/ : /6ac625df13a09509ca0da19c[\s\S]*2026/
    await expect(tooltip).toContainText(said)
    await page.mouse.move(0, 0)
    await expect(tooltip).toHaveCount(0)
    // The keyboard reaches a cell it can edit, and Escape puts the tip away (review 2026-10-13, I1
    // and M4); an _id is never edited in its cell.
    if (field === 'customerId') {
      await cell.focus()
      await expect(tooltip).toContainText(said)
      await page.keyboard.press('Escape')
      await expect(tooltip).toHaveCount(0)
    }
  }
  await page.goto(url)

  // Duplicates: the two addresses that differ only in case.
  await section(page, 'Duplicates').click()
  const dup = page.frameLocator('[data-plugin-frame] iframe')
  // The field suggestions arrive after the page and push the switches down: a click then misses.
  await expect(dup.locator('#suggestions button').first()).toBeVisible()
  await dup.locator('#fields').fill('email')
  await dup.getByRole('switch', { name: 'Ignore letter case' }).check()
  await dup.getByRole('button', { name: 'Find duplicates' }).click()
  await expect(dup.locator('#status')).toContainText('1 duplicated value · 2 documents involved')
  await expect(dup.locator('tbody tr')).toHaveCount(1)
  await expect(dup.locator('tbody td.count')).toHaveText('2')
  await dup.getByRole('button', { name: 'Show' }).click()
  await expect(section(page, 'Documents')).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('tbody tr')).toHaveCount(2)
  await expect(page.locator('tbody')).toContainText('Bob')

  // SQL: a SELECT as the Documents query.
  await section(page, 'SQL').click()
  const sql = page.frameLocator('[data-plugin-frame] iframe')
  await sql.locator('#sql').fill('SELECT name, age FROM people WHERE age > 30 ORDER BY name')
  await expect(sql.locator('#code')).toContainText('age: { $gt: 30 }')
  // Run shows the rows here, and Clear takes them away (user requests 2026-10-10).
  await sql.locator('#run').click()
  await expect(sql.locator('#results tbody tr')).toHaveCount(2)
  await expect(sql.locator('#results')).toContainText('Cem')
  await sql.locator('#clear-results').click()
  await expect(sql.locator('#results tbody tr')).toHaveCount(0)
  // User request 2026-10-11: the tab only translates and runs; SQL files are the app's SQL ↔ MongoDB
  // page, which the plugin no longer has a sidebar entry for.
  await expect(sql.locator('#import-sql')).toHaveCount(0)
  await expect(sql.locator('#export-sql')).toHaveCount(0)
  await expect(page.locator('[data-sidebar-plugin-page]', { hasText: 'SQL to MongoDB' })).toHaveCount(0)
  await page.locator('[data-sidebar-sql]').click()
  await expect(page.locator('[data-sql-target]')).toBeVisible()
  await expect(page.locator('[data-sql-database] select')).toHaveValue('wave')
  await page.getByRole('button', { name: 'Close tab SQL ↔ MongoDB' }).click()
  await expect(page.locator('[data-sql-transfer]')).toHaveCount(0)
  await page
    .getByRole('tab', { name: /people/ })
    .first()
    .click()
  await section(page, 'SQL').click()
  // Suggestions as it is typed: "na" after WHERE finds the collection's field "name".
  await sql.locator('#sql').fill('SELECT * FROM people WHERE ')
  await sql.locator('#sql').press('End')
  await sql.locator('#sql').pressSequentially('na')
  await expect(sql.locator('#sql-complete [role="option"]').first()).toContainText('name')
  await sql.locator('#sql').press('Tab')
  await expect(sql.locator('#sql')).toHaveValue('SELECT * FROM people WHERE name ')
  await sql.locator('#sql').fill('SELECT name, age FROM people WHERE age > 30 ORDER BY name')
  await expect(sql.locator('#code')).toContainText('age: { $gt: 30 }')
  await sql.getByRole('button', { name: 'Use in Documents' }).click()
  await expect(section(page, 'Documents')).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('tbody tr')).toHaveCount(2)
  await expect(page.locator('tbody')).toContainText('Cem')
  await expect(page.locator('tbody')).not.toContainText('Bob')

  // SQL: stages put in Aggregations run nothing, not even a preview, until the user asks (review I2).
  await section(page, 'SQL').click()
  const sql2 = page.frameLocator('[data-plugin-frame] iframe')
  await sql2.locator('#sql').fill('SELECT name, COUNT(*) AS n FROM people GROUP BY name')
  await expect(sql2.locator('#code')).toContainText('$group')
  await sql2.getByRole('button', { name: 'Open in Aggregations' }).click()
  await expect(section(page, 'Aggregations')).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('[data-handed]')).toContainText('SQL to MongoDB')
  await page.getByRole('button', { name: 'Preview these stages' }).click()
  await expect(page.locator('[data-handed]')).toHaveCount(0)
})
