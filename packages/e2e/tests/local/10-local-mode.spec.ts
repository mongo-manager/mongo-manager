import { expect, test } from '../../fixtures'

// Local mode (spec §9 e2e): one user, no accounts, no sign-in; the same query flow works.
test('local mode opens straight into the workspace, adds a connection and queries', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByText('Local mode')).toBeVisible()
  await expect(page.getByRole('heading', { name: /Sign in|Welcome to Mongo Manager/ })).toHaveCount(0)

  await page.getByRole('button', { name: 'Add connection' }).click()
  // User report 2026-10-16: the connection string is the form's first field and fills it by itself.
  await page.getByLabel('Connection string').fill(process.env.MM_E2E_MONGO_URI!)
  await page.getByLabel('Connection string').press('Enter')
  await expect(page.locator('[data-uri-status]')).toContainText('Read:')
  await page.getByLabel('Name', { exact: true }).fill('Local only')
  await page.getByLabel('Name', { exact: true }).press('Enter')
  await expect(page.getByText('Connection saved.')).toBeVisible()

  await page.getByRole('button', { name: 'New database' }).click()
  await page.getByLabel('Database name').fill('solo')
  await page.getByLabel('First collection').fill('notes')
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await page.getByRole('button', { name: 'notes', exact: true }).click()
  await page.getByRole('button', { name: 'Add documents' }).first().click()
  await page.getByRole('textbox', { name: 'Document', exact: true }).fill("{ text: 'hello' }")
  await page.getByRole('button', { name: 'Insert', exact: true }).click()
  await expect(page.locator('tbody')).toContainText('hello')

  // No accounts in local mode: no users screen, only the owner's own settings.
  await page.getByRole('button', { name: /^Account menu/ }).click()
  await expect(page.getByRole('menuitem', { name: 'Users' })).toHaveCount(0)
})
