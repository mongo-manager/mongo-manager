// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { readFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { expect, signIn, test } from '../fixtures'

async function api(page: Page, method: 'GET' | 'POST' | 'DELETE', path: string, data?: object) {
  const me = await (await page.request.get('api/auth/me')).json()
  const res = await page.request.fetch(`api/${path}`, {
    method,
    ...(data ? { data } : {}),
    headers: { 'x-csrf-token': me.csrfToken, origin: new URL(page.url()).origin },
  })
  expect(res.ok(), await res.text()).toBe(true)
  return res.status() === 204 ? null : res.json()
}

/**
 * Phase 4a-2 spec §6: a conversation about a collection — history travels, a query from the answer is
 * inserted and run, another collection shows its divider, the chat survives a reload, and it is deleted.
 */
test('chats with the assistant, inserts its query, finds the chat again and deletes it (phase 4a-2)', async ({
  page,
  cspViolations,
  foreignRequests,
}) => {
  test.setTimeout(150_000)
  await signIn(page)
  await expect(page.getByRole('button', { name: /^Account menu/ })).toBeVisible()
  for (const p of (await api(page, 'GET', 'ai/providers')) as Array<{ id: string }>)
    await api(page, 'DELETE', `ai/providers/${p.id}`)
  await api(page, 'DELETE', 'ai/chats')
  await api(page, 'POST', 'ai/providers', {
    name: 'Fake',
    kind: 'openai',
    baseUrl: `${process.env.MM_E2E_AI_URL}/v1`,
    model: 'fake-model',
  })
  const list = (await api(page, 'GET', 'connections')) as Array<{ id: string; name: string }>
  const conn = list.find((c) => c.name === 'Local test')!.id
  for (const coll of ['e2echat', 'e2etalk'])
    await api(page, 'POST', `connections/${conn}/databases/shop/collections/${coll}/documents`, {
      documents: Array.from({ length: 10 }, (_, i) => ({ qty: i, status: i % 2 ? 'paid' : 'new' })),
    })
  // Two collection tabs: switching between them keeps the page (and the chat in memory).
  await page.goto(`c/${conn}/db/shop/coll/e2etalk`)
  await expect(page.getByRole('tab', { name: 'shop.e2etalk' })).toBeVisible()
  await page.goto(`c/${conn}/db/shop/coll/e2echat`)
  await expect(page.getByRole('tab', { name: 'shop.e2echat' })).toBeVisible()

  await page.getByRole('button', { name: 'Assistant', exact: true }).click()
  const panel = page.getByRole('complementary', { name: 'Assistant' })
  await expect(panel.getByText('shop.e2echat on Local test')).toBeVisible()
  const box = panel.getByLabel('Message the assistant')
  // An answer has ended when Send is back in place of Stop (Enter does nothing while it streams).
  const answered = () => expect(panel.getByRole('button', { name: 'Send', exact: true })).toBeVisible()
  await box.fill('what is in here?')
  await box.press('Enter')
  await expect(panel.getByText('I can see 0 earlier messages.')).toBeVisible()
  await answered()
  await box.fill('orders over five, biggest first')
  await box.press('Enter')
  await expect(panel.getByText('I can see 2 earlier messages.')).toBeVisible()
  await answered()
  // One action under a block: Run puts the query in the bar and runs it (user report 2026-10-13).
  await panel.getByRole('button', { name: 'Run', exact: true }).click()
  await expect(page.getByText('1–4 of')).toBeVisible()

  await page.getByRole('tab', { name: 'shop.e2etalk' }).click()
  await expect(panel.getByText('shop.e2etalk on Local test')).toBeVisible()
  await box.fill('and this one?')
  await box.press('Enter')
  await expect(panel.getByText('Now about shop.e2etalk')).toBeVisible()
  await expect(panel.getByText('I can see 4 earlier messages.')).toBeVisible()

  await page.reload()
  await expect(panel).toBeVisible()
  // User report 2026-10-30: the chat that was open is open again after the reload, as it was.
  await expect(panel.getByText('I can see 4 earlier messages.')).toBeVisible()
  await expect(panel.getByText('Now about shop.e2etalk')).toBeVisible()
  await panel.getByRole('button', { name: 'History' }).click()
  await page.getByRole('button', { name: /^what is in here\?/ }).click()
  await expect(panel.getByText('I can see 4 earlier messages.')).toBeVisible()

  await panel.getByRole('button', { name: 'History' }).click()
  await page.getByRole('button', { name: 'Delete what is in here?' }).click()
  await page
    .getByRole('dialog')
    .filter({ hasText: 'Delete “what is in here?”?' })
    .getByRole('button', { name: 'Delete', exact: true })
    .click()
  await panel.getByRole('button', { name: 'History' }).click()
  await expect(page.getByText('No chats yet.')).toBeVisible()

  expect(cspViolations).toEqual([])
  expect(foreignRequests).toEqual([])
})

