// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { type Page } from '@playwright/test'
import { ADMIN, expect, signIn, test, watchCsp, watchOrigins } from '../fixtures'

/**
 * Phase 3c-1: personal data hidden everywhere from a restricted user. The admin marks
 * shop.e2epersonal.email and shares a favourite holding a value; a viewer who cannot see personal
 * data then sees a lock instead of the value, cannot filter by it, and sees *** in the shared
 * favourite. Setup that other specs cover in the UI goes through the REST API.
 */
const VIEWER = { username: 'masked-viewer', password: 'amber-willow-orchid-73' }
const SECRET = 'e2e-secret@x'

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

test('a restricted viewer sees locks, cannot filter by a personal field, and sees *** in shared items (phase 3c-1)', async ({
  page,
  browser,
  baseURL,
  cspViolations,
  foreignRequests,
}) => {
  await signIn(page)
  await expect(page.getByRole('button', { name: /^Account menu/ })).toBeVisible()
  const id = await connectionId(page)
  const ns = `api/connections/${id}/databases/shop/collections/e2epersonal`
  const headers = { 'x-csrf-token': await csrf(page) }

  expect(
    (
      await page.request.post(`${ns}/documents`, {
        data: { documents: [{ email: SECRET, name: 'Masked One' }] },
        headers,
      })
    ).ok(),
  ).toBe(true)
  expect(
    (
      await page.request.put(`api/connections/${id}/personal-fields`, {
        data: { rules: [{ db: 'shop', coll: 'e2epersonal', field: 'email' }] },
        headers,
      })
    ).ok(),
  ).toBe(true)
  expect(
    (
      await page.request.post(`${ns}/favourites`, {
        data: { name: 'Secret one', tags: [], shared: true, query: { filter: { email: SECRET } } },
        headers,
      })
    ).ok(),
  ).toBe(true)
  const created = await page.request.post('api/users', {
    data: { ...VIEWER, role: 'viewer', currentPassword: ADMIN.password },
    headers,
  })
  expect(created.ok()).toBe(true)
  const { id: userId } = (await created.json()) as { id: string }
  expect(
    (
      await page.request.put(`api/connections/${id}/grants/${userId}`, {
        data: { role: 'viewer', masked: true },
        headers,
      })
    ).ok(),
  ).toBe(true)

  const other = await browser.newContext({ locale: 'en-US' })
  const viewerPage = await other.newPage()
  watchCsp(viewerPage, cspViolations)
  watchOrigins(viewerPage, new URL(baseURL!).origin, foreignRequests)
  await signIn(viewerPage, VIEWER)
  await expect(viewerPage.getByRole('button', { name: /^Account menu/ })).toBeVisible()

  // The document: a lock where the value is, and the hint.
  await viewerPage.goto(`c/${id}/db/shop/coll/e2epersonal`)
  await expect(viewerPage.locator('[data-masked-banner]')).toBeVisible({ timeout: 15_000 })
  await expect(viewerPage.locator('tbody [data-masked]').first()).toBeVisible()
  await expect(viewerPage.locator('tbody')).toContainText('Masked One')
  await expect(viewerPage.locator('body')).not.toContainText(SECRET)
  // W5: the JSON view locks it too, with words for a screen reader; Schema says values are hidden.
  await viewerPage.getByRole('radio', { name: 'JSON' }).click()
  const locked = viewerPage.locator('pre [data-masked]').first()
  await expect(locked).toBeVisible()
  await expect(locked.locator('.sr-only')).toHaveText('Personal data, hidden from you')
  await viewerPage.getByRole('radio', { name: 'Table' }).click()
  await viewerPage.getByRole('tab', { name: 'Schema' }).click()
  await expect(viewerPage.locator('[data-masked-banner]')).toBeVisible()
  await viewerPage.getByRole('tab', { name: 'Documents' }).click()

  // Filtering by the personal field is refused, with the reason.
  const filter = viewerPage.getByRole('textbox', { name: 'Filter', exact: true })
  await filter.fill("{ email: 'x' }")
  await filter.press('Enter')
  await expect(
    viewerPage.getByText('email holds personal data hidden from you and cannot be used here.'),
  ).toBeVisible()

  // The shared favourite shows *** in place of the value.
  await viewerPage.keyboard.press('Control+Shift+L')
  const panel = viewerPage.locator('[data-library-page]')
  await expect(panel).toBeVisible()
  const item = panel.locator('[data-library-item]', { hasText: 'Secret one' })
  await expect(item).toHaveCount(1)
  await expect(panel).not.toContainText(SECRET)
  await other.close()

  // Back as the admin: no rules, so later specs see everything.
  expect(
    (await page.request.put(`api/connections/${id}/personal-fields`, { data: { rules: [] }, headers })).ok(),
  ).toBe(true)
})
