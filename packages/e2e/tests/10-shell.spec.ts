import { type Page } from '@playwright/test'
import { expect, signIn, test } from '../fixtures'

/**
 * Phase 3a-1: the advanced shell end to end, in a real browser over the /ws socket. The auto CSP
 * fixture fails the test on any Content-Security-Policy violation, so opening the terminal (which
 * creates styles at run time) already proves the CSP is not relaxed. Because reading xterm's
 * rendered output is brittle, the "a command ran" assertions check the command's effect through the
 * API instead — which also proves it executed through the sandbox, proxy and MongoDB.
 */
async function connectionId(page: Page): Promise<string> {
  const list = (await (await page.request.get('api/connections')).json()) as Array<{
    id: string
    name: string
  }>
  return list.find((c) => c.name === 'Local test')!.id
}

async function openShell(page: Page, id: string): Promise<void> {
  await page.goto(`c/${id}/db/shop/coll/big`)
  // Wait for the collection tab to be the active view before using the palette (focus is ready).
  await expect(page.getByRole('tab', { name: 'Documents' })).toBeVisible({ timeout: 20_000 })
  await page.keyboard.press('Control+k')
  await page.getByPlaceholder('Type a command…').fill('shell')
  await page.getByRole('option', { name: /Open a shell here/ }).click()
  await expect(page.locator('[data-shell]')).toBeVisible()
  await page.locator('[data-shell]').click()
  // The prompt shows the connection's db once the worker has connected through the proxy.
  await expect(page.locator('[data-shell] .xterm-accessibility')).toContainText('shop>', { timeout: 20_000 })
}

async function run(page: Page, code: string): Promise<void> {
  // Keys typed while a command runs are not taken (only Ctrl+C is): the last one has ended first.
  await expect(page.locator('[data-shell]:visible')).toHaveAttribute('data-status', 'ready', {
    timeout: 15_000,
  })
  await page.keyboard.type(code)
  await page.keyboard.press('Enter')
}

async function csrf(page: Page): Promise<string> {
  return ((await (await page.request.get('api/auth/me')).json()) as { csrfToken: string }).csrfToken
}

/** Count documents in a collection through the REST API (proves the shell command took effect). */
async function count(page: Page, id: string, coll: string): Promise<number> {
  const res = await page.request.post(`api/connections/${id}/databases/shop/collections/${coll}/count`, {
    data: { filter: {} },
    headers: { 'x-csrf-token': await csrf(page) },
  })
  return ((await res.json()) as { count: number }).count
}

test('opens a shell and runs commands through the sandbox and proxy (phase 3a-1)', async ({ page }) => {
  await signIn(page)
  await expect(page.getByRole('button', { name: /^Account menu/ })).toBeVisible()
  const id = await connectionId(page)
  await openShell(page, id)

  // A write runs: the document appears through the API.
  await run(page, 'db.shellmark.deleteMany({}); db.shellmark.insertOne({ ok: 1 })')
  await expect.poll(() => count(page, id, 'shellmark'), { timeout: 15_000 }).toBe(1)

  // A hostile value is stored; the shell keeps working (its control bytes are escaped on screen).
  await run(page, 'db.shellmark.insertOne({ x: "a\\u001b]52;c;x\\u0007b" })')
  await expect.poll(() => count(page, id, 'shellmark'), { timeout: 15_000 }).toBe(2)

  // Ctrl+C ends a long command: a JS sleep ignores killOp, so the worker is reset within the grace
  // and the terminal shows the reset notice. The session survives (a fresh worker replaces it).
  await run(page, 'sleep(30000)')
  await page.keyboard.press('Control+c')
  await expect(page.locator('[data-shell] .xterm-accessibility')).toContainText('reset', { timeout: 10_000 })
})

