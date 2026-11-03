import type { Page } from '@playwright/test'
import { parseConnectionUri } from '../../../shared/src/connections'
import { expect, localHeaders, test } from '../../fixtures'

/**
 * Plugins wave 4 (design): a database's
 * storage read and a collection compacted through the app's dialog, a shard key analysed on a
 * standalone server (which says so), a search tab where search is not enabled (the full-text and
 * vector searches need mongot, which this MongoDB has not: their pipelines, scores and highlights
 * are the unit tests'), and an anonymised copy handed to the Import wizard and imported — in Chrome.
 */
const WAVE4 = ['storage-report', 'shard-key-analyzer', 'search-playground', 'anonymiser']

async function api(page: Page, method: 'GET' | 'POST' | 'DELETE', path: string, data?: object) {
  const local = await localHeaders(page)
  const me = await (await page.request.get('api/auth/me', { headers: local })).json()
  const res = await page.request.fetch(`api/${path}`, {
    method,
    ...(data ? { data } : {}),
    headers: { ...local, 'x-csrf-token': me.csrfToken, origin: new URL(page.url()).origin },
  })
  return res
}
async function ok(page: Page, method: 'GET' | 'POST', path: string, data?: object) {
  const res = await api(page, method, path, data)
  expect(res.ok(), await res.text()).toBe(true)
  return res.json()
}
async function approve(page: Page, id: string): Promise<void> {
  const card = page.locator(`[data-plugin="${id}"]`)
  await card.getByRole('button', { name: 'Approve and enable' }).click()
  await page.locator('[data-test="confirm"]').click()
  await expect(card.locator('[data-plugin-status]')).toHaveText('Enabled')
}
/** Left as found for the tests after this one, even when this one fails halfway. */
async function disableAll(page: Page, ids: string[]): Promise<void> {
  await page.goto('/plugins')
  for (const id of ids) {
    const disable = page.locator(`[data-plugin="${id}"]`).getByRole('button', { name: 'Disable' })
    if (await disable.isVisible()) await disable.click()
  }
}
test.afterEach(async ({ page }) => disableAll(page, WAVE4))
const section = (page: Page, name: string) =>
  page.getByRole('tablist', { name: 'Collection sections' }).getByRole('tab', { name, exact: true })
const frame = (page: Page) => page.frameLocator('[data-plugin-frame] iframe:visible')
/** A file or documents asked for within 5 seconds of a press in the app are asked about first. */
const pastAppPress = (page: Page) => page.waitForTimeout(5_200)
const shot = async (page: Page, name: string) => {
  if (process.env.MM_UI_REVIEW) await page.screenshot({ path: `test-results/ui-review/w4-${name}.png` })
}

test('the wave 4 plugins on a real MongoDB', async ({ page }) => {
  test.setTimeout(300_000)
  await page.goto('/')
  const { id } = (await ok(page, 'POST', 'connections', {
    name: 'Wave 4',
    favorite: false,
    readOnly: false,
    settings: parseConnectionUri(process.env.MM_E2E_MONGO_URI!),
  })) as { id: string }
  // A database left by an earlier run never counts.
  await api(page, 'DELETE', `connections/${id}/databases/wave4`, { confirm: 'wave4' })
  const docs = (coll: string) => `connections/${id}/databases/wave4/collections/${coll}/documents`
  const people = [0, 1, 2].map((i) => ({
    _id: { $oid: `65a1b2c3d4e5f60718293c0${i}` },
    name: ['Ada Lovelace', 'Grace Hopper', 'Linus Torvalds'][i],
    email: `user${i}@example.com`,
    city: ['Izmir', 'Ankara', 'Bursa'][i],
    total: { $numberInt: String(10 * (i + 1)) },
  }))
  await ok(page, 'POST', docs('people'), { documents: people })
  await ok(page, 'POST', docs('orders'), { documents: [{ total: 5 }, { total: 7 }] })
  await page.goto('/plugins')
  for (const plugin of WAVE4) await approve(page, plugin)

  const url = `c/${id}/db/wave4/coll/people`
  await page.goto(url)

  // Storage: the database's collections; an estimate; compact after the collection's name is typed.
  await section(page, 'Storage').click()
  await expect(frame(page).locator('[data-coll="people"]')).toContainText('This collection')
  await expect(frame(page).locator('[data-coll="orders"]')).toBeVisible()
  await expect(frame(page).locator('#totals')).toBeVisible()
  await shot(page, 'storage')
  await frame(page).locator('#estimate').click()
  await expect(frame(page).locator('#estimate-result')).toHaveText(/Compact would give back|MongoDB 8\.0/)
  await frame(page).locator('#compact').click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('Storage report (storage-report) asks to compact a collection')
  await expect(dialog.locator('[data-test="confirm"]')).toBeDisabled()
  await dialog.locator('[data-test="require-text"] input').fill('people')
  await dialog.locator('[data-test="confirm"]').click()
  await expect(frame(page).locator('#status')).toContainText('people compacted', { timeout: 60_000 })

  // Shard key: a candidate analysed; a standalone server says it cannot.
  await page.goto(url)
  await section(page, 'Shard key').click()
  await frame(page).locator('#field').selectOption('email')
  await frame(page).locator('#add-field').click()
  await frame(page).locator('#analyze').click()
  await expect(frame(page).locator('#results')).toContainText(/replica set|MongoDB 7\.0/)
  await shot(page, 'shard-key')

  // Search: where search is not enabled (no mongot), the tab says so.
  await page.goto(url)
  await section(page, 'Search').click()
  await expect(frame(page).locator('body')).toContainText(/not enabled|does not support search/)

  // Anonymise: fake e-mails in the preview, then a copy imported into a new collection.
  await page.goto(url)
  await section(page, 'Anonymise').click()
  await expect(frame(page).locator('[data-field="email"] select[data-technique]')).toHaveValue('fake')
  // The sample is random: every real e-mail before, none after.
  await expect(frame(page).locator('[data-before]')).toHaveCount(3)
  await expect(frame(page).locator('#preview')).toContainText(/user\d@example\.com/)
  for (const after of await frame(page).locator('[data-after]').all())
    await expect(after).not.toContainText(/user\d@example\.com/)
  await shot(page, 'anonymise')
  await frame(page).locator('#prepare').click()
  await expect(frame(page).locator('#status')).toContainText('The copy is ready: 3 documents')
  await pastAppPress(page)
  await frame(page).locator('#import').click()
  const wizard = page.getByRole('dialog')
  await expect(wizard).toContainText('Documents from Anonymiser (anonymiser)')
  await wizard.getByRole('button', { name: 'Next', exact: true }).click()
  await wizard.getByRole('button', { name: 'Next', exact: true }).click()
  await wizard.getByRole('button', { name: 'Import', exact: true }).click()
  const copied = `connections/${id}/databases/wave4/collections/people_anonymised`
  await expect
    .poll(
      async () => ((await ok(page, 'POST', `${copied}/count`, { filter: {} })) as { count: number }).count,
      {
        timeout: 60_000,
      },
    )
    .toBe(3)
  // Not one real e-mail in the copy.
  const found = (await ok(page, 'POST', `${copied}/count`, { filter: { email: { $regex: '^user' } } })) as {
    count: number
  }
  expect(found.count).toBe(0)
  await page.keyboard.press('Escape')
})
