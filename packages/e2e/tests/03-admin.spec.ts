import { ADMIN, expect, signIn, test, watchCsp, watchOrigins, openFromSidebar } from '../fixtures'

const VIEWER = { username: 'viewer1', password: 'viewer-password-1' }

test('users, connection access and the audit log', async ({
  page,
  browser,
  baseURL,
  cspViolations,
  foreignRequests,
}) => {
  await signIn(page)
  await page.getByRole('button', { name: /^Account menu/ }).click()
  await page.getByRole('menuitem', { name: 'Users' }).click()
  await page.getByRole('button', { name: 'Add user' }).click()
  await page.getByLabel('Username').fill(VIEWER.username)
  await page.getByLabel('Password', { exact: true }).fill(VIEWER.password)
  await page.getByLabel('Role').selectOption('viewer')
  // Security audit 2026-10-16: a new account is confirmed with the administrator's own password.
  await page.getByRole('dialog').getByLabel('Your password').fill(ADMIN.password)
  await page.getByRole('dialog').getByRole('button', { name: 'Add user' }).click()
  await expect(page.getByText(`User ${VIEWER.username} added.`)).toBeVisible()

  await page.locator('[data-test="connection"]', { hasText: 'Local test' }).click()
  await page.getByLabel(`Access of ${VIEWER.username}`).selectOption('none')
  await expect(page.getByText(`Access of ${VIEWER.username} updated.`)).toBeVisible()

  const other = await browser.newContext({ locale: 'en-US' })
  const viewerPage = await other.newPage()
  watchCsp(viewerPage, cspViolations)
  watchOrigins(viewerPage, new URL(baseURL!).origin, foreignRequests)
  await signIn(viewerPage, VIEWER)
  await expect(viewerPage.getByText('No connections yet.')).toBeVisible()
  await other.close()

  await openFromSidebar(page, 'Activity', 'Audit log')
  // Audit action labels (2026-10-28): the actions in words.
  await expect(page.getByText('Change a user’s access to a connection').first()).toBeVisible()
  await expect(page.getByText('Add a user', { exact: true }).first()).toBeVisible()
})
