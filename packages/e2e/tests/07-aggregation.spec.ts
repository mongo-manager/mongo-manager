// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { expect, signIn, test, watchCsp } from '../fixtures'

test('builds a pipeline with previews, runs it, saves, reopens and exports it (phase 2a)', async ({
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

  // shop.big holds n = 0…4999 (spec 05).
  await page.goto(`c/${id}/db/shop/coll/big`)
  await page.getByRole('tab', { name: 'Aggregations' }).click()

  async function addStage(operator: string, value: string) {
    await page.getByRole('button', { name: 'Add stage' }).click()
    await page.getByRole('combobox', { name: 'Find a stage' }).fill(operator.slice(1))
    await page.locator(`[role="option"][data-operator="${operator}"]`).click()
    // A fixed index: last() would move on to the next card added.
    const card = page.locator('[data-stage]').nth((await page.locator('[data-stage]').count()) - 1)
    await card.locator('textarea').fill(value)
    return card
  }
  const match = await addStage('$match', '{ n: { $lt: 5 } }')
  const group = await addStage('$group', '{ _id: null, c: { $sum: 1 } }')
  // Previews run on the first 1000 documents: n 0…4 pass the $match.
  await expect(match.locator('[data-preview]')).toContainText('5 documents')
  await expect(group.locator('[data-preview]')).toContainText('1 document')

  await page.getByRole('button', { name: 'Run', exact: true }).click()
  const results = page.locator('[data-results]')
  await expect(results).toContainText('1 document')
  // Each row's code renders once it is on screen (LazyCodeView).
  await results.locator('li').scrollIntoViewIfNeeded()
  await expect(results.locator('li')).toContainText('"c": 5')

  // Save as "p1", then reopen it after a reload (the builder's state lives in the page).
  await page.getByRole('button', { name: 'Save as…' }).click()
  const prompt = page.getByRole('dialog', { name: 'Save the pipeline' })
  await prompt.getByLabel('Name').fill('p1')
  await prompt.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText('Saved "p1".')).toBeVisible()
  await page.reload()
  await page.getByRole('tab', { name: 'Aggregations' }).click()
  await expect(page.locator('[data-stage]')).toHaveCount(0)
  await page.getByRole('button', { name: 'Pipelines' }).click()
  const saved = page.locator('[data-pipeline]', { hasText: 'p1' })
  await saved.getByRole('button', { name: 'Open' }).click()
  await expect(page.locator('[data-stage]')).toHaveCount(2)

  // Export to Python: the connection string is read from the environment, never written.
  await page.getByRole('button', { name: 'Export…' }).click()
  const exporter = page.getByRole('dialog', { name: 'Export to a driver' })
  await exporter.getByRole('tab', { name: 'Python' }).click()
  await expect(exporter.locator('[data-export-code]')).toContainText('os.environ["MONGODB_URI"]')
  await expect(exporter.locator('[data-export-code]')).toContainText('"$sum": 1')
  await exporter.getByRole('button', { name: 'Close' }).click()

  expect(violations).toEqual([])
})
