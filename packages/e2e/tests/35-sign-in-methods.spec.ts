// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { expect, signIn, test } from '../fixtures'

/**
 * W7, W8: the connection form's OIDC, Kerberos and Encryption parts against the built server in
 * team mode. MONGODB-OIDC itself needs MongoDB Enterprise or Atlas, and the optional native packages
 * are not installed here: what is checked is what the form offers and says, the callback's refusal
 * of a sign-in it did not start, and that no secret or token reaches the page. The flows themselves
 * are covered by the server's tests against a test identity provider (oidc-routes.test.ts).
 */
interface Capabilities {
  kerberos: { available: boolean; allowed: boolean }
  encryption: { available: boolean }
  oidc: { redirectUri: string }
}

test('the connection form offers OIDC, Kerberos and encryption as this server allows (W7, W8)', async ({
  page,
}) => {
  await signIn(page)
  await expect(page.getByRole('button', { name: /^Account menu/ })).toBeVisible()
  const caps = (await (await page.request.get('api/connections/capabilities')).json()) as Capabilities
  expect(caps.oidc.redirectUri).toMatch(/\/oidc\/callback$/)

  await page.getByRole('button', { name: 'Add connection' }).first().click()
  await page.locator('[data-advanced-toggle]').click()
  await page.getByRole('tab', { name: 'Authentication' }).click()
  const mechanism = page.getByLabel('Mechanism')

  // Kerberos: the package, or (team mode) the administrator's switch, decides what is said.
  await mechanism.selectOption('GSSAPI')
  if (!caps.kerberos.available)
    await expect(page.locator('[data-test="kerberos-unavailable"]')).toContainText('kerberos')
  else if (!caps.kerberos.allowed)
    await expect(page.locator('[data-test="kerberos-refused"]')).toContainText('MM_ALLOW_KERBEROS')
  else await expect(page.locator('[data-test="kerberos-warning"]')).toBeVisible()

  // OIDC: no password; the redirect address this server answers on.
  await mechanism.selectOption('MONGODB-OIDC')
  await expect(page.locator('[data-test="oidc-info"]')).toBeVisible()
  await expect(page.getByLabel('Password', { exact: true })).toHaveCount(0)
  await expect(page.getByLabel('Redirect address')).toHaveAttribute('placeholder', caps.oidc.redirectUri)

  // Encryption: off where its package is missing, and the form says how to get it.
  await page.getByRole('tab', { name: 'Encryption' }).click()
  const enable = page.getByLabel('Use client-side encryption (CSFLE / Queryable Encryption)')
  if (!caps.encryption.available) {
    await expect(page.locator('[data-test="encryption-unavailable"]')).toContainText(
      'mongodb-client-encryption',
    )
    await expect(enable).toBeDisabled()
  } else await expect(enable).toBeEnabled()
})

test('the OIDC callback refuses a sign-in this browser did not start (W7)', async ({ page }) => {
  await signIn(page)
  await expect(page.getByRole('button', { name: /^Account menu/ })).toBeVisible()
  await page.goto('oidc/callback?state=forged-state&code=forged-code')
  await expect(
    page.getByText('That sign-in was unknown, expired or started in another browser. Start it again here.'),
  ).toBeVisible()
  expect(page.url()).not.toContain('oidc_error')
  expect(page.url()).not.toContain('forged-code')
})
