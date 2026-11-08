// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { expect, openAccount, signIn, test } from '../fixtures'

/**
 * W5 (completion §2 W5.3): a shortcut rebound in Account settings, kept on the server across a
 * reload, refused where another shortcut has the keys, named by the ? list and the palette's
 * button, and reset.
 */
test('rebinds the palette’s keys, keeps them across a reload, refuses a taken one and resets', async ({
  page,
}) => {
  await signIn(page)
  await openAccount(page)
  const card = page.getByRole('region', { name: 'Keyboard shortcuts' })
  await card.scrollIntoViewIfNeeded()
  const row = card.locator('[data-shortcut-row]').filter({ hasText: 'Open the command palette' })

  // Keys another shortcut has: refused, with the reason.
  await row.getByRole('button', { name: /Change the keys of/ }).click()
  await page.keyboard.press('Control+Shift+F')
  await expect(row.getByRole('alert')).toContainText('Focus mode')

  await row.getByRole('button', { name: /Change the keys of/ }).click()
  await page.keyboard.press('Control+Shift+K')
  await expect(row.locator('kbd')).toHaveText(['Ctrl', 'Shift', 'K'])

  await page.reload()
  await expect(page.getByRole('button', { name: /^Account menu/ })).toBeVisible()
  const search = page.getByRole('button', { name: /^Search/ })
  await expect(search).toHaveAttribute('aria-keyshortcuts', 'Control+Shift+K')
  await page.locator('body').click({ position: { x: 5, y: 5 } })
  await page.keyboard.press('Control+k')
  await expect(page.getByRole('combobox', { name: 'Command palette' })).toHaveCount(0)
  await page.keyboard.press('Control+Shift+K')
  await expect(page.getByRole('combobox', { name: 'Command palette' })).toBeVisible()
  await page.keyboard.press('Escape')

  // The ? list names the user's keys, and leads to the settings.
  await page.keyboard.press('?')
  const sheet = page.getByRole('dialog', { name: 'Keyboard shortcuts' })
  await expect(sheet.locator('dl > div').filter({ hasText: 'Open the command palette' })).toContainText(
    'Changed',
  )
  await sheet.getByRole('button', { name: 'Change shortcuts' }).click()
  const settings = page.getByRole('region', { name: 'Keyboard shortcuts' })
  await settings.getByRole('button', { name: 'Reset all' }).click()
  await expect(
    settings.locator('[data-shortcut-row]').filter({ hasText: 'Open the command palette' }).locator('kbd'),
  ).toHaveText(['Ctrl', 'K'])
})

// Review I1: bindings that only fit together — two shortcuts' keys swapped — come back after a reload.
test('keeps two swapped shortcuts across a reload', async ({ page }) => {
  await signIn(page)
  await openAccount(page)
  const card = page.getByRole('region', { name: 'Keyboard shortcuts' })
  await card.scrollIntoViewIfNeeded()
  const row = (label: string) => card.locator('[data-shortcut-row]').filter({ hasText: label })
  const bind = async (label: string, keys: string) => {
    await row(label)
      .getByRole('button', { name: /Change the keys of/ })
      .click()
    await page.keyboard.press(keys)
    await expect(row(label).getByRole('alert')).toHaveCount(0)
  }
  // Focus mode steps aside, the panel takes its keys, focus mode takes the panel's.
  await bind('Focus mode', 'Control+Shift+X')
  await bind('Show or hide the connections panel', 'Control+Shift+F')
  await bind('Focus mode', 'Control+B')
  await expect(row('Show or hide the connections panel').locator('kbd')).toHaveText(['Ctrl', 'Shift', 'F'])

  await page.reload()
  await expect(page.getByRole('button', { name: /^Account menu/ })).toBeVisible()
  await openAccount(page)
  await card.scrollIntoViewIfNeeded()
  await expect(row('Show or hide the connections panel').locator('kbd')).toHaveText(['Ctrl', 'Shift', 'F'])
  await expect(row('Focus mode').locator('kbd')).toHaveText(['Ctrl', 'B'])
  await card.getByRole('button', { name: 'Reset all' }).click()
  await expect(row('Focus mode').locator('kbd')).toHaveText(['Ctrl', 'Shift', 'F'])
})
