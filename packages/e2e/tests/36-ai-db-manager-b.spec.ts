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

/**
 * The AI database manager, wave B (design 2026-10-25): from one chat, with a stubbed provider — a
 * find's documents shown in its step, the server's health, a schedule paused, a backup restored on its
 * typed card, a MongoDB user made on a card whose password is typed there (and one over the
 * deployment refused in words), the audit tying the user's row to the turn, and the page the person is
 * on told to the agent.
 */
test('the agent reads, pauses, restores and manages users from one chat (wave B)', async ({
  page,
  cspViolations,
  foreignRequests,
}) => {
  test.setTimeout(300_000)
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
  for (const db of ['e2emgr', 'e2erestored'])
    await api(page, 'DELETE', `connections/${local}/databases/${db}`, { confirm: db })
  await api(page, 'POST', `connections/${local}/databases/e2emgr/collections/items/documents`, {
    documents: [
      { n: 1, label: 'first item' },
      { n: 2, label: 'second item' },
    ],
  })
  await api(page, 'DELETE', `connections/${local}/database-access/users/e2emgr/reporter`)
  const dest = (
    await api(page, 'POST', 'backup-destinations', {
      type: 'folder',
      name: 'Manager disk',
      config: { path: join(process.env.MM_E2E_DEST_ROOT!, 'manager-b') },
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
  // A review run keeps screens of the new parts (MM_UI_REVIEW).
  const shot = async (name: string) => {
    if (process.env.MM_UI_REVIEW) await page.screenshot({ path: `test-results/ui-review/ai-b-${name}.png` })
  }

  // B5: a find's documents, shown in its step from the person's own read, on asking.
  await ask('find the e2emgr items')
  await expect(panel.getByText('Found them.')).toBeVisible()
  const find = steps.locator('[data-agent-step="find_documents"]').last()
  await find.getByRole('button', { name: 'Show documents' }).click()
  // Drawn as it scrolls into view (the documents' own lazy view): the first, and how many.
  await expect(find.locator('[data-agent-results-list]')).toContainText('first item')
  await expect(find.locator('[data-agent-results-list]')).toContainText('2 documents')
  await expect(find.locator('[data-agent-results-list]')).toContainText('never sent to the assistant')
  await shot('b5-results')

  // B3: the server's health, read.
  await ask('how is Local test doing?')
  await expect(panel.getByText('The server answers.')).toBeVisible()
  await expect(steps.locator('[data-agent-step="server_status"]').last()).toBeVisible()

  // Set-up through wave A: a backup to restore, a schedule to pause.
  await ask('back up e2emgr now')
  await panel.locator('[data-agent-card]').last().getByRole('button', { name: 'Confirm' }).click()
  await expect(panel.getByText('I am following the backup.')).toBeVisible()
  await expect
    .poll(
      async () =>
        ((await api(page, 'GET', 'jobs')).body as { jobs: Array<{ kind: string; state: string }> }).jobs.find(
          (j) => j.kind === 'backup.dump',
        )?.state,
      { timeout: 120_000 },
    )
    .toBe('done')
  await ask('back up e2emgr every monday at 3')
  await panel.locator('[data-agent-card]').last().getByRole('button', { name: 'Confirm' }).click()
  await expect(panel.getByText('Scheduled.')).toBeVisible()

  // B1: the schedule paused on its card.
  await ask('pause the weekly e2emgr')
  const pausing = panel.locator('[data-agent-card]').last()
  await expect(pausing).toContainText('Weekly e2emgr')
  await pausing.getByRole('button', { name: 'Confirm' }).click()
  await expect(panel.getByText('Paused.')).toBeVisible()
  const { schedules } = (await api(page, 'GET', 'backup-schedules')).body as {
    schedules: Array<{ id: string; name: string; state: string }>
  }
  const weekly = schedules.find((s) => s.name === 'Weekly e2emgr')!
  expect(weekly.state).toBe('paused')

  // B2: the backup restored into another database, its name typed on the card.
  await ask('restore the e2emgr backup')
  const restoring = panel.locator('[data-agent-card]').last()
  await expect(restoring).toContainText('Restore a backup')
  await shot('b2-restore-card')
  await restoring.locator('[data-agent-typed]').fill('e2erestored')
  await restoring.getByRole('button', { name: 'Confirm' }).click()
  await expect(panel.getByText('Restored.')).toBeVisible()

  // B4: a user made on a card whose password is typed (generated) there; the audit ties it to the turn.
  await ask('add a reporting user')
  const making = panel.locator('[data-agent-card]').last()
  await expect(making).toContainText('Create a MongoDB user')
  await shot('b4-user-card')
  await making.getByRole('button', { name: 'Generate', exact: true }).click()
  await making.getByRole('button', { name: 'Confirm' }).click()
  await expect(panel.getByText('User created.')).toBeVisible()
  const made = (
    (await api(page, 'GET', 'audit?action=mongo.users.create&limit=5')).body as Array<{
      details: { agent?: { run: string } }
    }>
  )[0]!
  expect(made.details.agent?.run).toEqual(expect.any(String))
  const turn = (await api(page, 'GET', `audit?run=${made.details.agent!.run}&limit=50`)).body as Array<{
    action: string
  }>
  expect(turn.map((r) => r.action)).toEqual(expect.arrayContaining(['ai.agent.tool', 'mongo.users.create']))
  // A role over the whole deployment is refused, in words.
  await ask('make a root user')
  await expect(panel.getByText('That one is not mine to give.')).toBeVisible()
  await shot('b8-refused-words')
  await expect(steps.locator('[data-agent-step="create_user"]').last()).toContainText(
    'That role gives rights over the whole deployment',
  )

  // B7: the page the person is on goes with the turn.
  await page.goto('schedules')
  const toggle = page.getByRole('button', { name: 'Assistant', exact: true })
  await expect(page.getByRole('tab', { name: 'Scheduled backups' })).toBeVisible()
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
  await panel.getByRole('switch', { name: 'Agent mode' }).check()
  await ask('what is this page?')
  await expect(panel.getByText('You are on schedules.')).toBeVisible()
  await shot('b7-page-focus')

  await api(page, 'DELETE', `backup-schedules/${weekly.id}`, { confirm: weekly.name })
  await api(page, 'DELETE', `connections/${local}/database-access/users/e2emgr/reporter`)
  for (const db of ['e2emgr', 'e2erestored'])
    await api(page, 'DELETE', `connections/${local}/databases/${db}`, { confirm: db })
  await api(page, 'PUT', 'me/ai-agent', { on: false })
  await api(page, 'DELETE', `backup-destinations/${dest.id}`)
  expect(cspViolations).toEqual([])
  expect(foreignRequests).toEqual([])
})
