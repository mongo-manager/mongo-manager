import { expect, signIn, test } from '../fixtures'

/**
 * The updater (2026-11-03): the About page's Updates card for an administrator, and the privacy
 * line following the daily check. Nothing here reaches GitHub: Check now is never pressed, and the
 * daily check is turned off again before the test ends (the fixture fails on any foreign request).
 */
test('the About page shows the version, the check and a privacy line that follows the setting', async ({
  page,
}) => {
  await signIn(page)
  await page.getByRole('button', { name: /^Account menu/ }).click()
  await page.getByRole('menuitem', { name: /^About/ }).click()
  const card = page.locator('[data-about-updates]')
  await expect(card.getByRole('heading', { name: 'Updates' })).toBeVisible()
  await expect(card.locator('[data-updates-headline]')).toContainText(/\d+\.\d+\.\d+/)
  await expect(card.getByRole('button', { name: 'Check now' })).toBeVisible()
  const privacy = page.locator('[data-about-privacy]')
  await expect(privacy).toContainText('No update checks')

  const daily = card.getByRole('switch', { name: /Check for updates automatically/ })
  await daily.check()
  await expect(privacy).toContainText('once a day')
  await expect(privacy).not.toContainText('No update checks')
  await daily.uncheck()
  await expect(privacy).toContainText('No update checks')
})
