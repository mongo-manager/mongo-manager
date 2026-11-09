// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { readFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { ADMIN, expect, rowNamed, signIn, test } from '../fixtures'

/**
 * Workstream W4 (completion design §2 W4): transfer flows end to end. Setup that other specs
 * cover in the UI goes through the REST API.
 */
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

/** The API as the signed-in page sees it (same cookies, its CSRF token and origin). */
async function api(page: Page, method: 'POST' | 'DELETE', path: string, data?: object) {
  const res = await page.request.fetch(`api/${path}`, {
    method,
    ...(data ? { data } : {}),
    headers: { 'x-csrf-token': await csrf(page), origin: new URL(page.url()).origin },
  })
  expect(res.ok(), await res.text()).toBe(true)
  return res.status() === 204 ? null : res.json()
}

/**
 * W4.3 (phase 3d-2 spec §3.2, §11 E2E): copy with a filter of its own and the live target check,
 * change the copy, compare, then run the sync from the comparison and see the target fixed.
 */
test('copies with its own filter, compares, and syncs the differences (W4.3)', async ({ page }) => {
  await signIn(page)
  await expect(page.getByRole('button', { name: /^Account menu/ })).toBeVisible()
  const id = await connectionId(page)
  await page.goto('')
  await api(page, 'POST', `connections/${id}/databases/shop/collections/w4sync/documents`, {
    documents: [
      { _id: 1, name: 'Ali', paid: true },
      { _id: 2, name: 'Veli', paid: true },
      { _id: 3, name: 'Ayşe', paid: false },
    ],
  })
  await page.goto(`c/${id}/db/shop/coll/w4sync`)
  await expect(page.locator('tbody tr', { hasText: 'Veli' })).toBeVisible({ timeout: 15_000 })
  const documents = page.getByRole('tabpanel', { name: 'Documents' })
  const fromResults = async (item: string) => {
    await documents.getByRole('button', { name: 'More actions for these results' }).click()
    await page.getByRole('menuitem', { name: item, exact: true }).click()
  }

  // Copy: a filter of its own (the paid ones), the target checked as it is typed.
  await fromResults('Copy to…')
  const wizard = page.getByRole('dialog', { name: 'Copy w4sync' })
  await expect(wizard.locator('[data-test="source-size"]')).toContainText('About 3 documents')
  await wizard.getByRole('radio', { name: 'A filter' }).click()
  await wizard.getByLabel('Filter').fill('{ paid: true }')
  await wizard.getByRole('button', { name: 'Next' }).click()
  await wizard.getByLabel('Database').fill('w4sync2')
  await expect(wizard.locator('[data-test="target-check"]')).toContainText('new', { timeout: 15_000 })
  await wizard.getByRole('button', { name: 'Next' }).click()
  await wizard.getByRole('button', { name: 'Next' }).click()
  await wizard.getByRole('button', { name: 'Copy', exact: true }).click()
  await expect(wizard).toBeHidden()
  await expect(page.getByText(/^Copy finished: /).first()).toBeVisible({ timeout: 20_000 })
  const copied = (await api(page, 'POST', `connections/${id}/databases/w4sync2/collections/w4sync/find`, {
    filter: {},
  })) as { documents: unknown[] }
  expect(copied.documents).toHaveLength(2)

  // Make the copy lack one more document of the source.
  await api(page, 'POST', `connections/${id}/databases/w4sync2/collections/w4sync/documents/delete`, {
    _id: { $numberInt: '2' },
  })

  // Compare, open the comparison, and sync from it.
  await fromResults('Compare with…')
  const compare = page.getByRole('dialog', { name: 'Compare w4sync' })
  await compare.getByLabel('Database').fill('w4sync2')
  await compare.getByRole('button', { name: 'Next' }).click()
  await compare.getByRole('button', { name: 'Compare', exact: true }).click()
  await expect(compare).toBeHidden()
  await expect(page.getByText(/^Comparison finished: /).first()).toBeVisible({ timeout: 20_000 })
  await page.getByRole('button', { name: /^Background jobs/ }).click()
  const panel = page.getByRole('dialog', { name: 'Background jobs' })
  await panel.locator('[data-job]').filter({ hasText: 'Compare' }).first().getByRole('button').first().click()
  await page.locator('[data-job-actions]').getByRole('button', { name: 'Open comparison' }).first().click()
  await expect(page.locator('[data-count="onlySource"]')).toContainText('2', { timeout: 15_000 })
  await page.getByRole('button', { name: 'Sync…' }).click()
  const sync = page.getByRole('dialog', { name: 'Sync w4sync' })
  await sync.getByRole('button', { name: 'Sync', exact: true }).click()
  await expect(sync).toBeHidden()
  await expect(page.getByText(/^Sync finished: /).first()).toBeVisible({ timeout: 20_000 })
  const after = (await api(page, 'POST', `connections/${id}/databases/w4sync2/collections/w4sync/find`, {
    filter: {},
  })) as { documents: unknown[] }
  // The two missing (2, removed above, and 3, left out by the copy's filter) are inserted.
  expect(after.documents).toHaveLength(3)
})

