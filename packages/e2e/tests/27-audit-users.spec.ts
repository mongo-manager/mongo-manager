import { readFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { ADMIN, expect, openAccount, signIn, test, watchCsp, watchOrigins } from '../fixtures'

const SECOND = { username: 'admin2', password: 'second-admin-password-2' }
/** Required 2FA (2026-10-28): a viewer added with 2FA required of them. */
const THIRD = { username: 'required1', password: 'required-viewer-password-3' }

async function users(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^Account menu/ }).click()
  await page.getByRole('menuitem', { name: 'Users' }).click()
}

/** The REST API as the signed-in page: its session, CSRF token and origin. */
async function api(page: Page, method: 'GET' | 'PUT' | 'DELETE', path: string, data?: object) {
  const me = await (await page.request.get('api/auth/me')).json()
  return page.request.fetch(`api/${path}`, {
    method,
    ...(data ? { data } : {}),
    headers: { 'x-csrf-token': me.csrfToken, origin: new URL(page.url()).origin },
  })
}

/**
 * Puts back what these tests change, from the server's state rather than from how far a test got,
 * each step on its own (one failing does not skip the others): later specs sign in as admin with
 * a password alone.
 */
async function restore(page: Page): Promise<void> {
  const steps: Array<() => Promise<unknown>> = [
    async () => {
      const policy = await (await api(page, 'GET', 'users/policy')).json()
      if (policy.adminTwoFactor)
        await api(page, 'PUT', 'users/policy', { adminTwoFactor: false, password: ADMIN.password })
      if (policy.everyoneTwoFactor)
        await api(page, 'PUT', 'users/policy', { everyoneTwoFactor: false, password: ADMIN.password })
    },
    async () => {
      const all = (await (await api(page, 'GET', 'users')).json()) as Array<{ id: string; username: string }>
      for (const u of all.filter((x) => x.username === SECOND.username || x.username === THIRD.username))
        await api(page, 'DELETE', `users/${u.id}`)
    },
    async () => {
      const keys = (await (await api(page, 'GET', 'auth/passkeys')).json()) as Array<{
        id: string
        name: string
      }>
      for (const k of keys.filter((x) => x.name === 'Policy key'))
        await api(page, 'DELETE', `auth/passkeys/${k.id}`, { password: ADMIN.password })
    },
    () => api(page, 'PUT', 'audit/settings', { days: null }),
  ]
  for (const step of steps) await step().catch(() => undefined)
}
test.afterEach(async ({ page }) => restore(page))

