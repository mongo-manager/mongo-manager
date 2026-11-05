// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { Page } from '@playwright/test'
import { MongoClient, ObjectId } from 'mongodb'
import { readFileSync } from 'node:fs'
import { expect, signIn, test } from '../fixtures'

/**
 * completion W6 (1, 2, 4), end to end in Chrome: split view, the Overview's next steps (without
 * AI) and a database's data model, on the test MongoDB.
 */
const DB = 'w6b'

async function seed(): Promise<void> {
  const client = new MongoClient(process.env.MM_E2E_MONGO_URI!)
  try {
    const db = client.db(DB)
    await db.dropDatabase()
    const users = [new ObjectId(), new ObjectId(), new ObjectId()]
    await db.collection('users').insertMany(users.map((_id, i) => ({ _id, name: `user ${i}` })))
    await db
      .collection('orders')
      .insertMany(
        Array.from({ length: 12 }, (_, i) => ({ userId: users[i % 3], total: i, items: [{ sku: `s${i}` }] })),
      )
    await db.createCollection('bigOrders', {
      viewOn: 'orders',
      pipeline: [{ $match: { total: { $gt: 5 } } }],
    })
  } finally {
    await client.close()
  }
}

async function connectionId(page: Page): Promise<string> {
  const list = (await (await page.request.get('api/connections')).json()) as Array<{
    id: string
    name: string
  }>
  return list.find((c) => c.name === 'Local test')!.id
}

test.beforeAll(seed)
// Whatever happened, the next spec starts from the default Overview (dismissals live in it).
test.afterEach(async ({ page }) => {
  const me = await (await page.request.get('api/auth/me')).json()
  await page.request.delete('api/me/dashboard', {
    headers: { 'x-csrf-token': me.csrfToken, origin: new URL(page.url()).origin },
  })
})

