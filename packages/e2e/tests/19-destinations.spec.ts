// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import {
  ADMIN,
  expect,
  openDatabaseBackups,
  openFromSidebar,
  showDatabaseBackups,
  signIn,
  test,
  watchCsp,
  watchOrigins,
} from '../fixtures'

const SENDER = { username: 'dest-sender', password: 'harbor-lantern-violet-61' }
const BROWSER = { username: 'dest-browser', password: 'meadow-quartz-cedar-27' }
const PASSWORD = 'correct horse battery staple'

/** The API as the signed-in page sees it (same cookies, its CSRF token and origin). */
async function api(page: Page, method: 'GET' | 'POST', path: string, data?: object) {
  const me = await (await page.request.get('api/auth/me')).json()
  const res = await page.request.fetch(`api/${path}`, {
    method,
    ...(data ? { data } : {}),
    headers: { 'x-csrf-token': me.csrfToken, origin: new URL(page.url()).origin },
  })
  expect(res.ok(), await res.text()).toBe(true)
  return res.json()
}

/** The documents of a collection as stored (canonical EJSON from the find route), in `n` order. */
async function documentsOf(page: Page, connectionId: string, db: string, coll: string) {
  const found = (await api(
    page,
    'POST',
    `connections/${connectionId}/databases/${db}/collections/${coll}/find`,
    {
      filter: {},
      sort: { n: 1 },
      limit: 100,
    },
  )) as { documents: Array<{ document: Record<string, unknown> }> }
  return found.documents.map((d) => d.document)
}

const files = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name)

/**
 * Phase 3d-3b spec §7: an administrator defines a folder destination in the editor and gives a
 * non-admin user Send and another Browse everything; the sender backs up into it, dropping the local
 * copy; the browser restores it from there, and the restored documents equal the originals.
 */
