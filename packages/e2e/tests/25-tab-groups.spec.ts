import { type Page } from '@playwright/test'
import { expect, signIn, test } from '../fixtures'

/**
 * User request 2026-10-12: the collection tabs of a database are gathered into one tab of the
 * database while the user is elsewhere, and shown again when they come back — in a real browser,
 * across a reload.
 */
async function connectionId(page: Page): Promise<string> {
  const list = (await (await page.request.get('api/connections')).json()) as Array<{
    id: string
    name: string
  }>
  return list.find((c) => c.name === 'Local test')!.id
}

test('a database’s collection tabs gather into one tab while the user is elsewhere, and open again', async ({
  page,
}) => {
  await signIn(page)
  await expect(page.getByRole('button', { name: /^Account menu/ })).toBeVisible()
  const id = await connectionId(page)
  const strip = page.locator('[data-region="tabs"]')
  for (const coll of ['big', 'tg_a', 'tg_b']) {
    await page.goto(`c/${id}/db/shop/coll/${coll}`)
    await expect(strip.getByRole('tab', { name: `shop.${coll}` })).toHaveAttribute('aria-selected', 'true', {
      timeout: 20_000,
    })
  }

  // Another database: shop's three tabs stand as one, named with it and how many there are.
  await page.goto(`c/${id}/db/tgother/coll/events`)
  const group = strip.locator('[data-group]')
  await expect(group).toHaveAccessibleName('shop on Local test, 3 tabs', { timeout: 20_000 })
  await expect(group).toHaveAttribute('aria-expanded', 'false')
  await expect(strip.getByRole('tab', { name: 'shop.big' })).toHaveCount(0)

  // Pointed at, a tooltip names its tabs (user request 2026-10-13).
  await group.hover()
  const tip = page.locator('[data-group-tooltip]')
  await expect(tip).toContainText('Local test · shop: 3 tabs')
  await expect(tip.locator('li')).toHaveText(['big', 'tg_a', 'tg_b'])

  // Opened, its tabs show again, on the database itself (and in the address): user request 2026-10-13.
  await group.click()
  await expect(tip).toHaveCount(0)
  const database = strip.locator('[data-id^="database:"]')
  await expect(database).toHaveAttribute('aria-selected', 'true')
  await expect(page).toHaveURL(/\/db\/shop$/)
  await expect(strip.getByRole('tab', { name: 'shop.big' })).toBeVisible()

  // Left again, gathered again — and so after a reload.
  await strip.getByRole('tab', { name: 'tgother.events' }).click()
  await expect(group).toBeVisible()
  // The tooltip of the chip clicked never comes back over nothing (review 2026-10-13, I1).
  await page.mouse.move(0, 400)
  await page.waitForTimeout(500)
  await expect(tip).toHaveCount(0)
  await page.reload()
  await expect(strip.locator('[data-group]')).toBeVisible({ timeout: 20_000 })

  // Opening one of its collections from the address shows the others too.
  await page.goto(`c/${id}/db/shop/coll/tg_a`)
  await expect(strip.getByRole('tab', { name: 'shop.tg_a' })).toHaveAttribute('aria-selected', 'true', {
    timeout: 20_000,
  })
  await expect(strip.getByRole('tab', { name: 'shop.tg_b' })).toBeVisible()

  // From the keyboard: the arrows stop on the group without opening it, Enter opens it.
  const events = strip.getByRole('tab', { name: 'tgother.events' })
  await events.click()
  await expect(group).toBeVisible()
  await events.focus()
  await page.keyboard.press('ArrowLeft')
  await expect(group).toBeFocused()
  await expect(events).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Enter')
  await expect(database).toBeFocused()

  // Delete on the group closes all of its tabs; Undo brings them back.
  await events.click()
  await events.focus()
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('Delete')
  await expect(strip.getByRole('tab', { name: /^shop\./ })).toHaveCount(0)
  await expect(strip.locator('[data-group]')).toHaveCount(0)
  await page.getByRole('button', { name: 'Undo' }).click()
  await expect(strip.locator('[data-group]')).toBeVisible()
  // The database's own tab, opened by the group, is one of its tabs now.
  await expect(group).toHaveAccessibleName('shop on Local test, 4 tabs')
})
