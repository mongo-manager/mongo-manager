import type { Page } from '@playwright/test'
import { parseConnectionUri } from '../../shared/src/connections'
import { expect, signIn, test } from '../fixtures'

test.skip(!process.env.MM_E2E_RS_URI, 'Watch needs a replica set (MM_E2E_RS_URI)')

async function api(page: Page, method: 'GET' | 'POST', path: string, data?: object) {
  const me = await (await page.request.get('api/auth/me')).json()
  const res = await page.request.fetch(`api/${path}`, {
    method,
    ...(data ? { data } : {}),
    headers: { 'x-csrf-token': me.csrfToken, origin: new URL(page.url()).origin },
  })
  expect(res.ok(), await res.text()).toBe(true)
  return res.status() === 204 ? null : res.json()
}

/** The replica set as a connection, made once per run. */
async function replicaConnection(page: Page): Promise<string> {
  const list = (await api(page, 'GET', 'connections')) as Array<{ id: string; name: string }>
  const found = list.find((c) => c.name === 'Replica test')
  if (found) return found.id
  const made = (await api(page, 'POST', 'connections', {
    name: 'Replica test',
    favorite: false,
    readOnly: false,
    settings: parseConnectionUri(process.env.MM_E2E_RS_URI!),
  })) as { id: string }
  return made.id
}

/**
 * Phase 3e-1 spec §5: watch a collection, change documents through the app, see each change and the
 * update's diff, pause and catch up; a standalone server says it cannot be watched.
 */
test('watches a collection live: changes, the diff, pause and catch up (phase 3e-1)', async ({
  page,
  cspViolations,
  foreignRequests,
}) => {
  test.setTimeout(120_000)
  await signIn(page)
  await expect(page.getByRole('button', { name: /^Account menu/ })).toBeVisible()
  const id = await replicaConnection(page)
  const base = `connections/${id}/databases/shop/collections/e2ewatch`
  await api(page, 'POST', `${base}/documents`, { documents: [{ _id: 'seed' }] })
  await page.goto(`c/${id}/db/shop/coll/e2ewatch`)
  await page.getByRole('tab', { name: 'Watch', exact: true }).click()
  await expect(page.getByText('Waiting for changes…')).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('[data-watch-status]')).toHaveText(/Live/)

  // Insert, update, delete through the app's API.
  await api(page, 'POST', `${base}/documents`, { documents: [{ _id: 'w1', status: 'new', total: 5 }] })
  const got = (await api(page, 'POST', `${base}/documents/get`, { _id: 'w1' })) as { hash: string }
  await api(page, 'POST', `${base}/documents/update`, { _id: 'w1', set: { status: 'paid' }, hash: got.hash })
  await api(page, 'POST', `${base}/documents/delete`, { _id: 'w1' })
  const rows = page.locator('[data-watch-row]')
  await expect(rows).toHaveCount(3, { timeout: 20_000 })
  await expect(rows.locator('[data-op]')).toHaveText(['Delete', 'Update', 'Insert'])

  // The update: what changed, and the hint about pre-images.
  await rows.nth(1).click()
  const detail = page.locator('[data-watch-detail]')
  await expect(detail).toContainText('status')
  await expect(detail).toContainText('"paid"')
  await expect(detail).toContainText('Turn on pre-images for this collection')

  // Pause: changes made meanwhile wait; Catch up delivers them.
  await page.locator('[data-watch-pause]').click()
  await expect(page.locator('[data-watch-status]')).toHaveText(/Paused/)
  await api(page, 'POST', `${base}/documents`, { documents: [{ _id: 'w2' }, { _id: 'w3' }] })
  await page.waitForTimeout(1_000)
  await expect(rows).toHaveCount(3)
  await page.locator('[data-watch-catch-up]').click()
  await expect(rows).toHaveCount(5, { timeout: 20_000 })

  // Open document: the Documents section, filtered by that _id.
  await rows.first().click()
  await page.locator('[data-watch-open]').click()
  await expect(page.getByRole('tab', { name: 'Documents', selected: true })).toBeVisible()
  await expect(page.getByText('w3').first()).toBeVisible()
  expect(cspViolations).toEqual([])
  expect(foreignRequests).toEqual([])
})

test('says a standalone server cannot be watched (phase 3e-1)', async ({ page }) => {
  await signIn(page)
  await expect(page.getByRole('button', { name: /^Account menu/ })).toBeVisible()
  const list = (await api(page, 'GET', 'connections')) as Array<{ id: string; name: string }>
  const local = list.find((c) => c.name === 'Local test')!.id
  await page.goto(`c/${local}`)
  await page.getByRole('tab', { name: 'Watch', exact: true }).click()
  await expect(page.getByText('Change streams need a replica set or a sharded cluster')).toBeVisible({
    timeout: 20_000,
  })
})