// Phase 4c §1–§3: the audit log exported as it is filtered, its retention, and each user's activity.
test('audit export and retention, and the users’ activity', async ({ page }) => {
  await signIn(page)
  await users(page)
  await page.getByRole('tab', { name: 'Activity' }).click()
  const row = page.locator('tr', { hasText: ADMIN.username }).first()
  await expect(row).toBeVisible()
  // A user's row opens the audit log filtered to them.
  await row.getByRole('button', { name: 'Audit log' }).click()
  await expect(page.locator('tbody')).toContainText('Sign in with a password')
  const adminId = ((await (await api(page, 'GET', 'auth/me')).json()) as { user: { id: string } }).user.id

  // The export follows the filters: every entry is admin's; every cell is quoted.
  const csv = page.waitForEvent('download')
  await page.locator('[data-audit-export="csv"]').click()
  const [header, ...rows] = readFileSync((await (await csv).path())!, 'utf8')
    .trim()
    .split(/\r?\n/)
  expect(header).toBe(
    '"id","at","username","userId","ip","action","outcome","connectionId","namespace","details"',
  )
  expect(rows.length).toBeGreaterThan(0)
  for (const r of rows)
    expect(r).toMatch(new RegExp(`^"\\d+","\\d{4}-\\d{2}-\\d{2}T[^"]*","admin","${adminId}",`))
  const ndjson = page.waitForEvent('download')
  await page.locator('[data-audit-export="ndjson"]').click()
  const entries = readFileSync((await (await ndjson).path())!, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as { username: string; userId: string; action: string })
  // The CSV export just made is itself in the log: one entry more.
  expect(entries).toHaveLength(rows.length + 1)
  expect(entries.at(-1)).toMatchObject({ action: 'audit.export' })
  for (const e of entries) expect(e).toMatchObject({ username: ADMIN.username, userId: adminId })

  // Fewer days than those in force ask the password, and take effect a day later; more days, or
  // for ever, at once without asking.
  const retention = page.locator('[data-audit-retention]')
  await retention.getByLabel('Keep entries for').selectOption({ label: '90 days' })
  await retention.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('heading', { name: 'Shorten the audit log?' })).toBeVisible()
  await page.getByLabel('Password').fill(ADMIN.password)
  await page.getByRole('button', { name: 'Shorten' }).click()
  await expect(page.getByText('Retention saved.')).toBeVisible()
  await expect(retention).toContainText(/90 days, from /)
  await retention.getByLabel('Keep entries for').selectOption({ label: 'Kept for ever' })
  await retention.getByRole('button', { name: 'Save' }).click()
  await expect(retention.locator('h3 + p')).toHaveText('Kept for ever')
  // Each change is itself in the log, as done.
  const changes = (await (await api(page, 'GET', 'audit?action=audit.settings')).json()) as Array<{
    outcome: string
  }>
  expect(changes.filter((c) => c.outcome === 'success').length).toBeGreaterThanOrEqual(2)
})

// Phase 4c §4: while required, an administrator without 2FA can only set it up.
test('two-factor authentication required for administrators', async ({
  page,
  browser,
  baseURL,
  cspViolations,
  foreignRequests,
}) => {
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
  await users(page)
  // User review 2026-10-30: the sign-in settings are on the Users page's Security tab.
  const security = () => page.locator('#users-view-security').click()
  await security()
  const policy = page.getByRole('switch', { name: 'Require two-factor authentication for administrators' })
  // The switch itself is visually hidden: its label is what is clicked.
  const policyLabel = page
    .locator('[data-admin-policy]')
    .getByText('Require two-factor authentication for administrators')
  // Not without 2FA of one's own: no one is locked out.
  await expect(policy).toBeDisabled()
  await expect(page.locator('[data-admin-policy]')).toContainText(
    'Set up two-factor authentication for yourself first',
  )

  await openAccount(page)
  await page.getByLabel('Passkey name').fill('Policy key')
  await page.getByRole('button', { name: 'Add passkey' }).click()
  await page.getByLabel('Your password').fill(ADMIN.password)
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByText('Passkey added.')).toBeVisible()
  await page.getByRole('button', { name: 'I have saved them' }).click()

  await users(page)
  await page.getByRole('button', { name: 'Add user' }).click()
  // Within the dialog: the users' table has a "Role of …" for every other user.
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Username').fill(SECOND.username)
  await dialog.getByLabel('Password', { exact: true }).fill(SECOND.password)
  await dialog.getByLabel('Role', { exact: true }).selectOption('admin')
  // Security audit 2026-10-16: a new account is confirmed with the administrator's own password.
  await dialog.getByLabel('Your password').fill(ADMIN.password)
  await dialog.getByRole('button', { name: 'Add user' }).click()
  await expect(page.getByText(`User ${SECOND.username} added.`)).toBeVisible()
  await security()
  await policyLabel.click()
  await expect(policy).toBeChecked()
  await expect(page.getByText('Administrators must now use two-factor authentication.')).toBeVisible()

  // The other administrator, without 2FA, gets the set-up page and nothing else.
  const other = await browser.newContext({ locale: 'en-US' })
  try {
    const otherPage = await other.newPage()
    watchCsp(otherPage, cspViolations)
    watchOrigins(otherPage, new URL(baseURL!).origin, foreignRequests)
    await signIn(otherPage, SECOND)
    await expect(otherPage.getByRole('heading', { name: 'Turn on two-factor authentication' })).toBeVisible()
    const blocked = await otherPage.request.get('/api/connections')
    expect(blocked.status()).toBe(403)
    expect(await blocked.json()).toMatchObject({ details: { reason: 'two_factor_setup_required' } })
  } finally {
    await other.close()
  }

  // The requirement keeps the last method of an administrator who has to have one.
  await openAccount(page)
  await page.getByRole('button', { name: 'Actions for Policy key' }).click()
  await page.getByRole('menuitem', { name: 'Remove' }).click()
  await page.getByLabel('Your password').fill(ADMIN.password)
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByText(/Two-factor authentication is required for this account/)).toBeVisible()
  await page.keyboard.press('Escape')

  // Turning it off asks the password.
  await users(page)
  await security()
  await policyLabel.click()
  await page.getByLabel('Password').fill(ADMIN.password)
  await page.getByRole('button', { name: 'Stop requiring' }).click()
  await expect(
    page.getByText('Two-factor authentication is no longer required for administrators.'),
  ).toBeVisible()
  await expect(policy).not.toBeChecked()
})