test('split view: open beside, resize, focus, close, keyboard, kept after a reload, off when narrow', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await signIn(page)
  await expect(page.getByRole('button', { name: /^Account menu/ })).toBeVisible()
  const id = await connectionId(page)
  const strip = page.locator('[data-region="tabs"]')
  for (const coll of ['users', 'orders']) {
    await page.goto(`c/${id}/db/${DB}/coll/${coll}`)
    await expect(strip.getByRole('tab', { name: `${DB}.${coll}` })).toHaveAttribute('aria-selected', 'true', {
      timeout: 20_000,
    })
  }

  // "Open beside" in the tab's menu (a right click on the tab).
  await strip.getByRole('tab', { name: `${DB}.users` }).click()
  await strip.getByRole('tab', { name: `${DB}.orders` }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Open beside' }).click()
  const left = page.getByRole('region', { name: `${DB}.users, left pane` })
  const right = page.getByRole('region', { name: `${DB}.orders, right pane` })
  await expect(left).toBeVisible()
  await expect(right).toBeVisible()
  await expect(right.locator('[data-pane-header]')).toContainText('Active pane')
  await expect(strip.locator('[data-pane-marker]')).toHaveCount(2)

  // The divider, from the keyboard.
  const divider = page.getByRole('separator', { name: 'Resize the panes' })
  await divider.focus()
  await page.keyboard.press('End')
  await expect(divider).toHaveAttribute('aria-valuetext', '80%')
  await page.keyboard.press('Home')
  await expect(divider).toHaveAttribute('aria-valuetext', '20%')

  // A click in the other pane makes it the one in use (and the address follows it).
  await left.locator('[data-pane-header]').click()
  await expect(left.locator('[data-pane-header]')).toContainText('Active pane')
  await expect(page).toHaveURL(new RegExp(`/coll/users$`))

  // Kept after a reload, as the tabs are.
  await page.reload()
  await expect(left).toBeVisible({ timeout: 20_000 })
  await expect(right).toBeVisible()

  // Below 768 px only one tab shows; wider again, the split is back.
  await page.setViewportSize({ width: 700, height: 900 })
  await expect(page.locator('section[data-pane]')).toHaveCount(0)
  await page.setViewportSize({ width: 1440, height: 900 })
  await expect(left).toBeVisible()

  // Closing a pane keeps both tabs.
  await right.getByRole('button', { name: `Close the pane of ${DB}.orders` }).click()
  await expect(page.locator('section[data-pane]')).toHaveCount(0)
  await expect(strip.getByRole('tab', { name: `${DB}.orders` })).toBeVisible()

  // Ctrl+\ opens the tab in use beside the one before it; again, it moves to the other pane.
  await strip.getByRole('tab', { name: `${DB}.orders` }).click()
  await page.keyboard.press('Control+Backslash')
  await expect(page.locator('section[data-pane]')).toHaveCount(2)
  await expect(
    page.getByRole('region', { name: `${DB}.orders, right pane` }).locator('[data-pane-header]'),
  ).toContainText('Active pane')
  await page.keyboard.press('Control+Backslash')
  await expect(page.getByRole('region', { name: /left pane/ }).locator('[data-pane-header]')).toContainText(
    'Active pane',
  )

  // Home hides the split without ending it; Ctrl+\ there shows it again, the focus in its pane.
  await page
    .getByRole('navigation', { name: 'Application' })
    .getByRole('button', { name: /^Overview/ })
    .click()
  await expect(page.locator('section[data-pane]')).toHaveCount(0)
  await page.keyboard.press('Control+Backslash')
  await expect(page.locator('section[data-pane]')).toHaveCount(2)
  await expect(page.locator('section[data-pane][data-pane-focused="true"]')).toBeFocused()

  // A tab dragged to the workspace's right side opens beside the one in use.
  await page
    .getByRole('region', { name: /right pane/ })
    .getByRole('button', { name: /^Close the pane of/ })
    .click()
  await expect(page.locator('section[data-pane]')).toHaveCount(0)
  await strip.getByRole('tab', { name: `${DB}.users` }).click()
  const main = (await page.locator('main#main').boundingBox())!
  await strip.getByRole('tab', { name: `${DB}.orders` }).hover()
  await page.mouse.down()
  await page.mouse.move(main.x + main.width * 0.5, main.y + 120, { steps: 5 })
  const zone = page.locator('[data-split-drop]')
  await expect(zone).toContainText('Drop here to open beside')
  await page.mouse.move(main.x + main.width * 0.85, main.y + main.height / 2, { steps: 5 })
  await page.mouse.up()
  await expect(zone).toHaveCount(0)
  await expect(page.getByRole('region', { name: `${DB}.orders, right pane` })).toBeVisible()
  await expect(page.getByRole('region', { name: `${DB}.users, left pane` })).toBeVisible()
})

