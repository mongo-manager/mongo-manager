// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { MongoClient } from 'mongodb'
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

// Review 2026-11-07: a stage of 17 lines scrolled in a box of four rows; a box made taller by its
// handle snapped back on the next key; the suggestions opened under the whole editor, cut off by the
// card.
test('grows a long stage’s editor, keeps a resize while typing, and opens suggestions at the caret', async ({
  page,
}) => {
  // A collection of its own: this one does not wait for spec 05's.
  const client = new MongoClient(process.env.MM_E2E_MONGO_URI!)
  try {
    await client.db('aggsize').dropDatabase()
    await client
      .db('aggsize')
      .collection('readings')
      .insertMany(Array.from({ length: 20 }, (_, n) => ({ n, sensor: `s-${n % 4}`, value: n * 1.5 })))
  } finally {
    await client.close()
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  await signIn(page)
  await expect(page.getByRole('button', { name: /^Account menu/ })).toBeVisible()
  const connections = (await (await page.request.get('api/connections')).json()) as Array<{
    id: string
    name: string
  }>
  await page.goto(`c/${connections.find((c) => c.name === 'Local test')!.id}/db/aggsize/coll/readings`)
  await page.getByRole('tab', { name: 'Aggregations' }).click()
  await page.getByRole('button', { name: 'Add stage' }).click()
  await page.getByRole('combobox', { name: 'Find a stage' }).fill('match')
  await page.locator('[role="option"][data-operator="$match"]').click()
  const card = page.locator('[data-stage]').first()
  const field = card.locator('textarea')
  const lines = Array.from({ length: 13 }, (_, i) => `    { n: { $gte: ${i} } },`)
  await field.fill(['{', '  $and: [', ...lines, '  ]', '}'].join('\n'))
  const box = card.locator('[data-code-scroller]')
  // All 17 lines in sight: the box is as tall as its text.
  await expect.poll(async () => (await box.boundingBox())!.height).toBeGreaterThanOrEqual(17 * 20)
  expect(await box.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1)

  const grown = (await box.boundingBox())!
  await page.mouse.move(grown.x + grown.width - 3, grown.y + grown.height - 3)
  await page.mouse.down()
  await page.mouse.move(grown.x + grown.width - 3, grown.y + grown.height + 120, { steps: 8 })
  await page.mouse.up()
  const dragged = (await box.boundingBox())!.height
  expect(dragged).toBeGreaterThan(grown.height + 100)
  await field.click({ position: { x: 60, y: 10 } })
  await page.keyboard.press('End')
  await page.keyboard.type(' ')
  await page.keyboard.press('ArrowLeft')
  await expect(field).toHaveValue(/^\{ \n/)
  expect((await box.boundingBox())!.height).toBeCloseTo(dragged, 0)

  // Where a key goes on the second line: the list opens under it, whole, and each item can be chosen.
  await page.keyboard.press('Control+Home')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Home')
  await page.keyboard.press('Control+Space')
  const list = page.getByRole('listbox', { name: 'Suggestions' })
  await expect(list).toBeInViewport({ ratio: 1 })
  const at = (await list.boundingBox())!
  expect(at.y).toBeGreaterThan(grown.y + 20)
  expect(at.y).toBeLessThan(grown.y + 80)
  const fifth = list.getByRole('option').nth(4)
  const chosen = (await fifth.locator('span').first().textContent())!.trim()
  await fifth.click()
  await expect(list).toHaveCount(0)
  expect(await field.inputValue()).toContain(chosen)
})