// User request 2026-10-13 ("excel olarak yada json olarak indir"): an answer that gives the result as
// a file offers one button, which opens the collection's export with the query and the format set;
// the file holds what the query finds.
test('a result asked for as a file is offered as an export, and downloads (2026-10-13)', async ({ page }) => {
  test.setTimeout(150_000)
  await signIn(page)
  await expect(page.getByRole('button', { name: /^Account menu/ })).toBeVisible()
  for (const p of (await api(page, 'GET', 'ai/providers')) as Array<{ id: string }>)
    await api(page, 'DELETE', `ai/providers/${p.id}`)
  await api(page, 'POST', 'ai/providers', {
    name: 'Fake',
    kind: 'openai',
    baseUrl: `${process.env.MM_E2E_AI_URL}/v1`,
    model: 'fake-model',
  })
  const list = (await api(page, 'GET', 'connections')) as Array<{ id: string; name: string }>
  const conn = list.find((c) => c.name === 'Local test')!.id
  // A collection of its own, whatever an earlier run left.
  const me = await (await page.request.get('api/auth/me')).json()
  await page.request.delete(`api/connections/${conn}/databases/shop/collections/e2efile`, {
    data: { confirm: 'e2efile' },
    headers: { 'x-csrf-token': me.csrfToken, origin: new URL(page.url()).origin },
  })
  await api(page, 'POST', `connections/${conn}/databases/shop/collections/e2efile/documents`, {
    documents: Array.from({ length: 10 }, (_, i) => ({ qty: i })),
  })
  await page.goto(`c/${conn}/db/shop/coll/e2efile`)
  await expect(page.getByRole('tab', { name: 'shop.e2efile' })).toBeVisible()
  await page.getByRole('button', { name: 'Assistant', exact: true }).click()
  const panel = page.getByRole('complementary', { name: 'Assistant' })
  const box = panel.getByLabel('Message the assistant')
  await box.fill('orders over five as a csv please')
  await box.press('Enter')
  await expect(panel.getByRole('button', { name: 'Send', exact: true })).toBeVisible()
  // One action under the block: the file, not Run.
  await expect(panel.getByRole('button', { name: 'Run', exact: true })).toHaveCount(0)
  await panel.getByRole('button', { name: 'Download as CSV' }).click()

  const dialog = page.getByRole('dialog', { name: 'Export e2efile' })
  await expect(dialog.getByLabel('Format')).toHaveValue('csv')
  await dialog.getByRole('button', { name: 'Export', exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByText(/^Export ready: e2efile-/).first()).toBeVisible({ timeout: 20_000 })
  // The assistant is a window over the page (user report 2026-10-25): closed before the page is used.
  await page.getByRole('button', { name: 'Assistant', exact: true }).click()
  await expect(panel).toBeHidden()
  await page.getByRole('button', { name: /^Background jobs/ }).click()
  const jobs = page.getByRole('dialog', { name: 'Background jobs' })
  await jobs.locator('[data-job]').filter({ hasText: 'Export' }).first().getByRole('button').first().click()
  const downloading = page.waitForEvent('download')
  await page.locator('[data-job-actions]').getByRole('link', { name: 'Download' }).first().click()
  const download = await downloading
  expect(download.suggestedFilename()).toMatch(/^e2efile-\d{8}-\d{6}\.csv$/)
  const rows = readFileSync((await download.path())!, 'utf8')
    .trim()
    .split(/\r?\n/)
  // A header, and the four documents over five.
  expect(rows).toHaveLength(5)
  expect(
    rows
      .slice(1)
      .map((r) => Number(r.split(',').at(-1)!.replace(/"/g, '')))
      .sort(),
  ).toEqual([6, 7, 8, 9])
  await api(page, 'DELETE', 'ai/chats')
})
