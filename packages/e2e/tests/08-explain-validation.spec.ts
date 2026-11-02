import { expect, signIn, test, watchCsp } from '../fixtures'

test('explains a slow query, creates the suggested index, and sets validation rules (phase 2b)', async ({
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

  // shop.big: documents {n, pad} (spec 05); pad is not indexed.
  await page.goto(`c/${id}/db/shop/coll/big`)
  const filter = page.getByRole('textbox', { name: 'Filter', exact: true })
  await filter.fill("{ pad: 'y' }")
  await filter.press('Enter')
  await page.getByRole('button', { name: 'Why is it slow?' }).click()
  await expect(page.getByRole('tab', { name: 'Explain' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('[data-explain-warnings]')).toContainText('Scans the whole collection')
  const tree = page.getByRole('tree', { name: 'Winning plan' })
  // The Documents query carries its page size: LIMIT over the scan.
  await expect(tree.locator('[data-stage="COLLSCAN"]')).toHaveAttribute('data-mark', 'COLLSCAN')
  await expect(page.locator('[data-suggestion]')).toContainText('{ pad: 1 }')

  await page.getByRole('button', { name: 'Create this index' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  // The build runs as a job; explain again until the planner uses the new index.
  await expect(async () => {
    await page.getByRole('button', { name: 'Explain', exact: true }).click()
    await expect(page.locator('[role="tree"] [data-stage="IXSCAN"]').first()).toBeVisible({ timeout: 2_000 })
  }).toPass({ timeout: 30_000 })
  await expect(page.locator('[data-suggestion]')).toHaveCount(0)

  // Validation: every document needs a number n. The existing ones all have it.
  await page.getByRole('tab', { name: 'Validation' }).click()
  await page
    .getByRole('textbox', { name: 'Rules', exact: true })
    .fill("{ $jsonSchema: { required: ['n'], properties: { n: { bsonType: 'number' } } } }")
  await page.getByRole('button', { name: 'Test against existing documents' }).click()
  await expect(page.locator('[data-validation-test]')).toContainText(/0 of [0-9,]+ documents would fail/)
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText('The rules were saved.')).toBeVisible()

  // An insert without n is refused by MongoDB.
  await page.getByRole('tab', { name: 'Documents' }).click()
  await page.getByRole('button', { name: 'Add documents' }).first().click()
  await page.getByRole('textbox', { name: 'Document', exact: true }).fill('[{ x: 1 }]')
  await page.getByRole('button', { name: 'Insert', exact: true }).click()
  // 2026-10-28: the refusal names the rule it did not meet.
  await expect(
    page.getByText("The document does not pass the collection's validation: n is required."),
  ).toBeVisible()
  // UI redesign R1: inserts open in the inspector beside the results.
  await page
    .getByRole('complementary', { name: 'Add documents' })
    .getByRole('button', { name: 'Cancel', exact: true })
    .click()
  // The editor holds unsaved text: it asks before throwing it away.
  await page
    .getByRole('dialog', { name: 'Discard your changes?' })
    .getByRole('button', { name: 'Discard' })
    .click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.locator('[data-inspector]')).toHaveCount(0)

  // Put the collection back as it was for the specs after this one.
  await page.getByRole('tab', { name: 'Validation' }).click()
  await page.getByRole('button', { name: 'Restore the previous rules' }).click()
  await expect(page.getByText('The previous rules are back.')).toBeVisible()

  expect(violations).toEqual([])
})
