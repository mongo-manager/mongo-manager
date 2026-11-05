// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { ADMIN, expect, rowNamed, test } from '../fixtures'

test('first run: setup wizard, connection, documents, query, edit and index', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Welcome to Mongo Manager' })).toBeVisible()
  await page.getByLabel('Setup token').fill(process.env.MM_E2E_SETUP_TOKEN!)
  await page.getByLabel('Username').fill(ADMIN.username)
  await page.getByLabel('Password', { exact: true }).fill(ADMIN.password)
  await page.getByLabel('Repeat password').fill(ADMIN.password)
  await page.getByRole('button', { name: 'Create administrator' }).click()

  await page.getByRole('button', { name: 'Add connection' }).click()
  // User report 2026-10-16: the connection string is the form's first field and fills it by itself.
  await page.getByLabel('Connection string').fill(process.env.MM_E2E_MONGO_URI!)
  await page.getByLabel('Connection string').press('Enter')
  await expect(page.locator('[data-uri-status]')).toContainText('Read:')
  await page.getByLabel('Name', { exact: true }).fill('Local test')
  await page.getByRole('button', { name: 'Test connection' }).click()
  await expect(page.getByText(/Connected: MongoDB/)).toBeVisible()
  // Enter in a field saves through the hidden submit button.
  await page.getByLabel('Name', { exact: true }).press('Enter')
  await expect(page.getByText('Connection saved.')).toBeVisible()

  await page.getByRole('button', { name: 'New database' }).click()
  await page.getByLabel('Database name').fill('shop')
  await page.getByLabel('First collection').fill('orders')
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await page.getByRole('button', { name: 'orders', exact: true }).click()

  await page.getByRole('button', { name: 'Add documents' }).first().click()
  // Bob's ObjectId spells "ada", as every one made on 2026-10-22/23 did: Ada's row is found by its
  // name cell, not by a row's text (CI 2026-10-23).
  await page
    .getByRole('textbox', { name: 'Document', exact: true })
    .fill("[{ name: 'Ada', qty: 5 }, { _id: ObjectId('6adaf89c448bd7cf0c7dc85d'), name: 'Bob', qty: 50 }]")
  await page.getByRole('button', { name: 'Insert', exact: true }).click()
  await expect(page.getByText('2 documents inserted.')).toBeVisible()
  await expect(rowNamed(page, 'Ada')).toBeVisible()

  const filter = page.getByRole('textbox', { name: 'Filter', exact: true })
  await filter.fill('{ qty: { $lt: 10 } }')
  await filter.press('Enter')
  await expect(page.getByText('1–1 of 1')).toBeVisible()

  // Bracket pairing is undoable like typing.
  await filter.fill('')
  await filter.press('{')
  await expect(filter).toHaveValue('{}')
  await filter.press('Control+z')
  await expect(filter).toHaveValue('')

  await page
    .getByRole('button', { name: /^Actions for document/ })
    .first()
    .click()
  await page.getByRole('menuitem', { name: 'Edit' }).click()
  const editor = page.getByRole('textbox', { name: 'Document', exact: true })
  await editor.fill((await editor.inputValue()).replace('"qty": 5', '"qty": 6'))
  await editor.press('Control+Enter')
  // Only the changed field is written, after the review (spec §4.2).
  const diff = page.locator('[data-test="diff"]')
  await expect(diff).toContainText('qty')
  await expect(diff.locator('li')).toHaveCount(1)
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByText('Document saved.')).toBeVisible()

  await page.getByRole('tab', { name: 'Indexes' }).click()
  await page.getByRole('button', { name: 'Create index' }).click()
  await page.getByRole('textbox', { name: 'Keys', exact: true }).fill('{ qty: 1 }')
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(page.getByText('qty_1', { exact: true })).toBeVisible()
})
