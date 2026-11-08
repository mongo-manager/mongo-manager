// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { Page } from '@playwright/test'
import { expect, openAccount, signIn, test } from '../fixtures'

/**
 * User report 2026-10-29: Account settings scrolled twice — its own list, and the whole window
 * under it, on and on into an empty canvas, the sidebar's bottom buttons carried off the screen.
 * What a card holds absolutely placed (a screen reader's text, a checkbox's input) must stay in the
 * page that scrolls it; the window itself never scrolls.
 */
const still = (page: Page) =>
  page
    .locator('html')
    .evaluate((doc) => ({ scrollY: doc.scrollTop, overflow: doc.scrollHeight - doc.clientHeight }))

test('Account settings scroll in their own list, and the window stays where it is', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await signIn(page)
  await openAccount(page)
  const scroller = page.locator('[data-account-page] > div.overflow-auto')
  expect(await still(page)).toEqual({ scrollY: 0, overflow: 0 })

  // The last section, from the list; then the wheel, well past the end.
  await page.getByRole('navigation', { name: 'Account sections' }).getByRole('button').last().click()
  await page.mouse.move(700, 400)
  for (let i = 0; i < 10; i++) await page.mouse.wheel(0, 800)
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
  expect(await still(page)).toEqual({ scrollY: 0, overflow: 0 })
  // One scroll only: the page around the list has nothing to scroll.
  expect(await page.locator('#main').evaluate((el) => el.scrollHeight - el.clientHeight)).toBe(0)
  // The sidebar's bottom buttons stay on screen.
  await expect(page.getByRole('button', { name: /^Switch to (dark|light) theme/ })).toBeInViewport()
})

test('no page of the sidebar scrolls the window', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await signIn(page)
  const nav = page.getByRole('navigation', { name: 'Application' })
  await expect(nav.getByRole('button', { name: 'Overview', exact: true })).toBeVisible()
  const closed = nav.locator('button[aria-expanded="false"]:not([aria-haspopup])')
  for (let i = 0; i < 15 && (await closed.count()) > 0; i++) await closed.first().click()
  const pages = nav.locator('li > button:not([aria-expanded]):not([aria-haspopup])')
  const names = await pages.evaluateAll((els) => els.map((e) => e.textContent?.trim() ?? ''))
  expect(names.length).toBeGreaterThan(5)
  for (const name of names) {
    await nav.getByRole('button', { name, exact: true }).first().click()
    await page.waitForTimeout(300)
    await page.keyboard.press('Escape')
    expect(await still(page), name).toEqual({ scrollY: 0, overflow: 0 })
  }
  await openAccount(page)
  expect(await still(page), 'Account settings').toEqual({ scrollY: 0, overflow: 0 })
})
