// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { Page } from '@playwright/test'
import { expect, openDatabaseBackups, showDatabaseBackups, signIn, test } from '../fixtures'

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

/** Phase 3d-3a: back up a database encrypted, then restore it into another database with the password. */
test('backs up a database and restores it elsewhere with its password (phase 3d-3a)', async ({ page }) => {
  await signIn(page)
  await expect(page.getByRole('button', { name: /^Account menu/ })).toBeVisible()
  const list = (await (await page.request.get('api/connections')).json()) as Array<{
    id: string
    name: string
  }>
  const id = list.find((c) => c.name === 'Local test')!.id
  await api(page, `connections/${id}/databases/e2ebk/collections/orders/documents`, {
    documents: [{ name: 'Ali' }, { name: 'Veli' }, { name: 'Ayşe' }],
  })
  const card = await openDatabaseBackups(page, id, 'e2ebk')
  await expect(card.getByText('No backups yet')).toBeVisible({ timeout: 15_000 })

  // Back up: the quick path, encrypted, with a typed password.
  await card.getByRole('button', { name: 'Take the first backup' }).click()
  const dump = page.getByRole('dialog', { name: /Back up database e2ebk/ })
  await dump.getByRole('radio', { name: /Encrypted backup/ }).check()
  await dump.getByLabel('Password', { exact: true }).fill('correct horse battery staple')
  await dump.getByLabel('Repeat the password').fill('correct horse battery staple')
  await expect(dump.getByRole('button', { name: 'Start backup' })).toBeEnabled()
  await dump.getByRole('button', { name: 'Start backup' }).click()
  await expect(dump).toBeHidden()
  await expect(page.getByText(/^Backup ready: /).first()).toBeVisible({ timeout: 30_000 })

  // Restore from the list into a new database: a wrong password first, then the right one.
  await page.reload()
  await showDatabaseBackups(page, id, 'e2ebk')
  // UI redesign R3 leftovers: a backup's actions are its row's "…" menu.
  await card
    .getByRole('button', { name: /^Actions for / })
    .first()
    .click()
  await page.getByRole('menuitem', { name: 'Restore…' }).click()
  const restore = page.getByRole('dialog', { name: /Restore into e2ebk/ })
  await restore.locator('[data-test="open-password"]').fill('wrong password here')
  await restore.getByRole('button', { name: 'Open' }).click()
  await expect(restore.getByText('The password is wrong, or the file is damaged.')).toBeVisible()
  await restore.locator('[data-test="open-password"]').fill('correct horse battery staple')
  await restore.getByRole('button', { name: 'Open' }).click()
  await expect(restore.getByText('Encrypted backup')).toBeVisible({ timeout: 15_000 })
  await restore.getByRole('button', { name: 'Add _restored' }).click()
  for (let i = 0; i < 3; i++) await restore.getByRole('button', { name: 'Next' }).click()
  await expect(restore.getByText('New collection')).toBeVisible()
  await restore.getByRole('button', { name: 'Start restore' }).click()
  await expect(restore).toBeHidden()
  await expect(page.getByText(/^Restore finished: /).first()).toBeVisible({ timeout: 30_000 })
  const found = await api(page, `connections/${id}/databases/e2ebk_restored/collections/orders/find`, {
    filter: {},
    limit: 10,
  })
  expect(JSON.stringify(found)).toContain('Ayşe')
})
