// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { Page } from '@playwright/test'
import { expect, signIn, test } from '../fixtures'

/**
 * W2 of the completion design (2026-10-16): the Schema tab's click-to-filter and offline map, a
 * view's pipeline edited in the builder, the bulk preview's samples, a collection made with a
 * collation and pre/post images (and Edit collection), and the stage operator combobox. Runs after
 * 01-first-run (the admin and the "Local test" connection); its own data lives in the w2 database.
 */

/** The API as the signed-in page sees it (same cookies, its CSRF token and origin). */
async function api(page: Page, method: 'POST' | 'DELETE', path: string, data: object = {}) {
  const me = await (await page.request.get('api/auth/me')).json()
  const origin = new URL(page.url()).origin
  const res = await page.request.fetch(`api/${path}`, {
    method,
    data,
    headers: { 'x-csrf-token': me.csrfToken, origin },
  })
  expect(res.ok(), await res.text()).toBe(true)
  return res.status() === 204 ? null : res.json()
}

async function connectionId(page: Page): Promise<string> {
  await expect(page.getByRole('button', { name: /^Account menu/ })).toBeVisible()
  const connections = (await (await page.request.get('api/connections')).json()) as Array<{
    id: string
    name: string
  }>
  return connections.find((c) => c.name === 'Local test')!.id
}

/** A fresh collection of the w2 database, with these documents. */
async function seed(page: Page, id: string, coll: string, documents: object[]): Promise<void> {
  const base = `connections/${id}/databases/w2/collections`
  const listed = (await (await page.request.get(`api/${base}`)).json()) as Array<{ name: string }>
  if (Array.isArray(listed) && listed.some((c) => c.name === coll))
    await api(page, 'DELETE', `${base}/${coll}`, { confirm: coll })
  await api(page, 'POST', `${base}/${coll}/documents`, { documents })
}