// Required 2FA (2026-10-28): chosen for one user when they are added, and taken off again.
test('two-factor authentication required of one user', async ({
  page,
  browser,
  baseURL,
  cspViolations,
  foreignRequests,
}) => {
  await signIn(page)
  await users(page)
  await page.getByRole('button', { name: 'Add user' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Username').fill(THIRD.username)
  await dialog.getByLabel('Password', { exact: true }).fill(THIRD.password)
  await dialog.getByLabel('Role', { exact: true }).selectOption('viewer')
  await expect(dialog.getByLabel('Require two-factor authentication')).not.toBeChecked()
  await dialog.getByLabel('Require two-factor authentication').check()
  await dialog.getByLabel('Your password').fill(ADMIN.password)
  await dialog.getByRole('button', { name: 'Add user' }).click()
  await expect(page.getByText(`User ${THIRD.username} added.`)).toBeVisible()
  const row = page.locator('tr', { hasText: THIRD.username })
  await expect(row.locator('[data-two-factor-required]')).toHaveAttribute('title', 'Required, not set up yet')

  // That user gets the set-up page, saying why, and nothing else.
  const other = await browser.newContext({ locale: 'en-US' })
  try {
    const otherPage = await other.newPage()
    watchCsp(otherPage, cspViolations)
    watchOrigins(otherPage, new URL(baseURL!).origin, foreignRequests)
    await signIn(otherPage, THIRD)
    await expect(otherPage.getByRole('heading', { name: 'Turn on two-factor authentication' })).toBeVisible()
    await expect(
      otherPage.getByText('An administrator requires two-factor authentication for your account.'),
    ).toBeVisible()
    const blocked = await otherPage.request.get('/api/connections')
    expect(blocked.status()).toBe(403)
    expect(await blocked.json()).toMatchObject({ details: { reason: 'two_factor_setup_required' } })

    // Taken off with the administrator's own password: the user may go on without 2FA.
    await page.getByRole('button', { name: `Actions for ${THIRD.username}` }).click()
    await page.getByRole('menuitem', { name: 'Stop requiring two-factor' }).click()
    await page.getByRole('dialog').getByLabel('Your password').fill(ADMIN.password)
    await page.getByRole('dialog').getByRole('button', { name: 'Stop requiring two-factor' }).click()
    await expect(
      page.getByText(`Two-factor authentication is no longer required of ${THIRD.username}.`),
    ).toBeVisible()
    await expect(row.locator('[data-two-factor-required]')).toHaveCount(0)
    expect((await otherPage.request.get('/api/connections')).status()).toBe(200)
  } finally {
    await other.close()
  }
  const audit = (await (await api(page, 'GET', 'audit?action=users.create')).json()) as Array<{
    details: { target?: string; requireTwoFactor?: boolean }
  }>
  expect(audit.find((e) => e.details.target === THIRD.username)?.details.requireTwoFactor).toBe(true)
})