// User request 2026-10-11: the shell is found beside Overview, Performance and Watch, in the tree
// and with Ctrl+K from anywhere — each opening the same kept page for the same database.
test('opens a shell from the connection page, the tree and the palette', async ({ page }) => {
  await signIn(page)
  await expect(page.getByRole('button', { name: /^Account menu/ })).toBeVisible()
  const id = await connectionId(page)
  await page.goto(`c/${id}/db/shop`)
  await page.locator('button[data-open-shell]').click()
  await expect(page.locator('[data-shell]')).toBeVisible()
  await page.locator('[data-shell]').click()
  await expect(page.locator('[data-shell] .xterm-accessibility')).toContainText('shop>', { timeout: 20_000 })

  // The tree: a database's menu opens a shell on it.
  await page.getByRole('button', { name: 'Actions for shop', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Open shell' }).click()
  await expect(page.getByRole('tab', { name: /Shell: Local test · shop/ })).toHaveAttribute(
    'aria-selected',
    'true',
  )

  // Ctrl+K from a page with no connection: a shell on any connection one may.
  await page.goto('account')
  // The page is up (its keys taken) before the palette is asked for: pressed earlier, nothing opened.
  await expect(page.getByRole('heading', { name: 'Two-factor authentication' })).toBeVisible()
  await page.keyboard.press('Control+k')
  await page.getByPlaceholder('Type a command…').fill('shell local')
  await page.getByRole('option', { name: 'Open a shell on Local test' }).click()
  await expect(page.locator('[data-shell]').last()).toBeVisible()

  // The connection's page: Shell sits after its sections.
  await page.goto(`c/${id}`)
  const bar = page.locator('button[data-open-shell]')
  await expect(bar).toHaveText('Shell')
  await bar.click()
  await expect(page.locator('[data-shell]').last()).toBeVisible()
})

// The shell's redesign (2026-10-11): shell tabs stay open together over one socket. Each hears only
// its own session — before, the newest tab took every message and the first one went silent.
test('two shell tabs open together, each showing only its own output', async ({ page }) => {
  await signIn(page)
  await expect(page.getByRole('button', { name: /^Account menu/ })).toBeVisible()
  const id = await connectionId(page)
  await openShell(page, id)
  const shown = page.locator('[data-shell]:visible .xterm-accessibility')

  // A second shell, on another database, from the tree: no reload, the first tab's session lives on.
  await page.getByRole('button', { name: 'Actions for admin', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Open shell' }).click()
  await page.locator('[data-shell]:visible').click()
  await expect(shown).toContainText('admin>', { timeout: 20_000 })
  await expect(page.locator('[data-shell-header]:visible')).toContainText('admin')

  // Back to the first: it still works, its output in its own terminal only.
  await page.getByRole('tab', { name: /Shell: Local test · shop/ }).click()
  // A tab is a route: the other shell stays in sight until the navigation ends (never click it).
  await expect(page.locator('[data-shell-header]:visible')).toContainText('shop')
  await page.locator('[data-shell]:visible').click()
  await run(page, 'db.twotabs.deleteMany({}); db.twotabs.insertOne({ mark: "first-tab" })')
  await expect(shown).toContainText('acknowledged', { timeout: 15_000 })
  await expect(page.locator('[data-shell-status]:visible')).toContainText('Connected')
  await expect.poll(() => count(page, id, 'twotabs'), { timeout: 15_000 }).toBe(1)
  await page.getByRole('tab', { name: /Shell: Local test · admin/ }).click()
  await expect(page.locator('[data-shell]:visible .xterm-accessibility')).not.toContainText('acknowledged')

  // Closing a shell tab ends its session (the later tests' shells are within the per-user limit).
  await page.getByRole('button', { name: /^Close tab Shell: Local test · admin/ }).click()
  await page.getByRole('button', { name: /^Close tab Shell: Local test · shop/ }).click()
  await expect(page.locator('[data-shell]')).toHaveCount(0)
})

test('the terminal works with the WebGL renderer disabled, without CSP violations (phase 3a-1)', async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({ baseURL })
  const page = await context.newPage()
  const violations: string[] = []
  page.on('console', (m) => {
    if (/Content Security Policy|Refused to (apply|load|execute)/i.test(m.text())) violations.push(m.text())
  })
  // Hide WebGL so xterm falls back to the DOM renderer, which creates the most run-time styles.
  // Written as a string: it runs in the browser, so the e2e tsconfig (node types only) must not
  // type-check its DOM globals.
  await page.addInitScript(`{
    const proto = HTMLCanvasElement.prototype
    const real = proto.getContext
    proto.getContext = function (type, ...rest) {
      return type === 'webgl' || type === 'webgl2' ? null : real.call(this, type, ...rest)
    }
  }`)
  await signIn(page)
  await expect(page.getByRole('button', { name: /^Account menu/ })).toBeVisible()
  const id = await connectionId(page)
  await openShell(page, id)
  await run(page, 'db.shellmark.insertOne({ dom: 1 })')
  await expect.poll(() => count(page, id, 'shellmark'), { timeout: 15_000 }).toBeGreaterThanOrEqual(1)
  expect(violations).toEqual([])
  await context.close()
})

// User report 2026-10-12: a reload kept nothing of the shell and, three shells open, ended in "You have
// too many shells open". A reload takes the same shell again, its variables kept, however many times.
test('a reload takes the same shell again, its variables kept, never too many', async ({ page }) => {
  await signIn(page)
  await expect(page.getByRole('button', { name: /^Account menu/ })).toBeVisible()
  const id = await connectionId(page)
  await openShell(page, id)
  await run(page, 'db.shellmark.deleteMany({ reload: 1 }); var keptAcrossReload = 4242')
  for (let i = 0; i < 4; i++) {
    await page.reload()
    await expect(page.locator('[data-shell] .xterm-accessibility')).toContainText('Reconnected', {
      timeout: 20_000,
    })
  }
  await page.locator('[data-shell]').click()
  // The variable set before the reloads: the same session.
  await run(page, 'db.shellmark.insertOne({ reload: keptAcrossReload })')
  await expect
    .poll(
      async () =>
        (
          await page.request.post(`api/connections/${id}/databases/shop/collections/shellmark/count`, {
            data: { filter: { reload: 4242 } },
            headers: { 'x-csrf-token': await csrf(page) },
          })
        ).json() as Promise<{ count: number }>,
      { timeout: 15_000 },
    )
    .toMatchObject({ count: 1 })
  await expect(page.getByText(/too many shells/i)).toHaveCount(0)
  await page.getByRole('button', { name: /^Close tab Shell: Local test · shop/ }).click()
  await expect(page.locator('[data-shell]')).toHaveCount(0)
})