test('a sender backs up to a destination without a local copy; a browser restores it intact (phase 3d-3b)', async ({
  page,
  browser,
  baseURL,
  cspViolations,
  foreignRequests,
}) => {
  test.setTimeout(240_000)
  await signIn(page)
  await expect(page.getByRole('button', { name: /^Account menu/ })).toBeVisible()
  const list = (await (await page.request.get('api/connections')).json()) as Array<{
    id: string
    name: string
  }>
  const id = list.find((c) => c.name === 'Local test')!.id
  // Values of several BSON types, so a restore that loses or retypes one shows.
  await api(page, 'POST', `connections/${id}/databases/e2edest/collections/orders/documents`, {
    documents: [
      {
        n: 1,
        customer: 'Ayşe',
        total: { $numberDecimal: '12.50' },
        at: { $date: '2026-01-02T03:04:05.006Z' },
      },
      {
        n: 2,
        customer: 'Ali',
        items: [
          { sku: 'A-1', qty: 2 },
          { sku: 'B-7', qty: 1 },
        ],
        paid: true,
      },
      { n: 3, customer: 'Veli', note: null, big: { $numberLong: '9007199254740993' } },
    ],
  })
  const original = await documentsOf(page, id, 'e2edest', 'orders')
  expect(original).toHaveLength(3)

  // Two non-admin users (editors on every connection by default).
  for (const u of [SENDER, BROWSER])
    await api(page, 'POST', 'users', { ...u, role: 'editor', currentPassword: ADMIN.password })

  // The administrator defines the destination in the editor, and gives access there.
  await openFromSidebar(page, 'Integrations', 'Backup destinations')
  await page.getByRole('button', { name: /Server folder/ }).click()
  const editor = page.getByRole('dialog', { name: 'Add a destination' })
  await editor.getByLabel('Name').fill('E2E disk')
  const folder = join(process.env.MM_E2E_DEST_ROOT!, 'e2e')
  await editor.getByLabel('Folder on the server').fill(folder)
  await editor.getByRole('button', { name: 'Next', exact: true }).click()
  // Access: the sender may send, the browser may read everything.
  for (const u of [SENDER, BROWSER]) {
    await editor.getByLabel('Add a user').selectOption({ label: u.username })
    await editor.getByRole('button', { name: 'Add', exact: true }).click()
  }
  await editor
    .getByRole('group', { name: BROWSER.username })
    .getByRole('button', { name: 'Browse everything' })
    .click()
  await expect(
    editor.getByRole('group', { name: SENDER.username }).getByRole('button', { name: 'Send' }),
  ).toHaveAttribute('aria-pressed', 'true')
  await editor.getByRole('button', { name: 'Next', exact: true }).click()
  await editor.getByRole('button', { name: 'Test the connection' }).click()
  await expect(editor.getByText('Every check passed: this destination is ready to save.')).toBeVisible()
  await editor.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(editor).toBeHidden()
  await expect(page.getByRole('article', { name: 'E2E disk' })).toBeVisible()
  const saved = (await api(page, 'GET', 'backup-destinations/all')) as Array<{
    name: string
    grants: Array<{ username: string; level: string }>
  }>
  expect(
    saved
      .find((d) => d.name === 'E2E disk')!
      .grants.map((g) => [g.username, g.level])
      .sort(),
  ).toEqual([
    [BROWSER.username, 'browse'],
    [SENDER.username, 'send'],
  ])

  // The sender backs up into it, without keeping the local copy.
  const senderContext = await browser.newContext({ locale: 'en-US' })
  const sender = await senderContext.newPage()
  watchCsp(sender, cspViolations)
  watchOrigins(sender, new URL(baseURL!).origin, foreignRequests)
  await signIn(sender, SENDER)
  await expect(sender.getByRole('button', { name: /^Account menu/ })).toBeVisible()
  const card = await openDatabaseBackups(sender, id, 'e2edest')
  await card.getByRole('button', { name: 'Take the first backup' }).click()
  const dump = sender.getByRole('dialog', { name: /Back up database e2edest/ })
  await dump.getByRole('radio', { name: /Encrypted backup/ }).check()
  await dump.getByLabel('Password', { exact: true }).fill(PASSWORD)
  await dump.getByLabel('Repeat the password').fill(PASSWORD)
  await dump.locator('[data-destination]').filter({ hasText: 'E2E disk' }).click()
  await dump.getByLabel('Delete the local copy after a verified upload').check()
  await dump.getByRole('button', { name: 'Start backup' }).click()
  await expect(sender.getByText(/was sent$/).first()).toBeVisible({ timeout: 60_000 })

  // The local copy is gone: none in the sender's list on the server, nor in the API.
  await expect
    .poll(async () => ((await api(sender, 'GET', `backups?connectionId=${id}`)) as unknown[]).length, {
      timeout: 15_000,
    })
    .toBe(0)
  await sender.reload()
  await showDatabaseBackups(sender, id, 'e2edest')
  await expect(card.getByRole('tab', { name: 'E2E disk' })).toBeVisible()
  await expect(card.getByText('No backups yet')).toBeVisible()
  await expect(card.locator('[data-backup-row]')).toHaveCount(0)
  // The copy is on the destination, with its manifest written last.
  const there = files(folder)
  expect(there.filter((f) => f.endsWith('.mmbak'))).toHaveLength(1)
  expect(there.filter((f) => f.endsWith('.mmbak.json'))).toHaveLength(1)
  await senderContext.close()

  // A user who may browse everything restores it from the destination into another database.
  const browserContext = await browser.newContext({ locale: 'en-US' })
  const reader = await browserContext.newPage()
  watchCsp(reader, cspViolations)
  watchOrigins(reader, new URL(baseURL!).origin, foreignRequests)
  await signIn(reader, BROWSER)
  await expect(reader.getByRole('button', { name: /^Account menu/ })).toBeVisible()
  const readerCard = await openDatabaseBackups(reader, id, 'e2edest')
  await readerCard.getByRole('tab', { name: 'E2E disk' }).click()
  const row = readerCard.locator('[data-remote-row]')
  await expect(row).toHaveCount(1, { timeout: 15_000 })
  await expect(row).toContainText(`Sent by ${SENDER.username}`)
  await row.getByRole('button', { name: /Restore/ }).click()
  const restore = reader.getByRole('dialog', { name: /Restore into e2edest/ })
  await restore.locator('[data-test="open-password"]').fill(PASSWORD)
  await restore.getByRole('button', { name: 'Open' }).click()
  await restore.getByRole('button', { name: 'Add _restored' }).click()
  for (let i = 0; i < 3; i++) await restore.getByRole('button', { name: 'Next' }).click()
  await restore.getByRole('button', { name: 'Start restore' }).click()
  await expect(reader.getByText(/^Restore finished: /).first()).toBeVisible({ timeout: 60_000 })
  await browserContext.close()

  // The restored documents are the originals: every field, value and type, and the same _id.
  expect(await documentsOf(page, id, 'e2edest_restored', 'orders')).toEqual(original)
})