test('a Schema value, range or map area filters the documents, drawn offline (W2.1)', async ({ page }) => {
  await signIn(page)
  const id = await connectionId(page)
  await seed(page, id, 'places', [
    { name: 'Ada', qty: 1, at: { type: 'Point', coordinates: [29.0, 41.0] } },
    { name: 'Ada', qty: 5, at: { type: 'Point', coordinates: [28.9, 41.1] } },
    { name: 'Bob', qty: 9, at: { type: 'Point', coordinates: [-74.0, 40.7] } },
  ])
  await page.goto(`c/${id}/db/w2/coll/places`)
  await page.getByRole('tab', { name: 'Schema' }).click()
  await page.getByRole('button', { name: 'Analyse' }).click()
  await page.getByRole('button', { name: 'Details of name', exact: true }).click()
  await page.getByRole('button', { name: /^Filter the documents by Ada/ }).click()
  await expect(page.getByRole('tab', { name: 'Documents' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('tbody tr')).toHaveCount(2)
  await expect(page.locator('tbody')).not.toContainText('Bob')

  // The map: the world outline and the places, from the app alone (the fixture fails on any request
  // to another origin), and its area as a filter (in a collection of its own: no filter typed yet).
  await seed(page, id, 'map', [
    { at: { type: 'Point', coordinates: [29.0, 41.0] } },
    { at: { type: 'Point', coordinates: [28.9, 41.1] } },
    { at: { type: 'Point', coordinates: [-74.0, 40.7] } },
  ])
  await page.goto(`c/${id}/db/w2/coll/map`)
  await page.getByRole('tab', { name: 'Schema' }).click()
  await page.getByRole('button', { name: 'Analyse' }).click()
  await page.getByRole('button', { name: 'Details of at', exact: true }).click()
  const map = page.getByRole('application', { name: 'Map of 3 places in at' })
  await expect(map).toBeVisible()
  await expect(map.locator('circle')).toHaveCount(3)
  await map.focus()
  for (let i = 0; i < 3; i++) await page.keyboard.press('+')
  await page.getByRole('button', { name: 'Whole world' }).click()
  await expect(page.getByText('Zoom in to filter')).toBeVisible()
  // W2 review (I2): the places fitted lie near the area's south edge, 100° apart: MongoDB keeps every
  // one of them (a bare great-circle edge would bow north past them).
  await page.getByRole('button', { name: 'Fit the places' }).click()
  await page.getByRole('button', { name: 'Filter to this area' }).click()
  await expect(page.getByRole('tab', { name: 'Documents' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('tbody tr')).toHaveCount(3)
})

test("a view's pipeline is edited in its source's builder and written back (W2.2)", async ({ page }) => {
  await signIn(page)
  const id = await connectionId(page)
  await seed(page, id, 'orders', [
    { item: 'a', qty: 1 },
    { item: 'b', qty: 20 },
    { item: 'c', qty: 30 },
  ])
  const base = `connections/${id}/databases/w2/collections`
  const listed = (await (await page.request.get(`api/${base}`)).json()) as Array<{ name: string }>
  if (listed.some((c) => c.name === 'big')) await api(page, 'DELETE', `${base}/big`, { confirm: 'big' })
  await api(page, 'POST', base, {
    kind: 'view',
    name: 'big',
    viewOn: 'orders',
    pipeline: [{ $match: { qty: { $gt: 10 } } }],
  })
  await page.goto(`c/${id}/db/w2/coll/big`)
  await page.getByRole('tab', { name: 'Overview' }).click()
  await page.getByRole('button', { name: 'Edit pipeline' }).click()
  // The source's builder, marked as the view's.
  const banner = page.getByRole('region', { name: 'Editing a view' })
  await expect(banner).toContainText('big')
  await expect(page.locator('[data-stage]')).toHaveCount(1)
  await page.getByRole('button', { name: 'Add stage' }).click()
  await page.getByRole('combobox', { name: 'Find a stage' }).fill('limit')
  await page.keyboard.press('Enter')
  await expect(page.locator('[data-stage]')).toHaveCount(2)
  await banner.getByRole('button', { name: 'Update view' }).click()
  await expect(page.getByRole('dialog', { name: 'Update the view big?' })).toBeVisible()
  await page
    .getByRole('dialog', { name: 'Update the view big?' })
    .getByRole('button', { name: 'Update view' })
    .click()
  await expect(page.getByText('The view big was updated.')).toBeVisible()
  const views = (await (await page.request.get(`api/${base}`)).json()) as Array<{
    name: string
    options: { pipeline?: unknown[] }
  }>
  expect(views.find((c) => c.name === 'big')!.options.pipeline).toHaveLength(2)
})

test('a bulk update preview shows sampled documents before and after (W2.3)', async ({ page }) => {
  await signIn(page)
  const id = await connectionId(page)
  await seed(page, id, 'stock', [
    { item: 'a', qty: 1 },
    { item: 'b', qty: 'many' },
  ])
  await page.goto(`c/${id}/db/w2/coll/stock`)
  await expect(page.locator('tbody')).toContainText('many')
  await page.getByRole('button', { name: 'More actions for these results' }).click()
  await page.getByRole('menuitem', { name: 'Update many' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('textbox', { name: 'Filter', exact: true }).fill('{}')
  await dialog.getByRole('textbox', { name: 'Update', exact: true }).fill('{ $inc: { qty: 1 } }')
  await dialog.getByRole('button', { name: 'Preview', exact: true }).click()
  const samples = dialog.locator('[data-bulk-sample]')
  await expect(samples).toHaveCount(2)
  await expect(samples.first().locator('[data-kind="changed"]')).toContainText('qty')
  await expect(samples.nth(1)).toContainText('The update would fail on this document')
  // Nothing was written by the preview.
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  const back = await api(page, 'POST', `connections/${id}/databases/w2/collections/stock/find`, {
    filter: { item: 'a' },
  })
  expect(back.documents[0].document.qty).toEqual({ $numberInt: '1' })
})

test('a collection made with a collation and pre/post images, then edited (W2.4)', async ({ page }) => {
  await signIn(page)
  const id = await connectionId(page)
  const base = `connections/${id}/databases/w2/collections`
  const listed = (await (await page.request.get(`api/${base}`)).json()) as Array<{ name: string }>
  if (listed.some((c) => c.name === 'people'))
    await api(page, 'DELETE', `${base}/people`, { confirm: 'people' })
  await page.goto(`c/${id}/db/w2`)
  await page.getByRole('button', { name: 'New collection' }).first().click()
  const dialog = page.getByRole('dialog', { name: 'New collection' })
  await dialog.getByLabel('Collection name').fill('people')
  await dialog.getByLabel('Change-stream pre- and post-images').check()
  await dialog.getByLabel('Use a default collation').check()
  await dialog.getByLabel('Locale').selectOption('tr')
  await dialog.getByLabel('Strength').selectOption('2')
  await dialog.getByRole('button', { name: 'Create' }).click()
  // The new collection's tab says what it was made with.
  const header = page.locator('h2', { hasText: 'people' }).first()
  await expect(header).toContainText('collation: tr')
  await expect(header).toContainText('pre/post images')

  await page.getByRole('button', { name: 'More actions for people' }).click()
  await page.getByRole('menuitem', { name: 'Edit collection…' }).click()
  const edit = page.getByRole('dialog', { name: 'Edit people' })
  await expect(edit).toContainText('strength 2')
  await edit.getByRole('switch', { name: 'Change-stream pre- and post-images' }).uncheck()
  await edit.getByRole('button', { name: 'Save' }).click()
  await page
    .getByRole('dialog', { name: 'Turn off pre- and post-images?' })
    .getByRole('button', { name: 'Turn off' })
    .click()
  await expect(page.getByText('Pre- and post-images are off for people.')).toBeVisible()
  await expect(header).not.toContainText('pre/post images')
})

test('a stage operator is found by what it does, from the keyboard (W2.5)', async ({ page }) => {
  await signIn(page)
  const id = await connectionId(page)
  await seed(page, id, 'stages', [{ a: 1 }])
  await page.goto(`c/${id}/db/w2/coll/stages`)
  await page.getByRole('tab', { name: 'Aggregations' }).click()
  await page.getByRole('button', { name: 'Add a $match stage' }).first().click()
  const operator = page.locator('[data-stage]').getByRole('combobox', { name: 'Operator' })
  await expect(operator).toHaveValue('$match')
  await operator.click()
  await operator.fill('join')
  // Beside the list: what the stage does and an example.
  await expect(page.locator('[data-stage-detail]')).toContainText('Joins documents from another collection')
  await page.keyboard.press('Enter')
  await expect(operator).toHaveValue('$lookup')
})
