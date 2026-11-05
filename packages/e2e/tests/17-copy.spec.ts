// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { Page } from '@playwright/test'
import { expect, signIn, test } from '../fixtures'

/** The API as the signed-in page sees it (same cookies, its CSRF token and origin). */
async function api(page: Page, path: string, data: object) {
  const me = await (await page.request.get('api/auth/me')).json()
  const res = await page.request.post(`api/${path}`, {
    data,
    headers: { 'x-csrf-token': me.csrfToken, origin: new URL(page.url()).origin },
  })
  expect(res.ok(), await res.text()).toBe(true)
  return res.json()
}

/** Phase 3d-2: copy a collection to another database, then compare the two and open the result. */
test('copies a collection to another database, then compares them (phase 3d-2)', async ({ page }) => {
  await signIn(page)
  await expect(page.getByRole('button', { name: /^Account menu/ })).toBeVisible()
  const list = (await (await page.request.get('api/connections')).json()) as Array<{
    id: string
    name: string
  }>
  const id = list.find((c) => c.name === 'Local test')!.id
  await api(page, `connections/${id}/databases/shop/collections/e2ecopy/documents`, {
    documents: [{ name: 'Ali' }, { name: 'Veli' }],
  })
  await page.goto(`c/${id}/db/shop/coll/e2ecopy`)
  await expect(page.locator('tbody tr', { hasText: 'Veli' })).toBeVisible({ timeout: 15_000 })
  const documents = page.getByRole('tabpanel', { name: 'Documents' })
  // UI redesign R1: the results' data actions are in the toolbar's More menu.
  const fromResults = async (item: string) => {
    await documents.getByRole('button', { name: 'More actions for these results' }).click()
    await page.getByRole('menuitem', { name: item, exact: true }).click()
  }

  // Copy: source, target database, options, summary (the plan), then Copy.
  await fromResults('Copy to…')
  const wizard = page.getByRole('dialog', { name: 'Copy e2ecopy' })
  await wizard.getByRole('button', { name: 'Next' }).click()
  await wizard.getByLabel('Database').fill('e2ecopy2')
  await wizard.getByRole('button', { name: 'Next' }).click()
  await wizard.getByRole('button', { name: 'Next' }).click()
  await expect(
    wizard.getByText('streamed through Mongo Manager').or(wizard.getByText('copied inside the server')),
  ).toBeVisible()
  await wizard.getByRole('button', { name: 'Copy', exact: true }).click()
  await expect(wizard).toBeHidden()
  await expect(page.getByText(/^Copy finished: /).first()).toBeVisible({ timeout: 20_000 })

  // Compare the collection with its copy: every document is the same.
  await fromResults('Compare with…')
  const compare = page.getByRole('dialog', { name: 'Compare e2ecopy' })
  await compare.getByLabel('Database').fill('e2ecopy2')
  await compare.getByRole('button', { name: 'Next' }).click()
  await compare.getByRole('button', { name: 'Compare', exact: true }).click()
  await expect(compare).toBeHidden()
  await expect(page.getByText(/^Comparison finished: /).first()).toBeVisible({ timeout: 20_000 })
  await page.getByRole('button', { name: /^Background jobs/ }).click()
  const panel = page.getByRole('dialog', { name: 'Background jobs' })
  // A finished job opens on the jobs page, its actions with it (jobs redesign, 2026-10-08).
  await panel.locator('[data-job]').filter({ hasText: 'Compare' }).first().getByRole('button').first().click()
  await page.locator('[data-job-actions]').getByRole('button', { name: 'Open comparison' }).first().click()
  await expect(page.locator('[data-count="same"]')).toContainText('2', { timeout: 15_000 })
  await expect(page.locator('[data-count="different"]')).toContainText('0')
})
