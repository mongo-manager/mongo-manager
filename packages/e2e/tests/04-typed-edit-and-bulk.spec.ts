// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { Page } from '@playwright/test'
import { expect, rowNamed, signIn, test } from '../fixtures'

/** The API as the signed-in page sees it (same cookies, its CSRF token and origin). */
async function api(page: Page, path: string, data: object) {
  const me = await (await page.request.get('api/auth/me')).json()
  const origin = new URL(page.url()).origin
  const res = await page.request.post(`api/${path}`, {
    data,
    headers: { 'x-csrf-token': me.csrfToken, origin },
  })
  expect(res.ok(), await res.text()).toBe(true)
  return res.json()
}

async function openOrders(page: Page): Promise<string> {
  // Signed in once the workspace shows.
  await expect(page.getByRole('button', { name: /^Account menu/ })).toBeVisible()
  const connections = (await (await page.request.get('api/connections')).json()) as Array<{
    id: string
    name: string
  }>
  const id = connections.find((c) => c.name === 'Local test')!.id
  // A deep link opens the collection tab (phase 1g-2).
  await page.goto(`c/${id}/db/shop/coll/orders`)
  await expect(rowNamed(page, 'Ada')).toBeVisible()
  return id
}

test('an edited number keeps its BSON type, in the table and in the editor (spec §9)', async ({ page }) => {
  await signIn(page)
  const id = await openOrders(page)
  const orders = `connections/${id}/databases/shop/collections/orders`
  const qtyOf = async () =>
    (
      (await api(page, `${orders}/find`, { filter: { name: 'Ada' } })).documents[0].document as {
        qty: unknown
      }
    ).qty

  expect(await qtyOf()).toEqual({ $numberInt: '6' }) // edited in 01-first-run
  const cell = rowNamed(page, 'Ada').locator('td[data-field="qty"]')
  await cell.dblclick()
  const input = page.getByRole('textbox', { name: /^Edit qty of document/ })
  await input.fill('7')
  await input.press('Enter')
  await expect(page.getByText('Field saved.')).toBeVisible()
  expect(await qtyOf()).toEqual({ $numberInt: '7' })

  await page
    .getByRole('button', { name: /^Actions for document/ })
    .first()
    .click()
  await page.getByRole('menuitem', { name: 'Edit' }).click()
  const editor = page.getByRole('textbox', { name: 'Document', exact: true })
  await expect(editor).toHaveValue(/"qty": 7\b/)
  await editor.fill((await editor.inputValue()).replace(/"qty": 7\b/, '"qty": 8'))
  await editor.press('Control+Enter')
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByText('Document saved.')).toBeVisible()
  expect(await qtyOf()).toEqual({ $numberInt: '8' })
})

test('bulk delete previews, and deleting everything needs the collection name typed (spec §9)', async ({
  page,
}) => {
  await signIn(page)
  await openOrders(page)
  const bulk = async () => {
    await page.getByRole('button', { name: 'More actions for these results' }).click()
    await page.getByRole('menuitem', { name: 'Delete many' }).click()
  }
  await bulk()
  await page.getByRole('dialog').getByRole('textbox', { name: 'Filter', exact: true }).fill("{ name: 'Bob' }")
  await page.getByRole('dialog').getByRole('button', { name: 'Preview', exact: true }).click()
  await expect(page.getByText('1 of 2 documents match.')).toBeVisible()
  await page.getByRole('dialog').getByRole('button', { name: 'Run', exact: true }).click()
  await expect(page.getByText('1 document deleted.')).toBeVisible()
  await expect(page.locator('tbody')).not.toContainText('Bob')

  await bulk()
  await page.getByRole('dialog').getByRole('textbox', { name: 'Filter', exact: true }).fill('{}')
  await page.getByRole('dialog').getByRole('button', { name: 'Preview', exact: true }).click()
  await expect(page.getByText('This affects every document in orders.')).toBeVisible()
  const run = page.getByRole('dialog').getByRole('button', { name: 'Run', exact: true })
  await expect(run).toBeDisabled()
  await page.getByLabel('Type orders to confirm').fill('orders')
  await run.click()
  // The first delete's message may still be up: the newest one is this delete's.
  await expect(page.getByText('1 document deleted.').last()).toBeVisible()
  await expect(page.getByText('This collection has no documents yet')).toBeVisible()
})
