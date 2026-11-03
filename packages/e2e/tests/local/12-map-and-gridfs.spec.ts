import { readFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { expect, test } from '../../fixtures'

/** A connection to the test MongoDB, a database with one collection holding the given documents. */
async function collection(page: Page, db: string, docs: string[]): Promise<string> {
  await page.goto('/')
  await page.getByRole('button', { name: 'Add connection' }).click()
  // User report 2026-10-16: the connection string is the form's first field and fills it by itself.
  await page.getByLabel('Connection string').fill(process.env.MM_E2E_MONGO_URI!)
  await page.getByLabel('Connection string').press('Enter')
  await expect(page.locator('[data-uri-status]')).toContainText('Read:')
  await page.getByLabel('Name', { exact: true }).fill(`E2E ${db}`)
  await page.getByLabel('Name', { exact: true }).press('Enter')
  await expect(page.getByText('Connection saved.')).toBeVisible()
  await page.getByRole('button', { name: 'New database' }).click()
  await page.getByLabel('Database name').fill(db)
  await page.getByLabel('First collection').fill('places')
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await page.getByRole('button', { name: 'places', exact: true }).click()
  for (const doc of docs) {
    await page.getByRole('button', { name: 'Add documents' }).first().click()
    await page.getByRole('textbox', { name: 'Document', exact: true }).fill(doc)
    await page.getByRole('button', { name: 'Insert', exact: true }).click()
    // Saved and closed before the next one: typed while it saves, a document waited on the old pane.
    await expect(page.locator('[data-inspector]')).toHaveCount(0)
  }
  await expect(page.locator('tbody tr')).toHaveCount(docs.length)
  return page.url()
}

// Phase 4b §4: the map plugin ships with the build, waits for an administrator, then draws a
// collection's points — in a tab, for one document, and as cell text.
test('the map plugin: approved, it shows a collection’s points', async ({ page }) => {
  const url = await collection(page, 'geo', [
    "{ name: 'Istanbul', loc: { type: 'Point', coordinates: [28.97, 41.01] } }",
    "{ name: 'Ankara', loc: { type: 'Point', coordinates: [32.85, 39.93] } }",
  ])
  await page.goto('/plugins')
  const card = page.locator('[data-plugin="geojson-map"]')
  await expect(card).toContainText('Shipped with Mongo Manager')
  await expect(card.locator('[data-plugin-status]')).toHaveText('Waiting for approval')
  await card.getByRole('button', { name: 'Approve and enable' }).click()
  await page.locator('[data-test="confirm"]').click()
  await expect(card.locator('[data-plugin-status]')).toHaveText('Enabled')

  await page.goto(url)
  // Its cell renderer: a point reads as "lat, lng" beside the value.
  await expect(page.locator('[data-plugin-cell]').first()).toHaveText(
    /^(41\.01000, 28\.97000|39\.93000, 32\.85000)$/,
  )
  await page.getByRole('tablist', { name: 'Collection sections' }).getByRole('tab', { name: 'Map' }).click()
  const status = page.frameLocator('[data-plugin-frame] iframe').locator('#status')
  await expect(status).toHaveText('2 shapes in 2 documents')
  const map = page.frameLocator('[data-plugin-frame] iframe')
  await expect(map.locator('#map svg.gm-svg')).toBeVisible()
  // A shape opens its document (from the list of shapes: the keyboard's way to the same thing).
  await map.locator('#shapes summary').click()
  await map
    .getByRole('row', { name: /Istanbul/ })
    .getByRole('button', { name: 'Open' })
    .click()
  await expect(
    page.getByRole('tablist', { name: 'Collection sections' }).getByRole('tab', { name: 'Documents' }),
  ).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('tbody tr')).toHaveCount(1)
  await expect(page.locator('tbody')).toContainText('Istanbul')
  // The map draws the documents of the current query.
  await page.getByRole('tablist', { name: 'Collection sections' }).getByRole('tab', { name: 'Map' }).click()
  await expect(status).toHaveText('1 shape in 1 document')

  // "Show on map" from a document's menu draws that document alone.
  await page
    .getByRole('tablist', { name: 'Collection sections' })
    .getByRole('tab', { name: 'Documents' })
    .click()
  const filter = page.getByRole('search', { name: 'Filter' }).getByRole('textbox').first()
  await filter.fill('')
  await filter.press('Enter')
  await expect(page.locator('tbody tr')).toHaveCount(2)
  await page
    .locator('tbody')
    .getByRole('button', { name: /^Actions for/ })
    .first()
    .click()
  await page.getByRole('menuitem', { name: 'Show on map' }).click()
  await expect(page.frameLocator('[role="dialog"] [data-plugin-frame] iframe').locator('#status')).toHaveText(
    '1 shape in 1 document',
  )
  // Left as found for the tests after this one: the plugin is disabled again.
  await page.keyboard.press('Escape')
  await page.goto('/plugins')
  await page.locator('[data-plugin="geojson-map"]').getByRole('button', { name: 'Disable' }).click()
  await expect(page.locator('[data-plugin="geojson-map"] [data-plugin-status]')).toHaveText('Disabled')
})

// Phase 4b §1: a GridFS bucket's files — uploaded, downloaded as they were, deleted.
test('GridFS: upload, download and delete a file', async ({ page }) => {
  const url = await collection(page, 'files', ["{ name: 'x' }"])
  const bucket = url.replace(/\/coll\/places.*$/, '/gridfs/fs')
  await page.goto(bucket)
  await page.locator('input[data-gridfs-upload]').setInputFiles({
    name: 'notes – ünïcode.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('kept as it was'),
  })
  // UI redesign R3 leftovers: a file is a data table row; its name cell is marked.
  const row = page.locator('tr', {
    has: page.locator('[data-gridfs-file]', { hasText: 'notes – ünïcode.txt' }),
  })
  await expect(row).toBeVisible()
  await expect(row).toContainText('text/plain')
  // Its preview: the text as text, then an image drawn from the bytes the app fetched (user request
  // 2026-10-10).
  await row.locator('button[data-gridfs-preview]').click()
  const preview = page.locator('[data-gridfs-preview-panel]')
  await expect(preview.locator('pre').first()).toHaveText('kept as it was')
  await page.locator('input[data-gridfs-upload]').setInputFiles({
    name: 'dot.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
      'base64',
    ),
  })
  const image = page.locator('tr', { has: page.locator('[data-gridfs-file]', { hasText: 'dot.png' }) })
  await image.locator('button[data-gridfs-preview]').click()
  await expect(preview.locator('img')).toHaveJSProperty('naturalWidth', 1)
  await page.getByRole('button', { name: 'Close the preview' }).click()
  await expect(preview).toHaveCount(0)
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    row.locator('a[data-gridfs-download]').click(),
  ])
  expect(download.suggestedFilename()).toBe('notes – ünïcode.txt')
  expect(readFileSync(await download.path(), 'utf8')).toBe('kept as it was')
  await row.getByRole('button', { name: /^Actions for/ }).click()
  await page.getByRole('menuitem', { name: 'Delete' }).click()
  await page.locator('[data-test="confirm"]').click()
  await expect(row).toHaveCount(0)
  // The image stays: one file left.
  await expect(page.locator('[data-gridfs-file]')).toHaveCount(1)
})
