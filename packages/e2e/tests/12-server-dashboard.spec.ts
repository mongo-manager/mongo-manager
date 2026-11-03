import { type Page } from '@playwright/test'
import { ADMIN, expect, pickRulePart, signIn, test, watchCsp, watchOrigins } from '../fixtures'

/**
 * Phase 3b-1: a connection admin changes the profiler, reads a slow query with its command, marks
 * a personal field and restricts an editor; that editor then sees the value as *** and gets no
 * "Open in Explain". Setup that other specs already cover in the UI (creating a user) goes through
 * the REST API.
 */
const EDITOR = { username: 'masked-editor', password: 'violet-harbor-lantern-42' }

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

async function openPerformance(page: Page, id: string): Promise<void> {
  await page.goto(`c/${id}`)
  await page.getByRole('tab', { name: 'Performance' }).click()
  await expect(page.getByRole('heading', { name: 'Profiler' })).toBeVisible({ timeout: 20_000 })
}

/** UI redesign R3: the profiler's level is a segmented control in a dialog. */
const LEVELS: Record<string, string> = { '0': 'Off', '1': 'Slow operations', '2': 'All operations' }

async function findSlowQuery(page: Page): Promise<void> {
  const panel = page.locator('[data-slow-queries]')
  await panel.locator('[data-slow-db]').fill('shop')
  await panel.getByLabel('Collection').fill('e2emask')
  await panel.getByRole('button', { name: 'Apply' }).click()
  await expect(panel.locator('[data-slow-entry]').first()).toContainText('shop.e2emask', { timeout: 15_000 })
  await panel.locator('[data-slow-entry]').first().click()
}

/** Plugins wave 4 (§6b): the slow queries by shape, the e2emask group opened; `absent` never in it. */
async function byShape(page: Page, absent?: string): Promise<void> {
  const panel = page.locator('[data-slow-queries]')
  await panel.getByRole('radio', { name: 'By shape' }).click()
  const group = panel.locator('[data-slow-group]').filter({ hasText: 'shop.e2emask' }).first()
  await expect(group).toBeVisible()
  await group.click()
  const detail = panel.locator('[data-slow-group-detail]')
  await expect(detail).toContainText('"?"')
  if (absent) await expect(detail).not.toContainText(absent)
  await panel.getByRole('radio', { name: 'List' }).click()
}

test('an admin changes the profiler and reads a slow query; a restricted editor sees *** (phase 3b)', async ({
  page,
  browser,
  baseURL,
  cspViolations,
  foreignRequests,
}) => {
  await signIn(page)
  await expect(page.getByRole('button', { name: /^Account menu/ })).toBeVisible()
  const id = await connectionId(page)
  // User request 2026-10-24: a rule names a field the collection's documents hold, and its picker reads
  // a sample of them: both before the profiler runs, so no slow query is theirs. The admin sees the
  // values all the same (the rules hide them from those who may not see personal data).
  const seeded = await page.request.post(
    `api/connections/${id}/databases/shop/collections/e2emask/documents`,
    {
      data: { documents: [{ email: 'seed@x' }] },
      headers: { 'x-csrf-token': await csrf(page) },
    },
  )
  expect(seeded.ok()).toBe(true)

  // Personal data: shop.e2emask.email, in the connection's Personal data tab.
  await page.goto(`c/${id}`)
  await page
    .getByRole('tablist', { name: 'Connection sections' })
    .getByRole('tab', { name: 'Personal data', exact: true })
    .click()
  const card = page.locator('[data-personal-data]')
  // User request 2026-10-24: picked from what the server holds, and saved at once.
  await pickRulePart(page, card, 'data-rule-db', 'shop')
  await pickRulePart(page, card, 'data-rule-coll', 'e2emask')
  await pickRulePart(page, card, 'data-rule-field', 'email')
  await expect(card.locator('[data-rules-status]')).toHaveText('Saved.')
  // Profiler: shop to level 1 with slowms 0, so every operation there is profiled.
  await openPerformance(page, id)
  await page.locator('[data-profiler-edit="shop"]').click()
  await page.getByRole('dialog').getByRole('radio', { name: LEVELS['1'] }).click()
  await page.locator('[data-profiler-form]').getByLabel('slowms').fill('0')
  await page.locator('[data-profiler-save]').click()
  await expect(page.getByText('Profiler of shop changed')).toBeVisible()

  // A query holding a value that will be personal: counted through the app's REST API.
  const count = await page.request.post(`api/connections/${id}/databases/shop/collections/e2emask/count`, {
    data: { filter: { email: 'e2e@x' } },
    headers: { 'x-csrf-token': await csrf(page) },
  })
  expect(count.ok()).toBe(true)

  // The admin reads it with its value, and may open it in Explain.
  await openPerformance(page, id)
  await findSlowQuery(page)
  await expect(page.locator('[data-slow-queries] pre').first()).toContainText('e2e@x')
  // Plugins wave 4 (§6b): the same query grouped by its shape, every value a ?.
  await byShape(page)

  // An editor who cannot see personal data.
  const created = await page.request.post('api/users', {
    data: { ...EDITOR, role: 'editor', currentPassword: ADMIN.password },
    headers: { 'x-csrf-token': await csrf(page) },
  })
  expect(created.ok()).toBe(true)
  await page.reload()
  // The access card is on the Overview (scoped to the connection's sections: a collection has one too).
  await page
    .getByRole('tablist', { name: 'Connection sections' })
    .getByRole('tab', { name: 'Overview', exact: true })
    .click()
  await page.getByLabel(`Access of ${EDITOR.username}`).selectOption('editor')
  await expect(page.getByText(`Access of ${EDITOR.username} updated.`)).toBeVisible()
  await page.locator('[data-grant-masked] input').last().check()
  await expect(page.locator('[data-grant-masked] input').last()).toBeChecked()

  // That editor sees the command with *** in place of the value, and no Explain.
  const other = await browser.newContext({ locale: 'en-US' })
  const editorPage = await other.newPage()
  watchCsp(editorPage, cspViolations)
  watchOrigins(editorPage, new URL(baseURL!).origin, foreignRequests)
  await signIn(editorPage, EDITOR)
  await expect(editorPage.getByRole('button', { name: /^Account menu/ })).toBeVisible()
  await openPerformance(editorPage, id)
  await findSlowQuery(editorPage)
  const command = editorPage.locator('[data-slow-queries] pre').first()
  await expect(command).toContainText('***')
  await expect(command).not.toContainText('e2e@x')
  await expect(editorPage.locator('[data-slow-explain]')).toHaveCount(0)
  // Its shape tells no value either.
  await byShape(editorPage, 'e2e@x')
  await other.close()

  // Back as the admin: the profiler off again.
  await openPerformance(page, id)
  await page.locator('[data-profiler-edit="shop"]').click()
  await page.getByRole('dialog').getByRole('radio', { name: LEVELS['0'] }).click()
  await page.locator('[data-profiler-form]').getByLabel('slowms').fill('100')
  await page.locator('[data-profiler-save]').click()
  await expect(page.getByText('Profiler of shop changed')).toBeVisible()
})