test('the data model: drawn from samples and references, listed for the keyboard, exported', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await signIn(page)
  await expect(page.getByRole('button', { name: /^Account menu/ })).toBeVisible()
  const id = await connectionId(page)
  await page.goto(`c/${id}/db/${DB}`)
  await page.getByRole('tablist', { name: 'Database sections' }).getByRole('tab', { name: 'Model' }).click()
  await page.getByRole('button', { name: 'Read the model' }).click()
  const diagram = page.locator('svg[data-model-diagram]')
  await expect(diagram).toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole('group', { name: `Data model of ${DB}: 3 collections, 2 links` })).toBeVisible()
  // Each box is reached with the keyboard and chosen with Enter.
  await diagram.locator('[data-node="users"]').focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('[data-model-details] h3')).toHaveText('users')
  await expect(diagram.locator('[data-node="orders"]')).toContainText('userId')
  await expect(diagram.locator('[data-node="bigOrders"]')).toContainText('view on orders')
  await expect(diagram.locator('path[data-edge]')).toHaveCount(2)

  // A click selects a collection and shows how its references were found.
  await diagram.locator('[data-node="orders"] rect').first().click()
  await expect(page.locator('[data-model-details]')).toContainText('by name, by values (3 of 3 found)')

  // The list, with the keyboard: a link moves to the collection it points to.
  await page.getByRole('radio', { name: 'List' }).click()
  const head = (name: string) => page.locator(`[data-collection-head="${name}"]`)
  await head('bigOrders').focus()
  await page.keyboard.press('ArrowDown')
  await expect(head('orders')).toBeFocused()
  // Opened already: it is the collection selected in the diagram.
  await expect(head('orders')).toHaveAttribute('aria-expanded', 'true')
  await page
    .locator('[data-collection="orders"]')
    .getByRole('button', { name: /userId → users\._id/ })
    .click()
  await expect(head('users')).toBeFocused()

  // Exported as JSON and PNG.
  for (const [label, file] of [
    ['Export as JSON', `${DB}-model.json`],
    ['Export as PNG', `${DB}-model.png`],
  ] as const) {
    const downloading = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Export' }).click()
    await page.getByRole('menuitem', { name: label }).click()
    const download = await downloading
    expect(download.suggestedFilename()).toBe(file)
    const path = await download.path()
    if (file.endsWith('.json')) {
      const model = JSON.parse(readFileSync(path, 'utf8')) as { references: Array<{ field: string }> }
      expect(model.references.map((r) => r.field)).toContain('userId')
    } else expect(readFileSync(path).subarray(1, 4).toString()).toBe('PNG')
  }
})

test('the next steps on the Overview: a link that does it, dismissed and kept dismissed', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await signIn(page)
  await expect(page.getByRole('button', { name: /^Account menu/ })).toBeVisible()
  const id = await connectionId(page)
  await page.goto(`c/${id}/db/${DB}/coll/orders`)
  await expect(page.locator('[data-region="tabs"]').getByRole('tab', { name: `${DB}.orders` })).toBeVisible({
    timeout: 20_000,
  })
  await page.goto(`c/${id}/db/${DB}`)
  await expect(page.getByRole('tablist', { name: 'Database sections' })).toBeVisible({ timeout: 20_000 })
  // Its collection tab closed: a place to go back to.
  // Closed from its menu (Shift+F10 on the tab).
  await page
    .locator('[data-region="tabs"]')
    .getByRole('tab', { name: `${DB}.orders` })
    .focus()
  await page.keyboard.press('Shift+F10')
  await page.getByRole('menuitem', { name: 'Close tab' }).click()
  await expect(page.locator('[data-region="tabs"]').getByRole('tab', { name: `${DB}.orders` })).toHaveCount(0)
  await page
    .getByRole('navigation', { name: 'Application' })
    .getByRole('button', { name: /^Overview/ })
    .click()

  const widget = page.locator('[data-widget="nextActions"]')
  await expect(widget).toBeVisible()
  const step = widget.locator('[data-next-action="continue"]').filter({ hasText: `Continue in ${DB}.orders` })
  await expect(step).toBeVisible({ timeout: 20_000 })
  // Dismissed: gone, and still gone after a reload (kept with the dashboard).
  const saved = page.waitForResponse(
    (r) => r.request().method() === 'PUT' && r.url().endsWith('/api/me/dashboard'),
  )
  await step.getByRole('button', { name: `Dismiss: Continue in ${DB}.orders` }).click()
  await expect(step).toHaveCount(0)
  await saved
  await page.reload()
  await expect(widget).toBeVisible({ timeout: 20_000 })
  await expect(
    widget.locator('[data-next-action="continue"]').filter({ hasText: `${DB}.orders` }),
  ).toHaveCount(0)
  // Brought back from the widget's menu, then followed: it opens the collection.
  await widget.locator('[data-next-actions-menu] button').click()
  await page.getByRole('menuitem', { name: 'Show dismissed steps again' }).click()
  await expect(step).toBeVisible()
  await step.locator('button[data-do]').click()
  await expect(
    page.locator('[data-region="tabs"]').getByRole('tab', { name: `${DB}.orders` }),
  ).toHaveAttribute('aria-selected', 'true')
})
