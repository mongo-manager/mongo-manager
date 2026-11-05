// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { expect, signIn, test, watchCsp } from '../fixtures'

test('the Performance tab charts the server live, and a collection is analysed and exported (phase 1i)', async ({
  page,
}) => {
  const violations: string[] = []
  watchCsp(page, violations)
  await signIn(page)
  await expect(page.getByRole('button', { name: /^Account menu/ })).toBeVisible()
  const connections = (await (await page.request.get('api/connections')).json()) as Array<{
    id: string
    name: string
  }>
  const id = connections.find((c) => c.name === 'Local test')!.id

  // Performance: samples arrive over the real-time channel and draw lines.
  await page.goto(`c/${id}`)
  await page.getByRole('tab', { name: 'Performance' }).click()
  // Samples arrive over the real-time channel: ECharts draws them on a canvas, and the chart's
  // accessible name carries the latest values.
  const ops = page.getByRole('img', { name: /^Operations per second: insert / })
  await expect(ops).toBeVisible({ timeout: 15_000 })
  await expect(ops.locator('canvas')).toHaveCount(1)
  // User report 2026-10-16: the tooltip of a chart of six series was cut in half by the chart. The
  // app draws it above the page now: whole, every series named, inside the window.
  const box = (await ops.boundingBox())!
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6)
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.7)
  const tip = page.locator('[data-chart-tip]')
  await expect(tip).toBeVisible()
  for (const name of ['insert', 'query', 'update', 'delete', 'getmore', 'command'])
    await expect(tip).toContainText(name)
  const shown = (await tip.boundingBox())!
  const view = page.viewportSize()!
  expect(shown.x).toBeGreaterThanOrEqual(0)
  expect(shown.y).toBeGreaterThanOrEqual(0)
  expect(shown.x + shown.width).toBeLessThanOrEqual(view.width)
  expect(shown.y + shown.height).toBeLessThanOrEqual(view.height)
  await page.mouse.move(0, 0)
  await expect(tip).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Slowest operations' })).toBeVisible()
  // The e2e server is a standalone: the Replica set section says so (phase 1j).
  await expect(page.getByText('This server is not a replica set.')).toBeVisible()
  await expect(page.getByText('Hottest collections')).toBeVisible()

  // Schema: analyse shop.big (04 emptied shop.orders; 05 filled shop.big) and export it as Mongoose.
  await page.goto(`c/${id}/db/shop/coll/big`)
  await page.getByRole('tab', { name: 'Schema' }).click()
  await page.getByRole('button', { name: 'Analyse' }).click()
  await expect(page.locator('[data-field="n"]')).toContainText('100%')
  await expect(page.locator('[data-field="pad"]')).toContainText('string')
  await page.getByRole('tabpanel').getByRole('button', { name: 'Export', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Export the schema' })
  await expect(dialog.locator('pre')).toContainText('new Schema(')
  await dialog.getByRole('button', { name: 'Close' }).click()

  // Overview: the charts render.
  await page.getByRole('tab', { name: 'Overview' }).click()
  await expect(page.locator('figcaption', { hasText: 'Data and indexes' })).toBeVisible()
  await expect(page.locator('figcaption', { hasText: 'Size of each index' })).toBeVisible()

  expect(violations).toEqual([])
})