const EXPORTER = { username: 'masked-exporter', password: 'violet-harbour-quartz-58' }
const SECRET = 'w4-secret@example.test'

/**
 * W4.2 (phase 3d-1 spec §10 E2E): a restricted viewer allowed to export gets a file with *** where
 * the documents view shows ***, never the value; the columns come from a schema sample.
 */
test('a restricted user exports a collection and the file holds *** for the personal field (W4.2)', async ({
  page,
  browser,
}) => {
  await signIn(page)
  await expect(page.getByRole('button', { name: /^Account menu/ })).toBeVisible()
  const id = await connectionId(page)
  const ns = `api/connections/${id}/databases/shop/collections/w4export`
  const headers = { 'x-csrf-token': await csrf(page) }
  expect(
    (
      await page.request.post(`${ns}/documents`, {
        data: {
          documents: [
            { name: 'Ada', email: SECRET, tags: ['a', 'b'] },
            // An ObjectId that spells "ada" (CI 2026-10-23): Ada's row is found by its name cell.
            { _id: { $oid: '6adaf89c448bd7cf0c7dc85d' }, name: 'Bob', email: 'bob-' + SECRET, tags: ['c'] },
          ],
        },
        headers,
      })
    ).ok(),
  ).toBe(true)
  expect(
    (
      await page.request.put(`api/connections/${id}/personal-fields`, {
        data: { rules: [{ db: 'shop', coll: 'w4export', field: 'email' }] },
        headers,
      })
    ).ok(),
  ).toBe(true)
  const created = await page.request.post('api/users', {
    data: { ...EXPORTER, role: 'viewer', currentPassword: ADMIN.password },
    headers,
  })
  expect(created.ok(), await created.text()).toBe(true)
  const { id: userId } = (await created.json()) as { id: string }
  expect(
    (
      await page.request.put(`api/connections/${id}/grants/${userId}`, {
        data: { role: 'viewer', masked: true, export: true },
        headers,
      })
    ).ok(),
  ).toBe(true)

  const other = await browser.newContext({ locale: 'en-US', acceptDownloads: true })
  const viewer = await other.newPage()
  try {
    await signIn(viewer, EXPORTER)
    await expect(viewer.getByRole('button', { name: /^Account menu/ })).toBeVisible()
    await viewer.goto(`c/${id}/db/shop/coll/w4export`)
    await expect(rowNamed(viewer, 'Ada')).toBeVisible({ timeout: 15_000 })
    const documents = viewer.getByRole('tabpanel', { name: 'Documents' })
    await documents.getByRole('button', { name: 'More actions for these results' }).click()
    await viewer.getByRole('menuitem', { name: 'Export', exact: true }).click()
    const dialog = viewer.getByRole('dialog', { name: 'Export w4export' })
    await expect(dialog.locator('[data-export-masked]')).toContainText('Personal fields are written as ***.')
    await dialog.getByLabel('Format').selectOption('csv')
    await dialog.getByLabel('Arrays').selectOption('join')
    await dialog.getByRole('button', { name: 'Export', exact: true }).click()
    await expect(dialog).toBeHidden()
    await expect(viewer.getByText(/^Export ready: w4export-/).first()).toBeVisible({ timeout: 20_000 })
    await viewer.getByRole('button', { name: /^Background jobs/ }).click()
    const panel = viewer.getByRole('dialog', { name: 'Background jobs' })
    await panel
      .locator('[data-job]')
      .filter({ hasText: 'Export' })
      .first()
      .getByRole('button')
      .first()
      .click()
    // W4.2: the file's expiry is said next to its download.
    await expect(viewer.locator('[data-job-actions] [data-test="export-expiry"]').first()).toContainText(
      'Available to download until',
    )
    const downloading = viewer.waitForEvent('download')
    await viewer.locator('[data-job-actions]').getByRole('link', { name: 'Download' }).first().click()
    const download = await downloading
    const text = readFileSync((await download.path())!, 'utf8')
    expect(text).toContain('***')
    expect(text).not.toContain(SECRET)
    expect(text).toContain('Ada')
    // Arrays joined with the default separator.
    expect(text).toContain('a; b')
  } finally {
    await other.close()
    // No rules left behind for later specs.
    expect(
      (
        await page.request.put(`api/connections/${id}/personal-fields`, { data: { rules: [] }, headers })
      ).ok(),
    ).toBe(true)
  }
})
