import { totpCode } from '../../server/src/auth/totp'
import { ADMIN, expect, openAccount, signIn, test, signOut } from '../fixtures'

const STEP = 30_000

test('authenticator app: enable, sign in with the next code, then turn off (Review Focus 1)', async ({
  page,
}) => {
  await signIn(page)
  await openAccount(page)
  await page.getByRole('button', { name: 'Set up' }).click()
  await page.getByLabel('Your password').fill(ADMIN.password)
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByRole('img', { name: 'QR code for your authenticator app' })).toBeVisible()
  const secret = (await page.locator('[data-test="totp-secret"]').innerText()).replace(/\s/g, '')
  // Each accepted code must use a later 30 s step than the last one (replay protection), within
  // one step of the server clock.
  const confirmed = Math.floor(Date.now() / STEP)
  await page.getByLabel('6-digit code').fill(totpCode(secret, confirmed * STEP))
  await page.getByRole('button', { name: 'Verify and turn on' }).click()
  await expect(page.getByRole('heading', { name: 'Save your recovery codes' })).toBeVisible()
  await expect(page.locator('[data-test="recovery-codes"] li')).toHaveCount(10)
  await page.getByRole('button', { name: 'I have saved them' }).click()

  await signOut(page)
  await signIn(page)
  // The confirmation used this step: replaying its code is refused (Review Focus 1)...
  await page.getByLabel('6-digit code').fill(totpCode(secret, confirmed * STEP))
  await page.getByRole('button', { name: 'Verify' }).click()
  await expect(page.getByRole('alert')).toBeVisible()
  // ...while the next step's code is still accepted.
  await page.getByLabel('6-digit code').fill(totpCode(secret, (confirmed + 1) * STEP))
  await page.getByRole('button', { name: 'Verify' }).click()
  await expect(page.getByRole('button', { name: 'Add connection' })).toBeVisible()

  await openAccount(page)
  await page.getByRole('button', { name: 'Turn off' }).click()
  await page.getByLabel('Your password').fill(ADMIN.password)
  await page.getByRole('button', { name: 'Continue' }).click()
  // Step confirmed + 2 is only within reach once the clock has entered step confirmed + 1.
  const wait = (confirmed + 1) * STEP - Date.now() + 500
  if (wait > 0) await page.waitForTimeout(wait)
  await page.getByLabel('6-digit code').fill(totpCode(secret, (confirmed + 2) * STEP))
  await page.getByRole('button', { name: 'Turn off' }).last().click()
  await expect(page.getByText('Authenticator app turned off.')).toBeVisible()
})

test('passkey: add with a virtual authenticator, sign in with it, then remove it', async ({ page }) => {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('WebAuthn.enable')
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  })
  await signIn(page)
  await openAccount(page)
  await page.getByLabel('Passkey name').fill('Virtual key')
  await page.getByRole('button', { name: 'Add passkey' }).click()
  await page.getByLabel('Your password').fill(ADMIN.password)
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByText('Passkey added.')).toBeVisible()
  await page.getByRole('button', { name: 'I have saved them' }).click()

  await signOut(page)
  await signIn(page)
  await page.getByRole('button', { name: 'Use a passkey' }).click()
  await expect(page.getByRole('button', { name: 'Add connection' })).toBeVisible()

  await openAccount(page)
  await page.getByRole('button', { name: 'Actions for Virtual key' }).click()
  await page.getByRole('menuitem', { name: 'Remove' }).click()
  await page.getByLabel('Your password').fill(ADMIN.password)
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByText('Passkey removed.')).toBeVisible()
})
