// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { Page } from '@playwright/test'
import { expect, signIn, test } from '../fixtures'

/** The API as the signed-in page sees it (same cookies, its CSRF token and origin). */
async function api(page: Page, path: string, data: object) {
  const me = await (await page.request.get('api/auth/me')).json()
  const origin = new URL(page.url()).origin
  const res = await page.request.post(`api/${path}`, {
    data,
    headers: { 'x-csrf-token': me.csrfToken, origin },
  })
  expect(res.ok(), await res.text()).toBe(true)
  return res.json()
}

test('a copy and an index build run in the background and finish in the jobs tray (phase 1h)', async ({
  page,
}) => {
  const violations: string[] = []
  page.on('console', (m) => {
    if (/Content Security Policy/i.test(m.text())) violations.push(m.text())
  })
  const frames: string[] = []
  page.on('websocket', (ws) => {
    if (new URL(ws.url()).pathname.endsWith('/ws'))
      ws.on('framereceived', (f) => frames.push(String(f.payload)))
  })

  await signIn(page)
  await expect(page.getByRole('button', { name: /^Account menu/ })).toBeVisible()
  const connections = (await (await page.request.get('api/connections')).json()) as Array<{
    id: string
    name: string
  }>
  const id = connections.find((c) => c.name === 'Local test')!.id
  const source = `connections/${id}/databases/shop/collections/big`
  for (let batch = 0; batch < 20; batch++) {
    const documents = Array.from({ length: 1000 }, (_, i) => ({ n: batch * 1000 + i, pad: 'x'.repeat(40) }))
    await api(page, `${source}/documents`, { documents })
  }

  // Duplicate from the collection header's "…" (the overview's buttons moved there in R2): the dialog
  // closes at once, the tray follows the copy.
  await page.goto(`c/${id}/db/shop/coll/big`)
  await page.getByRole('button', { name: 'More actions for big' }).click()
  await page.getByRole('menuitem', { name: 'Duplicate' }).click()
  const dialog = page.getByRole('dialog', { name: 'Duplicate collection' })
  await dialog.getByLabel('New collection name').fill('big_copy')
  await dialog.getByRole('button', { name: 'Duplicate' }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByText('Duplication started.', { exact: false })).toBeVisible()

  // Start an index build, then leave the tab: jobs do not depend on the page that started them.
  await page.getByRole('tab', { name: 'Indexes' }).click()
  await page.getByRole('button', { name: 'Create index' }).click()
  await page.getByLabel('Keys').fill('{ n: 1 }')
  await page.getByRole('dialog').getByRole('button', { name: 'Create', exact: true }).click()
  await page.goto(`c/${id}/db/shop/coll/orders`)

  const tray = page.getByRole('button', { name: 'Background jobs' })
  await tray.click()
  const panel = page.getByRole('dialog', { name: 'Background jobs' })
  // Earlier specs' jobs are listed too; these two are the ones on shop.big.
  // A finished job is one line named "<state> <source> to <target> <kind> …" (jobs redesign,
  // 2026-10-08); a running one shows large above them, so each is waited for until done.
  const copy = panel.getByRole('button', { name: /^Done shop\.big to shop\.big_copy Duplicate/ })
  const build = panel.getByRole('button', { name: /^Done shop\.big to n_1 Index build/ })
  await expect(copy).toHaveCount(1, { timeout: 30_000 })
  await expect(build).toHaveCount(1, { timeout: 30_000 })

  // The copy is there, whole.
  const count = await api(page, `connections/${id}/databases/shop/collections/big_copy/count`, { filter: {} })
  expect(count.count).toBe(20_000)

  // Everything above came over the real-time channel, under the production CSP.
  expect(frames.some((f) => f.includes('"ready"'))).toBe(true)
  expect(frames.some((f) => f.includes('"update"') && f.includes('big_copy'))).toBe(true)
  expect(violations).toEqual([])
})
