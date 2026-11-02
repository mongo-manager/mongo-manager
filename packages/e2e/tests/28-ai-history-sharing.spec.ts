import type { Page } from '@playwright/test'
import { ADMIN, expect, signIn, test, watchCsp, watchOrigins } from '../fixtures'

async function call(page: Page, method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, data?: object) {
  const me = await (await page.request.get('api/auth/me')).json()
  return page.request.fetch(`api/${path}`, {
    method,
    ...(data ? { data } : {}),
    headers: { 'x-csrf-token': me.csrfToken, origin: new URL(page.url()).origin },
  })
}
async function api(page: Page, method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, data?: object) {
  const res = await call(page, method, path, data)
  expect(res.ok(), await res.text()).toBe(true)
  return res.status() === 204 ? null : res.json()
}

const MATE = { username: 'aimate', password: 'ai-mate-password-1' }

// User review 2026-10-09: an AI request is the asker's own until shared; shared, a teammate who may
// read its connection reads it, read-only, and no longer once it is unshared.
test('an AI request shared with the team is read by a teammate, until it is unshared', async ({
  page,
  browser,
  baseURL,
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
  const mate = (await api(page, 'POST', 'users', {
    ...MATE,
    role: 'viewer',
    currentPassword: ADMIN.password,
  })) as { id: string }
  const other = await browser.newContext({ locale: 'en-US' })
  let requestId: string | null = null
  try {
    await api(page, 'PUT', `connections/${conn}/grants/${mate.id}`, { role: 'viewer' })
    await api(page, 'POST', `connections/${conn}/databases/shop/collections/e2eshare/documents`, {
      documents: [{ qty: 1 }, { qty: 2 }],
    })
    await page.goto(`c/${conn}/db/shop/coll/e2eshare`)
    await expect(page.getByRole('tab', { name: 'shop.e2eshare' })).toBeVisible()
    await page.getByRole('button', { name: 'Assistant', exact: true }).click()
    const panel = page.getByRole('complementary', { name: 'Assistant' })
    await panel.getByLabel('Message the assistant').fill('what is shared in here?')
    await panel.getByLabel('Message the assistant').press('Enter')
    await expect(panel.getByRole('button', { name: 'Send', exact: true })).toBeVisible()
    // The assistant is a window over the page (user report 2026-10-25): closed, as a person would,
    // before the page under it is used (it stays open across a reload).
    await page.getByRole('button', { name: 'Assistant', exact: true }).click()
    await expect(panel).toBeHidden()

    await page.goto('ai-history')
    const line = page.locator('[data-request]', { hasText: 'what is shared in here?' }).first()
    requestId = await line.getAttribute('data-request')

    // Not shared yet: the teammate sees nothing of it, and cannot share it themselves.
    const matePage = await other.newPage()
    watchCsp(matePage, cspViolations)
    watchOrigins(matePage, new URL(baseURL!).origin, foreignRequests)
    await signIn(matePage, MATE)
    await expect(matePage.getByRole('button', { name: /^Account menu/ })).toBeVisible()
    await matePage.goto('ai-history')
    await matePage.getByText('Shared with me', { exact: true }).click()
    await expect(matePage.getByText('Nothing is shared with you yet')).toBeVisible()
    expect((await call(matePage, 'GET', `ai/history/${requestId}`)).ok()).toBe(false)
    const theirs = await call(matePage, 'POST', `ai/history/${requestId}/share`)
    expect([403, 404]).toContain(theirs.status())

    // Shared from the AI history.
    await line.getByRole('button').first().click()
    await page.locator('[data-request-share]').click()
    await expect(page.getByText('Shared with the team.')).toBeVisible()
    await expect(page.locator('[data-request-shared]').first()).toBeVisible()

    // The teammate reads it among what is shared with them, read-only.
    await matePage.goto('ai-history')
    await matePage.getByText('Shared with me', { exact: true }).click()
    const seen = matePage.locator('[data-request]', { hasText: 'what is shared in here?' }).first()
    await seen.getByRole('button').first().click()
    await expect(matePage.getByText(`Shared by admin · read-only`)).toBeVisible()
    await expect(matePage.locator('[data-request-share]')).toHaveCount(0)
    // Read, never changed: its unsharing is the asker's.
    expect([403, 404]).toContain((await call(matePage, 'DELETE', `ai/history/${requestId}/share`)).status())

    // Unshared: gone for the teammate.
    await page.getByRole('button', { name: 'Stop sharing' }).click()
    await expect(page.getByText('No longer shared.')).toBeVisible()
    await matePage.goto('ai-history')
    await matePage.getByText('Shared with me', { exact: true }).click()
    await expect(matePage.getByText('Nothing is shared with you yet')).toBeVisible()
  } finally {
    await other.close()
    if (requestId) await call(page, 'DELETE', `ai/history/${requestId}/share`)
    await call(page, 'DELETE', `users/${mate.id}`)
    await call(page, 'DELETE', 'ai/chats')
  }
})
