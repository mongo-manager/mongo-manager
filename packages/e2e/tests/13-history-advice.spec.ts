// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { type Page } from '@playwright/test'
import { expect, signIn, test } from '../fixtures'

/**
 * Phase 3b-2: a connection admin records metric history and reads it back; a slow scan becomes an
 * index suggestion whose "Create index" opens the usual dialog with the key filled in. (Sharding has
 * no end-to-end test: the test binaries hold no mongos.)
 */
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

async function setProfiler(page: Page, level: string, slowms: string): Promise<void> {
  await page.locator('[data-profiler-edit="shop"]').click()
  await page.getByRole('dialog').getByRole('radio', { name: LEVELS[level] }).click()
  await page.locator('[data-profiler-form]').getByLabel('slowms').fill(slowms)
  await page.locator('[data-profiler-save]').click()
  await expect(page.getByText('Profiler of shop changed').first()).toBeVisible()
}

test('metric history is recorded and read back; a slow scan becomes a prefilled index (phase 3b-2)', async ({
  page,
}) => {
  await signIn(page)
  await expect(page.getByRole('button', { name: /^Account menu/ })).toBeVisible()
  const id = await connectionId(page)
  await openPerformance(page, id)

  // History: switched on, sampled at once, readable as the 1-hour range.
  // UI redesign R3: recording is switched in the header's Metric history menu.
  await page.getByRole('button', { name: 'Metric history' }).click()
  await page.getByRole('menuitem', { name: /^Record metric history/ }).click()
  await expect(page.getByText('Metric history is being recorded')).toBeVisible()
  await expect
    .poll(async () => {
      const res = await page.request.get(`api/connections/${id}/server/history?range=1h`)
      return ((await res.json()) as { points: unknown[] }).points.length
    })
    .toBeGreaterThan(0)
  await page.getByRole('radiogroup', { name: 'Time span' }).getByRole('radio', { name: '1 hour' }).click()
  await expect(page.getByRole('img', { name: /^Connections: / })).toBeVisible()

  // A scan on a field without an index, profiled.
  await setProfiler(page, '1', '0')
  const count = await page.request.post(`api/connections/${id}/databases/shop/collections/big/count`, {
    data: { filter: { e2eAdvice: { $gt: 5 } } },
    headers: { 'x-csrf-token': await csrf(page) },
  })
  expect(count.ok()).toBe(true)

  // Index suggestions: the scan's field, and a create dialog with the key filled in.
  const advice = page.locator('[data-index-advice]')
  await advice.locator('[data-advice-db]').fill('shop')
  await advice.getByRole('button', { name: 'Analyse' }).click()
  await expect(advice.getByText('{ e2eAdvice: 1 }')).toBeVisible({ timeout: 15_000 })
  await advice.locator('[data-advice-create]').first().click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('textarea, input').first()).toHaveValue(/e2eAdvice/)
  await dialog.getByRole('button', { name: 'Cancel' }).click()

  // Back as it was: the profiler off, history not recorded.
  await setProfiler(page, '0', '100')
  await page.getByRole('button', { name: 'Metric history' }).click()
  await page.getByRole('menuitem', { name: 'Stop recording history' }).click()
  await expect(page.getByText('Metric history is no longer recorded')).toBeVisible()
})
