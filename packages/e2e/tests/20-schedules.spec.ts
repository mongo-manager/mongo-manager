import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import {
  ADMIN,
  expect,
  openDatabaseBackups,
  openFromSidebar,
  signIn,
  test,
  watchCsp,
  watchOrigins,
} from '../fixtures'

const READER = { username: 'sched-reader', password: 'orchid-lantern-basalt-48' }

async function api(page: Page, method: 'GET' | 'POST' | 'PUT', path: string, data?: object) {
  const me = await (await page.request.get('api/auth/me')).json()
  const res = await page.request.fetch(`api/${path}`, {
    method,
    ...(data ? { data } : {}),
    headers: { 'x-csrf-token': me.csrfToken, origin: new URL(page.url()).origin },
  })
  expect(res.ok(), await res.text()).toBe(true)
  return res.json()
}
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
 * Phase 3d-3c spec §6: create a backup key and confirm its kit, schedule a database backup to a folder
 * destination, Run now, see the run succeed and the copy at the destination, restore it with the stored
 * key, and — as another installation would — with the kit.
 */
test('schedules an encrypted backup with a backup key and restores it with the key and with its kit (phase 3d-3c)', async ({
  page,
  browser,
  baseURL,
  cspViolations,
  foreignRequests,
}) => {
  test.setTimeout(300_000)
  await signIn(page)
  await expect(page.getByRole('button', { name: /^Account menu/ })).toBeVisible()
  const list = (await (await page.request.get('api/connections')).json()) as Array<{
    id: string
    name: string
  }>
  const id = list.find((c) => c.name === 'Local test')!.id
  await api(page, 'POST', `connections/${id}/databases/e2esched/collections/orders/documents`, {
    documents: [
      { n: 1, customer: 'Ayşe', total: { $numberDecimal: '12.50' } },
      { n: 2, customer: 'Ali', paid: true },
      { n: 3, customer: 'Veli', at: { $date: '2026-01-02T03:04:05.006Z' } },
    ],
  })
  const original = await documentsOf(page, id, 'e2esched', 'orders')
  const folder = join(process.env.MM_E2E_DEST_ROOT!, 'sched')
  const dest = (await api(page, 'POST', 'backup-destinations', {
    type: 'folder',
    name: 'Schedule disk',
    config: { path: folder },
  })) as { id: string }
  await api(page, 'POST', 'users', { ...READER, role: 'editor', currentPassword: ADMIN.password })
  const users = (await api(page, 'GET', 'users')) as Array<{ id: string; username: string }>
  await api(page, 'PUT', `backup-destinations/${dest.id}/grants`, {
    grants: [{ userId: users.find((u) => u.username === READER.username)!.id, level: 'browse' }],
  })

  // A backup key: the kit shown once, saved, its last group typed back.
  await page.getByRole('button', { name: /^Account menu/ }).click()
  await page.getByRole('menuitem', { name: 'Account settings' }).click()
  // A kit the server refuses: the busy Import button drops the focus to the page (Chrome); Escape
  // still closes the dialog (2026-10-23).
  await page.getByRole('button', { name: 'Import a kit', exact: true }).click()
  const importing = page.getByRole('dialog', { name: 'Import a recovery kit' })
  await importing.getByLabel('Recovery kit').fill('MMKEY1-AAAA-BBBB')
  // The server held back until the button is busy and Chrome has drawn it so (it moves the focus off
  // a control turned disabled at a frame): on localhost the answer could come before that.
  let release!: () => void
  const held = new Promise<void>((resolve) => (release = resolve))
  await page.route('**/backup-keys/import', async (route) => {
    await held
    await route.continue()
  })
  const submit = importing.getByRole('button', { name: 'Import', exact: true })
  await submit.click()
  await expect(submit).toHaveAttribute('aria-busy', 'true')
  // Run in the page (the specs' types have no DOM): two frames drawn.
  await page.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))')
  release()
  await expect(importing.getByText('This is not a recovery kit, or a group is missing.')).toBeVisible()
  await page.unroute('**/backup-keys/import')
  await page.keyboard.press('Escape')
  await expect(importing).toBeHidden()
  await page.getByRole('button', { name: 'Create key' }).click()
  const flow = page.getByRole('dialog', { name: 'Create a backup key' })
  await flow.getByRole('button', { name: 'Create key' }).click()
  const kit = (await flow.locator('[data-test="kit"]').textContent())!
  expect(kit).toMatch(/MMKEY1-/)
  const download = page.waitForEvent('download')
  await flow.getByRole('button', { name: 'Download' }).click()
  expect((await download).suggestedFilename()).toMatch(/^mongo-manager-backup-key-K-[0-9a-f]{8}\.txt$/)
  await flow.getByLabel('I saved the kit somewhere safe').check()
  await flow.getByRole('button', { name: 'Next' }).click()
  await flow.getByLabel('Last group').fill(kit.match(/MMKEY1-\S+/)![0].slice(-4))
  await flow.getByRole('button', { name: 'Confirm' }).click()
  await expect(flow).toBeHidden()
  await expect(page.getByText(/is ready\. Scheduled backups now use it\./)).toBeVisible()

  // Schedule the database from its Backups card, to the folder destination.
  const card = await openDatabaseBackups(page, id, 'e2esched')
  await card.getByRole('button', { name: 'Schedule…' }).click()
  const editor = page.getByRole('dialog', { name: 'New scheduled backup' })
  for (let i = 0; i < 3; i++) await editor.getByRole('button', { name: 'Next', exact: true }).click()
  await editor.locator('[data-destination]').filter({ hasText: 'Schedule disk' }).click()
  await editor.getByRole('button', { name: 'Next', exact: true }).click()
  await editor.getByRole('button', { name: 'Next', exact: true }).click()
  await expect(editor.locator('[data-test="summary"]')).toContainText('Schedule disk')
  await editor.getByRole('button', { name: 'Create schedule' }).click()
  await expect(editor).toBeHidden()

  // Run now, and see the run succeed and the copy at the destination.
  await openFromSidebar(page, 'Automations', 'Scheduled backups')
  const schedule = page.getByRole('article', { name: 'e2esched backups' })
  await schedule.getByRole('button', { name: 'Run now' }).click()
  await expect(schedule.locator('[data-outcome="succeeded"]')).toHaveCount(1, { timeout: 120_000 })
  expect(files(folder).filter((f) => f.endsWith('.mmbak'))).toHaveLength(1)

  // Restore it with the stored key: no password, no kit.
  await openDatabaseBackups(page, id, 'e2esched')
  await card.getByRole('tab', { name: 'Schedule disk' }).click()
  await card
    .locator('[data-remote-row]')
    .first()
    .getByRole('button', { name: /Restore/ })
    .click()
  const restore = page.getByRole('dialog', { name: /Restore into e2esched/ })
  // Final review: the line names the key once ("Opened with Key 1, your backup key (K-…)").
  await expect(restore.getByText(/^Opened with .+, your backup key \(K-/)).toBeVisible({ timeout: 60_000 })
  await restore.getByRole('button', { name: 'Add _restored' }).click()
  for (let i = 0; i < 3; i++) await restore.getByRole('button', { name: 'Next' }).click()
  await restore.getByRole('button', { name: 'Start restore' }).click()
  await expect(page.getByText(/^Restore finished: /).first()).toBeVisible({ timeout: 60_000 })
  expect(await documentsOf(page, id, 'e2esched_restored', 'orders')).toEqual(original)
  // Gone again, so the second restore below writes the same target afresh.
  const dropped = await page.request.fetch(`api/connections/${id}/databases/e2esched_restored`, {
    method: 'DELETE',
    data: { confirm: 'e2esched_restored' },
    headers: {
      'x-csrf-token': (await (await page.request.get('api/auth/me')).json()).csrfToken,
      origin: new URL(page.url()).origin,
    },
  })
  expect(dropped.ok(), await dropped.text()).toBe(true)

  // Another account, holding none of the owner's keys, restores it with the kit (as another installation would).
  const readerContext = await browser.newContext({ locale: 'en-US' })
  const reader = await readerContext.newPage()
  watchCsp(reader, cspViolations)
  watchOrigins(reader, new URL(baseURL!).origin, foreignRequests)
  await signIn(reader, READER)
  await expect(reader.getByRole('button', { name: /^Account menu/ })).toBeVisible()
  const readerCard = await openDatabaseBackups(reader, id, 'e2esched')
  await readerCard.getByRole('tab', { name: 'Schedule disk' }).click()
  await readerCard
    .locator('[data-remote-row]')
    .first()
    .getByRole('button', { name: /Restore/ })
    .click()
  const readerRestore = reader.getByRole('dialog', { name: /Restore into e2esched/ })
  await expect(readerRestore.getByText(/This backup was made with backup key K-/)).toBeVisible({
    timeout: 60_000,
  })
  await readerRestore.getByLabel('Recovery kit').fill(kit)
  await readerRestore.getByRole('button', { name: 'Open' }).click()
  await expect(readerRestore.getByText(/^Opened with the recovery kit of K-/)).toBeVisible()
  await readerRestore.getByRole('button', { name: 'Add _restored' }).click()
  for (let i = 0; i < 3; i++) await readerRestore.getByRole('button', { name: 'Next' }).click()
  await readerRestore.getByRole('button', { name: 'Start restore' }).click()
  await expect(reader.getByText(/^Restore finished: /).first()).toBeVisible({ timeout: 60_000 })
  await readerContext.close()
  expect(await documentsOf(page, id, 'e2esched_restored', 'orders')).toEqual(original)
  expect(cspViolations).toEqual([])
  expect(foreignRequests).toEqual([])
})
