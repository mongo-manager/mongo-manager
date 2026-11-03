import type { Page } from '@playwright/test'
import { parseConnectionUri } from '../../shared/src/connections'
import { expect, signIn, test } from '../fixtures'

async function api(page: Page, method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, data?: object) {
  const me = await (await page.request.get('api/auth/me')).json()
  const res = await page.request.fetch(`api/${path}`, {
    method,
    ...(data ? { data } : {}),
    headers: { 'x-csrf-token': me.csrfToken, origin: new URL(page.url()).origin },
  })
  return {
    ok: res.ok(),
    status: res.status(),
    body: res.status() === 204 ? null : await res.json().catch(() => null),
  }
}

/**
 * W6.3, user report 2026-10-16: "add a new collection named users to the Sales Mongo connection and add
 * a demo user". The agent finds Sales Mongo by name (its address never reaches the provider), uses its
 * default database and says so, proposes the collection and then the demo user — each written only
 * after a click on its card — and says what it did.
 */
test('the agent adds a collection and a demo user on the named connection, each confirmed (W6.3)', async ({
  page,
  cspViolations,
  foreignRequests,
}) => {
  test.setTimeout(150_000)
  await signIn(page)
  await expect(page.getByRole('button', { name: /^Account menu/ })).toBeVisible()
  for (const p of ((await api(page, 'GET', 'ai/providers')).body ?? []) as Array<{ id: string }>)
    await api(page, 'DELETE', `ai/providers/${p.id}`)
  await api(page, 'DELETE', 'ai/chats')
  expect(
    (
      await api(page, 'POST', 'ai/providers', {
        name: 'Fake',
        kind: 'openai',
        baseUrl: `${process.env.MM_E2E_AI_URL}/v1`,
        model: 'fake-model',
      })
    ).ok,
  ).toBe(true)
  // Sales Mongo: the test MongoDB under that name, with its default database.
  const db = 'sales_e2e'
  const connections = (await api(page, 'GET', 'connections')).body as Array<{ id: string; name: string }>
  let sales = connections.find((c) => c.name === 'Sales Mongo')?.id
  if (!sales)
    sales = (
      (
        await api(page, 'POST', 'connections', {
          name: 'Sales Mongo',
          favorite: false,
          readOnly: false,
          settings: { ...parseConnectionUri(process.env.MM_E2E_MONGO_URI!), defaultDatabase: db },
        })
      ).body as { id: string }
    ).id
  await api(page, 'DELETE', `connections/${sales}/databases/${db}`, { confirm: db })

  // Another connection's tab is in view: the request names Sales Mongo anyway.
  const local = connections.find((c) => c.name === 'Local test')!.id
  await page.goto(`c/${local}/db/shop/coll/orders`)
  await expect(page.getByRole('tab', { name: 'shop.orders' })).toBeVisible()
  await page.getByRole('button', { name: 'Assistant', exact: true }).click()
  const panel = page.getByRole('complementary', { name: 'Assistant' })
  await panel.getByRole('switch', { name: 'Agent mode' }).check()
  await expect(panel.getByText('You see each change and confirm it.')).toBeVisible()
  const box = panel.getByLabel('Message the assistant')
  await box.fill('add a new collection named users to the Sales Mongo connection and add a demo user')
  await box.press('Enter')

  const card = panel.locator('[data-agent-card]')
  await expect(card).toContainText('Create a collection')
  await expect(card).toContainText(`Sales Mongo · ${db}.users`)
  await expect(card).toContainText(`The database ${db} is new`)
  await expect(
    panel.getByText(`I will create users in ${db}, the default database of Sales Mongo.`),
  ).toBeVisible()
  // Nothing is written before the click.
  expect((await api(page, 'GET', `connections/${sales}/databases/${db}/collections`)).body ?? []).toEqual([])
  await card.getByRole('button', { name: 'Confirm' }).click()

  await expect(card).toContainText('Insert documents')
  await expect(card).toContainText('demo.user@example.com')
  await expect(card).toContainText('1 document will be inserted.')
  await card.getByRole('button', { name: 'Confirm' }).click()

  await expect(
    panel.getByText(`Done: users was created in ${db} on Sales Mongo, with a demo user.`),
  ).toBeVisible()
  await expect(panel.getByRole('button', { name: 'Send', exact: true })).toBeVisible()
  const found = (
    await api(page, 'POST', `connections/${sales}/databases/${db}/collections/users/find`, { filter: {} })
  ).body as { documents: Array<{ document: { name: string } }> }
  expect(found.documents.map((d) => d.document.name)).toEqual(['Demo User'])
  const steps = panel.locator('[data-agent-steps]')
  await expect(steps.locator('[data-agent-step="create_collection"]')).toContainText(`Created ${db}.users`)
  await expect(steps.locator('[data-agent-step="insert_documents"]')).toContainText('Inserted 1 document')

  // A link opens the collection the agent touched.
  await steps.locator('[data-agent-step="insert_documents"] [data-agent-open]').click()
  await expect(page.getByRole('tab', { name: `${db}.users` })).toBeVisible()

  // Each call is in the audit log, without the documents' values.
  const audit = (await api(page, 'GET', 'audit?action=ai.agent.tool')).body as Array<{
    details: { tool: string; state: string }
  }>
  expect(
    audit
      .slice(0, 2)
      .map((r) => [r.details.tool, r.details.state])
      .sort(),
  ).toEqual([
    ['create_collection', 'done'],
    ['insert_documents', 'done'],
  ])
  expect(JSON.stringify(audit)).not.toContain('demo.user@example.com')

  await api(page, 'PUT', 'me/ai-agent', { on: false })
  expect(cspViolations).toEqual([])
  expect(foreignRequests).toEqual([])
})
