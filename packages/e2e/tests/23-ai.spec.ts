import type { Page } from '@playwright/test'
import { expect, signIn, test, openFromSidebar } from '../fixtures'

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
 * Phase 4a-1 spec §7: an administrator adds and tests a provider; a query and a pipeline are asked
 * for, streamed, inserted and run; nothing reaches another origin from the browser.
 */
test('asks the assistant for a query and a pipeline, inserts and runs them (phase 4a-1)', async ({
  page,
  cspViolations,
  foreignRequests,
}) => {
  test.setTimeout(120_000)
  await signIn(page)
  await expect(page.getByRole('button', { name: /^Account menu/ })).toBeVisible()
  // A clean slate: earlier runs' providers go.
  for (const p of (await api(page, 'GET', 'ai/providers')) as Array<{ id: string }>)
    await api(page, 'DELETE', `ai/providers/${p.id}`)

  await openFromSidebar(page, 'Integrations', 'AI providers')
  await page.getByRole('button', { name: 'Add provider' }).click()
  const editor = page.getByRole('dialog')
  await editor.getByLabel('Name').fill('Fake')
  await editor.getByLabel('Kind').selectOption('openai')
  await editor.getByLabel('Address').fill(`${process.env.MM_E2E_AI_URL}/v1`)
  await editor.getByLabel('Model').fill('fake-model')
  // A list opened from the editor (2026-10-24): a press on its padding keeps the focus in its search
  // field, and Escape closes the list, not the editor. The models are this test's own answer.
  await page.route('**/api/ai/models', (route) =>
    route.fulfill({ json: { outcome: 'ok', models: [{ id: 'fake-model' }, { id: 'other-model' }] } }),
  )
  await editor.getByRole('button', { name: 'Fetch models' }).click()
  await editor.getByRole('button', { name: 'Choose a model' }).click()
  const models = page.getByRole('listbox', { name: 'Choose a model' })
  await expect(models).toBeVisible()
  const box = (await models.boundingBox())!
  await page.mouse.click(box.x + 2, box.y + 2)
  await expect(page.getByRole('combobox', { name: 'Choose a model' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(models).toBeHidden()
  await expect(editor).toBeVisible()
  await page.unroute('**/api/ai/models')
  await editor.getByRole('button', { name: 'Save' }).click()
  await page.getByRole('button', { name: 'Test', exact: true }).click()
  await expect(page.getByText(/The provider answered in/)).toBeVisible()

  const list = (await api(page, 'GET', 'connections')) as Array<{ id: string; name: string }>
  const conn = list.find((c) => c.name === 'Local test')!.id
  await api(page, 'POST', `connections/${conn}/databases/shop/collections/e2eai/documents`, {
    documents: Array.from({ length: 10 }, (_, i) => ({ qty: i, status: i % 2 ? 'paid' : 'new' })),
  })
  await page.goto(`c/${conn}/db/shop/coll/e2eai`)

  await page.getByRole('button', { name: 'Ask AI' }).click()
  const sheet = page.getByRole('dialog')
  await sheet.getByLabel('What do you need?').fill('orders over five, biggest first')
  await sheet.getByRole('button', { name: 'Send' }).click()
  await expect(sheet.getByText('Orders over five')).toBeVisible()
  await expect(sheet.getByText('Suggested')).toBeVisible()
  await sheet.getByRole('button', { name: 'Insert' }).click()
  await page.getByRole('button', { name: 'Find' }).click()
  await expect(page.getByText('1–4 of')).toBeVisible()

  await page.getByRole('tab', { name: 'Aggregations' }).click()
  await page.keyboard.press('Control+i')
  await sheet.getByLabel('What do you need?').fill('count big orders by status')
  await sheet.getByRole('button', { name: 'Send' }).click()
  await expect(sheet.getByText('Counts orders by status')).toBeVisible()
  await sheet.getByRole('button', { name: 'Insert' }).click()
  await expect(page.getByRole('region', { name: 'Stage 2: $group' })).toBeVisible()

  expect(cspViolations).toEqual([])
  expect(foreignRequests).toEqual([])
})
