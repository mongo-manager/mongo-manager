import type { Page } from '@playwright/test'
import { expect, signIn, test } from '../fixtures'

/** The dashboard saved on the server: a PUT of it answered. */
const saved = (page: Page) =>
  page.waitForResponse(
    (r) => r.request().method() === 'PUT' && r.url().endsWith('/api/me/dashboard') && r.ok(),
  )

// Whatever happened, the next spec starts from the default Overview.
test.afterEach(async ({ page }) => {
  const me = await (await page.request.get('api/auth/me')).json()
  await page.request.delete('api/me/dashboard', {
    headers: { 'x-csrf-token': me.csrfToken, origin: new URL(page.url()).origin },
  })
})

// Overview widgets (spec 2026-10-09): the dashboard is the user's own — a MongoDB widget is added
// with its server chosen first, moved by keyboard, removed and brought back, kept across a reload,
// and the default comes back on request.
test('the Overview dashboard: add, move, remove and undo, kept after a reload, then reset', async ({
  page,
}) => {
  await signIn(page)
  const widgets = page.locator('[data-widget]')
  const types = () => widgets.evaluateAll((all) => all.map((w) => w.getAttribute('data-widget')))
  await expect(widgets.first()).toBeVisible()
  const before = await types()
  expect(before).not.toContain('serverStatus')

  await page.getByRole('button', { name: 'Customize dashboard' }).click()
  await page.getByRole('button', { name: 'Add widget' }).click()
  await page.getByRole('button', { name: 'Add Server status' }).click()
  // A server widget asks which server before it is added.
  const settings = page.locator('[data-widget-settings]')
  await settings.getByLabel('Connection').selectOption({ label: 'Local test' })
  await settings.getByRole('button', { name: 'Add', exact: true }).click()
  const status = page.locator('[data-widget="serverStatus"]')
  await expect(status).toBeVisible()
  await expect(status).toContainText(/MongoDB \d/)
  expect(await types()).toEqual([...before, 'serverStatus'])

  // Picked up with Space, moved one place back with an arrow key, dropped with Space.
  await status.locator('[data-widget-handle]').focus()
  await page.keyboard.press('Space')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('Space')
  const moved = [...before.slice(0, -1), 'serverStatus', before.at(-1)!]
  await expect.poll(types).toEqual(moved)

  // Removed from its menu, then brought back with Undo.
  await status.getByRole('button', { name: /^Server status.* options$/ }).click()
  await page.getByRole('menuitem', { name: 'Remove' }).click()
  await expect(status).toHaveCount(0)
  await page.getByRole('button', { name: 'Undo' }).click()
  await expect.poll(types).toEqual(moved)
  // Done saves what is waiting at once.
  const stored = saved(page)
  await page.getByRole('button', { name: 'Done', exact: true }).click()
  expect(
    (
      (await (await stored).json()) as { dashboard: { widgets: Array<{ type: string }> } }
    ).dashboard.widgets.map((w) => w.type),
  ).toEqual(moved)

  // Saved: the same dashboard after a reload.
  await page.reload()
  await expect(page.locator('[data-widget="serverStatus"]')).toContainText(/MongoDB \d/)
  await expect.poll(types).toEqual(moved)

  // And the default Overview back, after asking.
  await page.getByRole('button', { name: 'Customize dashboard' }).click()
  await page.getByRole('button', { name: 'Reset to default' }).click()
  const reset = page.waitForResponse(
    (r) => r.request().method() === 'DELETE' && r.url().endsWith('/api/me/dashboard') && r.ok(),
  )
  await page.getByRole('button', { name: 'Reset', exact: true }).click()
  await reset
  await expect.poll(types).toEqual(before)
  await page.getByRole('button', { name: 'Done', exact: true }).click()
  await page.reload()
  await expect(widgets.first()).toBeVisible()
  await expect.poll(types).toEqual(before)
})
