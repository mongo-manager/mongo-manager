// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { type Page } from '@playwright/test'
import { ADMIN, expect, signIn, test, watchCsp, watchOrigins } from '../fixtures'

/**
 * Phase 3c-2: a restricted editor edits a field next to a hidden one, and clones the document
 * without it; the stored personal value never changes. Setup goes through the REST API.
 */
const WRITER = { username: 'masked-writer', password: 'cedar-meadow-quartz-58' }
const SECRET = 'e2e-write@x'

async function csrf(page: Page): Promise<string> {
  return ((await (await page.request.get('api/auth/me')).json()) as { csrfToken: string }).csrfToken
}

async function connectionId(page: Page): Promise<string> {
  const list = (await (await page.request.get('api/connections')).json()) as Array<{
    id: string
    name: string
  }>
  return list.find((c) => c.name === 'Local test')!.id
}

test('a restricted editor edits beside a hidden field, and clones without it (phase 3c-2)', async ({
  page,
  browser,
  baseURL,
  cspViolations,
  foreignRequests,
}) => {
  await signIn(page)
  await expect(page.getByRole('button', { name: /^Account menu/ })).toBeVisible()
  const id = await connectionId(page)
  const ns = `api/connections/${id}/databases/shop/collections/e2ewrite`
  const headers = { 'x-csrf-token': await csrf(page) }

  expect(
    (
      await page.request.post(`${ns}/documents`, {
        data: { documents: [{ email: SECRET, name: 'Writer' }] },
        headers,
      })
    ).ok(),
  ).toBe(true)
  expect(
    (
      await page.request.put(`api/connections/${id}/personal-fields`, {
        data: { rules: [{ db: 'shop', coll: 'e2ewrite', field: 'email' }] },
        headers,
      })
    ).ok(),
  ).toBe(true)
  const created = await page.request.post('api/users', {
    data: { ...WRITER, role: 'editor', currentPassword: ADMIN.password },
    headers,
  })
  expect(created.ok()).toBe(true)
  const { id: userId } = (await created.json()) as { id: string }
  expect(
    (
      await page.request.put(`api/connections/${id}/grants/${userId}`, {
        data: { role: 'editor', masked: true },
        headers,
      })
    ).ok(),
  ).toBe(true)

  const other = await browser.newContext({ locale: 'en-US' })
  const writer = await other.newPage()
  watchCsp(writer, cspViolations)
  watchOrigins(writer, new URL(baseURL!).origin, foreignRequests)
  await signIn(writer, WRITER)
  await expect(writer.getByRole('button', { name: /^Account menu/ })).toBeVisible()
  await writer.goto(`c/${id}/db/shop/coll/e2ewrite`)
  await expect(writer.locator('tbody tr', { hasText: 'Writer' })).toBeVisible({ timeout: 15_000 })

  // An edit beside the hidden value is saved; the hidden cell keeps its lock.
  const row = writer.locator('tbody tr', { hasText: 'Writer' })
  await row.locator('td[data-field="name"]').dblclick()
  const input = writer.getByRole('textbox', { name: /^Edit name of document/ })
  await input.fill('Writer 2')
  await input.press('Enter')
  await expect(writer.getByText('Field saved.')).toBeVisible()
  await expect(
    writer.locator('tbody tr', { hasText: 'Writer 2' }).locator('td[data-field="email"] [data-masked]'),
  ).toBeVisible()

  // A clone leaves the hidden field out and says so.
  await writer
    .getByRole('button', { name: /^Actions for document/ })
    .first()
    .click()
  await writer.getByRole('menuitem', { name: 'Clone' }).click()
  await expect(writer.locator('[data-clone-dropped]')).toContainText('email')
  await expect(writer.getByRole('textbox', { name: 'Document', exact: true })).not.toHaveValue(/email/)
  await writer.getByRole('button', { name: 'Insert', exact: true }).click()
  await expect(writer.getByText('1 document inserted.')).toBeVisible()
  await expect(writer.locator('body')).not.toContainText(SECRET)
  await other.close()

  // As the admin: the stored value is unchanged, and the rules are cleared for later specs.
  const found = await page.request.post(`${ns}/find`, { data: { filter: { name: 'Writer 2' } }, headers })
  const docs = ((await found.json()) as { documents: Array<{ document: { email?: unknown } }> }).documents
  expect(docs[0]!.document.email).toBe(SECRET)
  expect(
    (await page.request.put(`api/connections/${id}/personal-fields`, { data: { rules: [] }, headers })).ok(),
  ).toBe(true)
})
