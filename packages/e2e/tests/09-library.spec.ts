// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { expect, signIn, test, watchCsp } from '../fixtures'

test('saves a favourite, finds it in the Library and opens it; aggregations land in the history (phase 2c)', async ({
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

  // shop.big holds n = 0…4999 (spec 05). Run a query, then keep it as a favourite tagged e2e.
  await page.goto(`c/${id}/db/shop/coll/big`)
  const filter = page.getByRole('textbox', { name: 'Filter', exact: true })
  await filter.fill('{ n: { $gte: 4990 } }')
  await filter.press('Enter')
  await page.getByRole('button', { name: 'Save as favourite' }).click()
  const save = page.getByRole('dialog', { name: 'Save as favourite' })
  await save.getByLabel('Name').fill('Last ten')
  await save.getByLabel('Tags').fill('e2e')
  await save.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText('Saved "Last ten" as a favourite.')).toBeVisible()

  // An aggregation run is kept in the history.
  await page.getByRole('tab', { name: 'Aggregations' }).click()
  await page.getByRole('button', { name: 'Add stage' }).click()
  await page.getByRole('combobox', { name: 'Find a stage' }).fill('limit')
  await page.locator('[role="option"][data-operator="$limit"]').click()
  await page.locator('[data-stage]').first().locator('textarea').fill('7')
  await page.getByRole('button', { name: 'Run', exact: true }).click()
  await expect(page.locator('[data-results]')).toContainText('7 documents')

  // From another collection's tab, the Queries page (user request 2026-10-10: a page, no longer a
  // side panel) finds the favourite by tag and by text.
  await page.goto(`c/${id}/db/shop/coll/orders`)
  // The shortcut is the workspace's: pressed once the collection's page is there.
  await expect(page.getByRole('tablist', { name: 'Collection sections' })).toBeVisible()
  await page.keyboard.press('Control+Shift+L')
  const panel = page.locator('[data-library-page]')
  await expect(panel).toBeVisible()
  await expect(page).toHaveURL(/\/library$/)
  await panel.locator('[data-tag="e2e"]').click()
  await expect(panel.locator('[data-library-item]')).toHaveCount(1)
  await expect(panel.locator('[data-library-item]')).toContainText('Last ten')
  await panel.locator('[data-tag="e2e"]').click()
  await panel.getByRole('searchbox').fill('last ten')
  const favourite = panel.locator('[data-library-item][data-type="favourite"]', { hasText: 'Last ten' })
  await expect(favourite).toHaveCount(1)
  await favourite.locator('[data-action="open"]').click()
  await expect(page).toHaveURL(/\/db\/shop\/coll\/big/)
  await expect(page.getByRole('textbox', { name: 'Filter', exact: true })).toHaveValue(
    '{ n: { $gte: 4990 } }',
  )

  // Work in progress in the Aggregations cards (the reload above cleared the earlier ones).
  await page.getByRole('tab', { name: 'Aggregations' }).click()
  await page.getByRole('button', { name: 'Add stage' }).click()
  await page.getByRole('combobox', { name: 'Find a stage' }).fill('match')
  await page.locator('[role="option"][data-operator="$match"]').click()
  await expect(page.locator('[data-stage]')).toHaveCount(1)

  // The history lists the aggregation; opening it asks before replacing the cards, then shows its stage.
  await page.keyboard.press('Control+Shift+L')
  await expect(panel).toBeVisible()
  await panel.getByRole('searchbox').fill('$limit')
  await panel.getByRole('radio', { name: 'History' }).click()
  const run = panel.locator('[data-library-item][data-type="history"]', { hasText: '$limit' }).first()
  await expect(run).toContainText('Aggregation')
  await expect(run).toContainText('shop.big')
  await run.locator('[data-action="open"]').click()
  await page
    .getByRole('dialog', { name: 'Replace the stages?' })
    .getByRole('button', { name: 'Replace' })
    .click()
  await expect(page.getByRole('tab', { name: 'Aggregations' })).toHaveAttribute('aria-selected', 'true')
  const stage = page.locator('[data-stage]')
  await expect(stage).toHaveCount(1)
  await expect(stage.getByRole('combobox', { name: 'Operator' })).toHaveValue('$limit')
  await expect(stage.locator('textarea')).toHaveValue('7')

  expect(violations).toEqual([])
})
