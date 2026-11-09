// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { Page } from '@playwright/test'
import { parseConnectionUri } from '../../shared/src/connections'
import { expect, signIn, test } from '../fixtures'

test.skip(!process.env.MM_E2E_RS_URI, 'Live sync needs a replica set (MM_E2E_RS_URI)')

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

/** The replica set as two connections (the same deployment, so different databases may sync). */
async function connection(page: Page, name: string): Promise<string> {
  const list = (await api(page, 'GET', 'connections')) as Array<{ id: string; name: string }>
  const found = list.find((c) => c.name === name)
  if (found) return found.id
  const made = (await api(page, 'POST', 'connections', {
    name,
    favorite: false,
    readOnly: false,
    settings: parseConnectionUri(process.env.MM_E2E_RS_URI!),
  })) as { id: string }
  return made.id
}

/**
 * Phase 3e-2 spec §6: start a collection sync from the palette, see it copy and go live, write to the
 * source and see the target follow, verify, finish; a standalone source is refused in words.
 */
test('syncs a collection live, verifies and finishes (phase 3e-2)', async ({
  page,
  cspViolations,
  foreignRequests,
}) => {
  test.setTimeout(180_000)
  await signIn(page)
  await expect(page.getByRole('button', { name: /^Account menu/ })).toBeVisible()
  const source = await connection(page, 'Replica test')
  const target = await connection(page, 'Replica copy')
  const coll = `e2esync${Date.now()}`
  const base = `connections/${source}/databases/shop/collections/${coll}`
  await api(page, 'POST', `${base}/documents`, {
    documents: [
      { _id: 's1', n: 1 },
      { _id: 's2', n: 2 },
    ],
  })

  await page.goto(`c/${source}/db/shop/coll/${coll}`)
  // The workspace is up (its collection tab shown) before the palette is asked for: a slow run
  // pressed Ctrl+K before the page listened (phase 4a-1 gate).
  await expect(page.getByRole('tab', { name: `shop.${coll}` })).toBeVisible()
  await page.keyboard.press('Control+k')
  await page.getByPlaceholder('Type a command…').fill('Keep this collection in sync')
  await page.keyboard.press('Enter')
  const wizard = page.getByRole('dialog')
  await wizard.getByLabel('Target connection').selectOption(target)
  await wizard.getByLabel('Database').fill('e2esynccopy')
  await wizard.getByRole('button', { name: 'Next' }).click()
  await expect(wizard.getByText('Copy first')).toBeVisible()
  await wizard.getByRole('button', { name: 'Next' }).click()
  await wizard.getByLabel('I understand: writes made on the target are overwritten').check()
  await expect(wizard.getByRole('button', { name: 'Start live sync' })).toBeEnabled({ timeout: 20_000 })
  await wizard.getByRole('button', { name: 'Start live sync' }).click()

  // The Live syncs tab opens; the card goes live.
  const card = page.locator('[data-sync]').filter({ hasText: coll }).first()
  await expect(card.locator('[data-state]')).toHaveText(/Live/, { timeout: 60_000 })
  await expect(card).toContainText('Replica test')
  await expect(card).toContainText('Replica copy')

  // A change in the source reaches the target.
  await api(page, 'POST', `${base}/documents`, { documents: [{ _id: 's3', n: 3 }] })
  const targetDocs = `connections/${target}/databases/e2esynccopy/collections/${coll}/count`
  await expect
    .poll(async () => ((await api(page, 'POST', targetDocs, {})) as { count: number }).count, {
      timeout: 30_000,
    })
    .toBe(3)

  // Verify, then finish.
  await card.getByRole('button', { name: 'Verify' }).click()
  await expect(card).toContainText(/Verified .* 3 same, 0 different/, { timeout: 60_000 })
  await card.getByRole('button', { name: 'Finish…' }).click()
  await page.getByRole('button', { name: 'Finish now' }).click()
  await expect(card.locator('[data-state]')).toHaveText(/Completed/, { timeout: 60_000 })
  expect(cspViolations).toEqual([])
  expect(foreignRequests).toEqual([])
})

test('says a standalone source cannot be synced (phase 3e-2)', async ({ page }) => {
  await signIn(page)
  await expect(page.getByRole('button', { name: /^Account menu/ })).toBeVisible()
  const list = (await api(page, 'GET', 'connections')) as Array<{ id: string; name: string }>
  const local = list.find((c) => c.name === 'Local test')!.id
  const target = await connection(page, 'Replica copy')
  await api(page, 'POST', `connections/${local}/databases/shop/collections/e2esolo/documents`, {
    documents: [{ _id: 1 }],
  })
  await page.goto(`c/${local}/db/shop/coll/e2esolo`)
  // The workspace is up (its collection tab shown) before the palette is asked for: a slow run
  // pressed Ctrl+K before the page listened (phase 4a-1 gate).
  await expect(page.getByRole('tab', { name: 'shop.e2esolo' })).toBeVisible()
  await page.keyboard.press('Control+k')
  await page.getByPlaceholder('Type a command…').fill('Keep this collection in sync')
  await page.keyboard.press('Enter')
  const wizard = page.getByRole('dialog')
  await wizard.getByLabel('Target connection').selectOption(target)
  await wizard.getByRole('button', { name: 'Next' }).click()
  await wizard.getByRole('button', { name: 'Next' }).click()
  await expect(wizard.getByText('The source is a standalone server')).toBeVisible({ timeout: 20_000 })
  await expect(wizard.getByRole('button', { name: 'Start live sync' })).toBeDisabled()
})
