// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { Page } from '@playwright/test'
import { ADMIN, expect, signIn, test, watchCsp, watchOrigins } from '../fixtures'

async function api(page: Page, method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, data?: object) {
  const me = await (await page.request.get('api/auth/me')).json()
  return page.request.fetch(`api/${path}`, {
    method,
    ...(data ? { data } : {}),
    headers: { 'x-csrf-token': me.csrfToken, origin: new URL(page.url()).origin },
  })
}
async function ok(page: Page, method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, data?: object) {
  const res = await api(page, method, path, data)
  expect(res.ok(), await res.text()).toBe(true)
  return res.status() === 204 ? null : res.json()
}

const READER = { username: 'plugreader', password: 'plug-reader-password-1' }
const PLUGIN = 'duplicate-finder'

// Phase 4b in team mode: an administrator approves a plugin; a user who may read a connection uses
// it there, and may neither approve nor manage plugins.
test('a plugin an administrator approved is used by a reader, who cannot approve one', async ({
  page,
  browser,
  baseURL,
  cspViolations,
  foreignRequests,
}) => {
  test.setTimeout(150_000)
  await signIn(page)
  await expect(page.getByRole('button', { name: /^Account menu/ })).toBeVisible()
  const list = (await ok(page, 'GET', 'connections')) as Array<{ id: string; name: string }>
  const conn = list.find((c) => c.name === 'Local test')!.id
  const reader = (await ok(page, 'POST', 'users', {
    ...READER,
    role: 'viewer',
    currentPassword: ADMIN.password,
  })) as { id: string }
  let approved = false
  const other = await browser.newContext({ locale: 'en-US' })
  try {
    await ok(page, 'PUT', `connections/${conn}/grants/${reader.id}`, { role: 'viewer' })
    // A collection of its own, whatever an earlier run left.
    await api(page, 'DELETE', `connections/${conn}/databases/shop/collections/e2edup`, { confirm: 'e2edup' })
    await ok(page, 'POST', `connections/${conn}/databases/shop/collections/e2edup/documents`, {
      documents: [{ email: 'a@x' }, { email: 'a@x' }, { email: 'b@x' }],
    })
    await page.goto('plugins')
    const card = page.locator(`[data-plugin="${PLUGIN}"]`)
    await card.getByRole('button', { name: 'Approve and enable' }).click()
    approved = true
    await page.locator('[data-test="confirm"]').click()
    await expect(card.locator('[data-plugin-status]')).toHaveText('Enabled')

    const readerPage = await other.newPage()
    watchCsp(readerPage, cspViolations)
    watchOrigins(readerPage, new URL(baseURL!).origin, foreignRequests)
    await signIn(readerPage, READER)
    await expect(readerPage.getByRole('button', { name: /^Account menu/ })).toBeVisible()
    // The reader uses it on a collection they may read.
    await readerPage.goto(`c/${conn}/db/shop/coll/e2edup`)
    await readerPage
      .getByRole('tablist', { name: 'Collection sections' })
      .getByRole('tab', { name: 'Duplicates', exact: true })
      .click()
    const frame = readerPage.frameLocator('[data-plugin-frame] iframe')
    await expect(frame.locator('#suggestions button').first()).toBeVisible()
    await frame.locator('#fields').fill('email')
    await frame.getByRole('button', { name: 'Find duplicates' }).click()
    await expect(frame.locator('#status')).toContainText('1 duplicated value · 2 documents involved')
    // Managing plugins is an administrator's: refused to the reader for their role, on the server
    // (not for a missing CSRF token: the same calls succeed for the administrator).
    expect((await api(page, 'GET', 'plugins/manage')).status()).toBe(200)
    for (const res of [
      await api(readerPage, 'GET', 'plugins/manage'),
      await api(readerPage, 'POST', `plugins/${PLUGIN}/approve`, { digest: 'x' }),
    ]) {
      expect(res.status()).toBe(403)
      expect(((await res.json()) as { details?: { reason?: string } }).details?.reason).not.toBe('csrf')
    }
  } finally {
    await other.close()
    if (approved) {
      await page.goto('plugins')
      await page.locator(`[data-plugin="${PLUGIN}"]`).getByRole('button', { name: 'Disable' }).click()
      await expect(page.locator(`[data-plugin="${PLUGIN}"] [data-plugin-status]`)).not.toHaveText('Enabled')
    }
    await ok(page, 'DELETE', `users/${reader.id}`)
  }
})
