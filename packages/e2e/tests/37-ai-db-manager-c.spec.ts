import type { Page } from '@playwright/test'
import { expect, signIn, test } from '../fixtures'

async function api(
  page: Page,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  data?: object,
) {
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
 * The AI database manager, wave C (design 2026-10-25): from one chat, with a stubbed provider — an
 * export on its card, a field's values counted, a collection copied and its copy renamed on a typed
 * card, two changes shown first as a plan and confirmed one by one, a drop backed up first from its
 * own card, a tool turned off on the connection refused, and a scheduled report made on a card and
 * shown on the Alerts page.
 */
test('the agent exports, copies, plans, backs up first and reports from one chat (wave C)', async ({
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
  await api(page, 'PATCH', `connections/${local}`, { aiAgentToolsOff: [] })
  for (const r of ((await api(page, 'GET', 'alerts/reports')).body ?? []) as Array<{ id: string }>)
    await api(page, 'DELETE', `alerts/reports/${r.id}`)
  await api(page, 'DELETE', `connections/${local}/databases/e2emgr`, { confirm: 'e2emgr' })
  await api(page, 'POST', `connections/${local}/databases/e2emgr/collections/items/documents`, {
    documents: [
      { n: 1, label: 'red' },
      { n: 2, label: 'blue' },
      { n: 3, label: 'red' },
    ],
  })

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
  const card = () => panel.locator('[data-agent-card]').last()
  const shot = async (name: string) => {
    if (process.env.MM_UI_REVIEW) await page.screenshot({ path: `test-results/ui-review/ai-c-${name}.png` })
  }

  // C1: the items exported on a card, said as what goes.
  await ask('export the e2emgr items as csv')
  await expect(card()).toContainText('Export documents')
  await expect(card()).toContainText('CSV')
  await shot('c1-export')
  await card().getByRole('button', { name: 'Confirm' }).click()
  await expect(panel.getByText('Exported.')).toBeVisible()

  // C2: a field's distinct values, counted.
  await ask('which labels do the e2emgr items have?')
  await expect(panel.getByText('Counted them.')).toBeVisible()
  await expect(steps.locator('[data-agent-step="distinct_values"]').last()).toBeVisible()

  // C3: the items copied, then the copy renamed on its typed card.
  await ask('copy the e2emgr items')
  await expect(card()).toContainText('A new collection is made.')
  await card().getByRole('button', { name: 'Confirm' }).click()
  await expect(panel.getByText('Copied.')).toBeVisible()
  await expect
    .poll(
      async () =>
        (
          (await api(page, 'GET', `connections/${local}/databases/e2emgr/collections`)).body as Array<{
            name: string
          }>
        ).map((c) => c.name),
      {
        timeout: 60_000,
      },
    )
    .toContain('itemscopy')
  await ask('rename the e2emgr copy')
  await card().locator('[data-agent-typed]').fill('itemscopy')
  await shot('c3-rename')
  await card().getByRole('button', { name: 'Confirm' }).click()
  await expect(panel.getByText('Renamed.')).toBeVisible()

  // C4: two changes shown first as a plan, each confirmed on its own card, in order.
  await ask('set up the e2emgr archive')
  const plan = steps.locator('[data-agent-plan]').last()
  await expect(plan).toContainText('A collection for the archive')
  await card().getByRole('button', { name: 'Confirm' }).click()
  await expect(plan.locator('[data-agent-plan-item="done"]')).toHaveCount(1)
  await shot('c4-plan')
  await card().getByRole('button', { name: 'Confirm' }).click()
  await expect(panel.getByText('Set up.')).toBeVisible()
  await expect(plan.locator('[data-agent-plan-item="done"]')).toHaveCount(2)

  // C4: a drop that loses data, backed up first from its own card.
  await ask('drop the e2emgr archive log')
  const backup = card().locator('[data-agent-backup]')
  await expect(backup).toContainText('Back up e2emgr.archivelog first')
  const [password, repeat] = await backup.locator('input[type="password"]').all()
  await password!.fill('correct horse battery staple 9')
  await repeat!.fill('correct horse battery staple 9')
  await backup.getByRole('button', { name: 'Back up first' }).click()
  await expect(backup.locator('[data-agent-backup-state]')).toContainText('Backed up.', { timeout: 120_000 })
  await shot('c4-backed-up')
  await card().locator('[data-agent-typed]').fill('archivelog')
  await card().getByRole('button', { name: 'Confirm' }).click()
  await expect(panel.getByText('Dropped.')).toBeVisible()
  await expect(steps.locator('[data-agent-step="drop_collection"]').last()).toContainText('Backed up first.')

  // User request 2026-10-26: a backup made without a password, chosen on its card, then downloaded
  // from its step once made.
  await ask('back up e2emgr and download it')
  const backingUp = card()
  await expect(backingUp).toContainText('Back up')
  await backingUp.locator('[data-agent-format]').getByText('Compressed archive').click()
  await expect(backingUp.locator('input[type="password"]')).toHaveCount(0)
  // The chosen one is the one shown chosen (its tint follows the radio).
  await expect(backingUp.locator('[data-agent-format] label', { hasText: 'Compressed archive' })).toHaveClass(
    /bg-accent-soft/,
  )
  await expect(
    backingUp.locator('[data-agent-format] label', { hasText: 'Encrypted backup' }),
  ).not.toHaveClass(/bg-accent-soft/)
  // A review screen after the tint's transition.
  if (process.env.MM_UI_REVIEW) await page.waitForTimeout(250)
  await shot('plain-backup-card')
  await backingUp.getByRole('button', { name: 'Confirm' }).click()
  await expect(panel.getByText('Backed up: download it from the step.')).toBeVisible()
  // The window itself never scrolls (its header stays): a control brought into view moves its log.
  expect(await panel.evaluate((el) => el.scrollTop)).toBe(0)
  const fileLink = steps.locator('[data-agent-step="run_backup"]').last().locator('[data-agent-download]')
  await expect(fileLink).toBeVisible({ timeout: 120_000 })
  await shot('plain-backup-download')
  const [file] = await Promise.all([page.waitForEvent('download'), fileLink.click()])
  expect(file.suggestedFilename()).toMatch(/^e2emgr.*\.archive\.gz$/)

  // C5: a tool turned off on the connection is refused before it reads anything.
  await api(page, 'PATCH', `connections/${local}`, { aiAgentToolsOff: ['distinct_values'] })
  await ask('which labels do the e2emgr items have?')
  await expect(steps.locator('[data-agent-step="distinct_values"]').last()).toContainText(
    'An administrator turned this tool off on this connection.',
  )
  await api(page, 'PATCH', `connections/${local}`, { aiAgentToolsOff: [] })

  // C7: a scheduled report made on a card, then shown on the Alerts page and run from it.
  await ask('report the e2emgr items every morning')
  await expect(card()).toContainText('It says 1 count.')
  await shot('c7-report-card')
  await card().getByRole('button', { name: 'Confirm' }).click()
  await expect(panel.getByText('Report made.')).toBeVisible()
  await page.goto('alerts')
  const reports = page.locator('[data-reports]')
  await expect(reports).toContainText('Morning items')
  await reports.locator('[data-report-run]').first().click()
  await expect(reports.locator('[data-report-last]').first()).toContainText('Items: 3')
  await shot('c7-reports')

  for (const r of ((await api(page, 'GET', 'alerts/reports')).body ?? []) as Array<{ id: string }>)
    await api(page, 'DELETE', `alerts/reports/${r.id}`)
  // The backup it made first goes too (its export's file expires as every export's does).
  for (const b of ((await api(page, 'GET', `backups?connectionId=${local}`)).body ?? []) as Array<{
    id: string
    name: string
  }>)
    if (b.name.startsWith('e2emgr')) await api(page, 'DELETE', `backups/${b.id}`)
  await api(page, 'DELETE', `connections/${local}/databases/e2emgr`, { confirm: 'e2emgr' })
  expect(cspViolations).toEqual([])
  expect(foreignRequests).toEqual([])
})
