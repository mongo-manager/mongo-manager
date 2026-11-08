// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { Page } from '@playwright/test'
import { expect, signIn, test } from '../fixtures'

async function csrf(page: Page): Promise<Record<string, string>> {
  const me = await (await page.request.get('api/auth/me')).json()
  return { 'x-csrf-token': me.csrfToken, origin: new URL(page.url()).origin }
}

// Whatever happened, the next spec starts from the default Overview.
test.afterEach(async ({ page }) => {
  await page.request.delete('api/me/dashboard', { headers: await csrf(page) })
})

/** Adds a widget from the gallery; a server widget is set to the e2e server first. */
async function add(
  page: Page,
  title: string,
  more?: (settings: ReturnType<Page['locator']>) => Promise<unknown>,
) {
  await page.getByRole('button', { name: 'Add widget' }).click()
  await page.getByRole('button', { name: `Add ${title}` }).click()
  const settings = page.locator('[data-widget-settings]')
  if (await settings.isVisible()) {
    await settings.getByLabel('Connection').selectOption({ label: 'Local test' })
    if (more) await more(settings)
    await settings.getByRole('button', { name: 'Add', exact: true }).click()
  }
}

// Widgets wave 2 (2026-10-27): each new kind added through the gallery answers on a real server.
test('the wave 2 widgets: each one added from the gallery shows its server', async ({ page }) => {
  await signIn(page)
  await expect(page.locator('[data-widget]').first()).toBeVisible()
  const connections = (await (await page.request.get('api/connections')).json()) as Array<{
    id: string
    name: string
  }>
  const id = connections.find((c) => c.name === 'Local test')!.id
  // The data KPI counts a collection of its own: shop.orders is emptied by an earlier spec of the full run.
  const kpi = `api/connections/${id}/databases/shop/collections/kpi_orders`
  await page.request.delete(kpi, { headers: await csrf(page), data: { confirm: 'kpi_orders' } })
  const seeded = await page.request.post(`${kpi}/documents`, {
    headers: await csrf(page),
    data: { documents: [{ n: 1 }, { n: 2 }, { n: 3 }] },
  })
  expect(seeded.ok()).toBe(true)
  const saved = await page.request.post(`${kpi}/pipelines`, {
    headers: await csrf(page),
    data: { name: 'Orders counted', stages: [{ $count: 'orders' }], shared: false },
  })
  expect(saved.ok()).toBe(true)
  const pipelineId = ((await saved.json()) as { id: string }).id

  try {
    await page.getByRole('button', { name: 'Customize dashboard' }).click()
    await add(page, 'Slow queries')
    await add(page, 'Collection latency')
    await add(page, 'Server facts')
    await add(page, 'Replication headroom')
    await add(page, 'Shard balance')
    await add(page, 'Index health', (s) => s.getByLabel('Database').selectOption('shop'))
    await add(page, 'Alerts')
    await add(page, 'Metric chart', (s) => s.getByLabel('Metric').selectOption({ label: 'Query targeting' }))
    await add(page, 'Data KPI', async (s) => {
      await s.getByLabel('Database').selectOption('shop')
      await s.getByLabel('Collection').selectOption('kpi_orders')
      await s.getByLabel('Saved pipeline').selectOption({ label: 'Orders counted' })
    })
    await page.getByRole('button', { name: 'Done', exact: true }).click()

    const widget = (type: string) => page.locator(`[data-widget="${type}"]`)
    await expect(widget('slowQueries')).toContainText(/No slow operation|ms/)
    await expect(widget('collectionLatency')).toContainText(/Collection|No collection/)
    // The facts never name the host: only the version, engine and size of the machine.
    await expect(widget('serverFacts')).toContainText(/Version\s*\d+\.\d+/)
    await expect(widget('serverFacts')).toContainText('wiredTiger')
    await expect(widget('serverFacts')).not.toContainText('127.0.0.1')
    await expect(widget('replication')).toContainText('not part of a replica set')
    await expect(widget('shardBalance')).toContainText('not a sharded cluster')
    await expect(widget('indexHealth')).toContainText('Database shop')
    await expect(widget('indexHealth').locator('[data-index-count="missing"]')).toHaveText(/\d+/)
    await expect(widget('alerts')).toContainText(/alert|Alerts/)
    await expect(widget('metric')).toContainText('Query targeting')
    await expect(widget('dataKpi')).toContainText('Orders counted')
    await expect(widget('dataKpi').locator('[data-kpi-value]')).toHaveText(/^\d[\d,]*$/)

    // Once on the Overview: the server's slow queries widget is not offered again. The full run has
    // other connections by now, and the widget is still offered for them only.
    await page.getByRole('button', { name: 'Customize dashboard' }).click()
    await page.getByRole('button', { name: 'Add widget' }).click()
    const tile = page.locator('[data-gallery="slowQueries"]')
    await expect(tile).toBeVisible()
    const again = tile.getByRole('button', { name: 'Add Slow queries' })
    if (await again.isVisible()) {
      await again.click()
      const settings = page.locator('[data-widget-settings]')
      await expect(settings.getByLabel('Connection')).toBeVisible()
      await expect(
        settings.getByLabel('Connection').locator('option', { hasText: 'Local test' }),
      ).toHaveCount(0)
    } else await expect(tile).toContainText('On every server')
    for (let i = 0; i < 3 && (await page.getByRole('dialog').count()) > 0; i++)
      await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Done', exact: true }).click()
  } finally {
    await page.request.delete(`${kpi}/pipelines/${pipelineId}`, { headers: await csrf(page) })
    await page.request.delete(kpi, { headers: await csrf(page), data: { confirm: 'kpi_orders' } })
  }
})
