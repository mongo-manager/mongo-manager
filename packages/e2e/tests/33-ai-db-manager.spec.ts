// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { Page } from '@playwright/test'
import { join } from 'node:path'
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

// The schedule is made in the browser's own zone when the model names none (A4).
test.use({ timezoneId: 'Asia/Tokyo' })

/**
 * The AI database manager, wave A (design 2026-10-25): from one chat, with a stubbed provider — a
 * connection checked, documents shown in the app, a backup started and followed, a schedule made in
 * the person's time zone, and an administrator's policy said where the switch is.
 */
test('the agent checks, shows, backs up, follows and schedules from one chat (wave A)', async ({
  page,
  cspViolations,
  foreignRequests,
}) => {
  test.setTimeout(240_000)
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
  const connections = (await api(page, 'GET', 'connections')).body as Array<{ id: string; name: string }>
  const local = connections.find((c) => c.name === 'Local test')!.id
  await api(page, 'DELETE', `connections/${local}/databases/e2emgr`, { confirm: 'e2emgr' })
  await api(page, 'POST', `connections/${local}/databases/e2emgr/collections/items/documents`, {
    documents: [{ n: 1 }, { n: 2 }],
  })
  const dest = (
    await api(page, 'POST', 'backup-destinations', {
      type: 'folder',
      name: 'Manager disk',
      config: { path: join(process.env.MM_E2E_DEST_ROOT!, 'manager') },
      policy: { encryptedOnly: false },
    })
  ).body as { id: string }

  await page.goto(`c/${local}`)
  await page.getByRole('button', { name: 'Assistant', exact: true }).click()
  const panel = page.getByRole('complementary', { name: 'Assistant' })
  await panel.getByRole('switch', { name: 'Agent mode' }).check()
  const box = panel.getByLabel('Message the assistant')
  // A message goes once the turn before has ended (while it runs, Enter does not send: Stop is shown).
  const ask = async (words: string) => {
    await expect(panel.getByRole('button', { name: 'Send' })).toBeVisible()
    await box.fill(words)
    await box.press('Enter')
    await expect(box).toHaveValue('')
  }
  const steps = panel.locator('[data-agent-steps]')

  // A5: a connection checked — opened as the person would, said connected.
  await ask('is Local test up?')
  await expect(panel.getByText('Local test answers.')).toBeVisible()
  await expect(steps.locator('[data-agent-step="check_connection"]').last()).toContainText('Connected')

  // A1: documents shown in the app, the find in its bar and run.
  await ask('show me the big orders')
  await expect(panel.getByText('Here they are, in the app.')).toBeVisible()
  await expect(page.getByRole('tab', { name: 'shop.orders' })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Filter', exact: true })).toHaveValue('{ qty: { $gt: 5 } }')

  // A3: a backup started on its card, then followed by its job; the step opens Background jobs.
  await ask('back up e2emgr now')
  const card = panel.locator('[data-agent-card]').last()
  await expect(card).toContainText('Back up')
  await expect(card).toContainText('Manager disk')
  await card.getByRole('button', { name: 'Confirm' }).click()
  await expect(panel.getByText('I am following the backup.')).toBeVisible()
  await expect(steps.locator('[data-agent-step="get_job"]').last()).toBeVisible()
  await steps
    .locator('[data-agent-step="run_backup"]')
    .last()
    .getByRole('button', { name: 'Open in Background jobs' })
    .click()
  await expect(page.getByRole('tab', { name: 'Background jobs' })).toBeVisible()

  // A4: a schedule made in the browser's zone, its next runs shown there before the click.
  await ask('back up e2emgr every monday at 3')
  const scheduling = panel.locator('[data-agent-card]').last()
  await expect(scheduling).toContainText('Create a backup schedule')
  await expect(scheduling).toContainText('GMT+9')
  await scheduling.getByRole('button', { name: 'Confirm' }).click()
  await expect(panel.getByText('Scheduled.')).toBeVisible()
  const { schedules } = (await api(page, 'GET', 'backup-schedules')).body as {
    schedules: Array<{ id: string; name: string; timeZone: string }>
  }
  const made = schedules.find((s) => s.name === 'Weekly e2emgr')!
  expect(made.timeZone).toBe('Asia/Tokyo')
  await api(page, 'DELETE', `backup-schedules/${made.id}`, { confirm: made.name })

  // A2: an administrator's policy, said where the switch is.
  expect((await api(page, 'PUT', 'ai/agent-policy', { policy: 'off' })).ok).toBe(true)
  try {
    await page.reload()
    // The panel stays as it was across a reload: opened only where it is closed.
    const toggle = page.getByRole('button', { name: 'Assistant', exact: true })
    await expect(page.getByRole('button', { name: /^Account menu/ })).toBeVisible()
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
    await expect(panel.getByRole('switch', { name: 'Agent mode' })).toBeDisabled()
    await expect(panel.getByText('An administrator turned agent mode off on this server.')).toBeVisible()
  } finally {
    await api(page, 'PUT', 'ai/agent-policy', { policy: 'full' })
  }

  await api(page, 'PUT', 'me/ai-agent', { on: false })
  await api(page, 'DELETE', `backup-destinations/${dest.id}`)
  expect(cspViolations).toEqual([])
  expect(foreignRequests).toEqual([])
})
