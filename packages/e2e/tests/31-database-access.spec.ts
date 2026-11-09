// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { type Page } from '@playwright/test'
import { MongoClient } from 'mongodb'
import { expect, signIn, test } from '../fixtures'

/**
 * W3.1: Users & roles of a connection, end to end against the test MongoDB. That MongoDB runs
 * without authentication, so every command is allowed there; who may use the page, MongoDB's
 * refusals and the connection's own account are covered by the server's tests against a MongoDB
 * with authentication on (packages/server/test/database-access.test.ts).
 */
async function connectionId(page: Page): Promise<string> {
  const list = (await (await page.request.get('api/connections')).json()) as Array<{
    id: string
    name: string
  }>
  return list.find((c) => c.name === 'Local test')!.id
}

/** Signing in with the new account works (mongod authenticates even when it does not require it). */
async function canSignIn(user: string, password: string): Promise<boolean> {
  const base = new URL(process.env.MM_E2E_MONGO_URI!)
  const url = new URL(`mongodb://${base.host}/`)
  url.username = encodeURIComponent(user)
  url.password = encodeURIComponent(password)
  url.searchParams.set('authSource', 'admin')
  const client = new MongoClient(url.href, { serverSelectionTimeoutMS: 5_000 })
  try {
    await client.db('admin').command({ connectionStatus: 1 })
    return true
  } catch {
    return false
  } finally {
    await client.close()
  }
}

test('Users & roles: add a user with a generated password and a role, a custom role, then drop them (W3.1)', async ({
  page,
}) => {
  await signIn(page)
  await expect(page.getByRole('button', { name: /^Account menu/ })).toBeVisible()
  const id = await connectionId(page)
  await page.goto(`c/${id}`)
  await page.getByRole('tab', { name: 'Users & roles' }).click()
  const view = page.locator('[data-database-access]')
  await expect(view.getByRole('heading', { name: 'Database users' })).toBeVisible()

  // A user, its password generated in the browser and shown once to copy.
  await view.getByRole('button', { name: 'Add user' }).first().click()
  const sheet = page.locator('[data-user-editor]')
  await sheet.getByLabel('Username').fill('e2e-app')
  await sheet.getByRole('button', { name: 'Generate' }).click()
  const password = await sheet.locator('input[data-db-password]').inputValue()
  expect(password).toHaveLength(24)
  await sheet.getByLabel('Role', { exact: true }).selectOption('builtin:readWrite')
  await sheet.getByLabel('On database', { exact: true }).fill('shop')
  await sheet.getByRole('button', { name: 'Add role' }).click()
  await expect(sheet.getByText('readWrite on shop')).toBeVisible()
  await page.locator('[data-save-user]').click()
  await expect(page.getByText('User e2e-app created in admin.')).toBeVisible()
  const row = view.getByRole('row').filter({ hasText: 'e2e-app' })
  await expect(row).toContainText('readWrite on shop')
  expect(await canSignIn('e2e-app', password)).toBe(true)

  // A custom role reading one collection.
  await view.getByRole('radio', { name: 'Custom roles' }).click()
  await view.getByRole('button', { name: 'Add custom role' }).first().click()
  const roleSheet = page.locator('[data-role-editor]')
  await roleSheet.getByLabel('Database', { exact: true }).selectOption('shop')
  await roleSheet.getByLabel('Role name').fill('orderReader')
  await roleSheet.getByRole('button', { name: 'Add privilege' }).click()
  await roleSheet.getByLabel('Privilege collection', { exact: true }).fill('orders')
  await page.locator('[data-save-role]').click()
  await expect(page.getByText('Role orderReader created in shop.')).toBeVisible()
  const roleRow = view.getByRole('row').filter({ hasText: 'orderReader' })
  await expect(roleRow).toContainText('shop.orders: find')

  // Dropped, each after its name is typed.
  await roleRow.getByRole('button', { name: 'Actions for role orderReader' }).click()
  await page.getByRole('menuitem', { name: 'Drop role' }).click()
  await page.getByLabel('Type orderReader to confirm').fill('orderReader')
  await page.getByRole('dialog').getByRole('button', { name: 'Drop role' }).click()
  await expect(page.getByText('Role orderReader dropped.')).toBeVisible()

  await view.getByRole('radio', { name: 'Users' }).click()
  await row.getByRole('button', { name: 'Actions for user e2e-app' }).click()
  await page.getByRole('menuitem', { name: 'Drop user' }).click()
  await page.getByLabel('Type e2e-app to confirm').fill('e2e-app')
  await page.getByRole('dialog').getByRole('button', { name: 'Drop user' }).click()
  await expect(page.getByText('User e2e-app dropped.')).toBeVisible()
  expect(await canSignIn('e2e-app', password)).toBe(false)

  // Audited by name, never with the password.
  const audit = (await (await page.request.get('api/audit?action=mongo.users.create')).json()) as unknown[]
  expect(audit.length).toBeGreaterThan(0)
  expect(JSON.stringify(audit)).not.toContain(password)
})
