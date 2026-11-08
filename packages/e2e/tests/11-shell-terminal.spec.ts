// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { readFileSync } from 'node:fs'
import { type Page } from '@playwright/test'
import { expect, signIn, test } from '../fixtures'

/**
 * Phase 3a-2, and the user's request of 2026-10-12 ("kod düzenleyici alanını kaldır… terminale direk
 * yapıştıramıyorum"): the terminal is where code is typed and pasted — code of many lines too — with
 * completion, the result pane, export and snippets, end to end. As in 10-shell, the effect of a
 * command is checked through the REST API, and the auto CSP fixture fails the test on any
 * Content-Security-Policy violation.
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
  await expect(page.getByRole('tab', { name: 'Documents' })).toBeVisible({ timeout: 20_000 })
  await page.keyboard.press('Control+k')
  await page.getByPlaceholder('Type a command…').fill('shell')
  await page.getByRole('option', { name: /Open a shell here/ }).click()
  await expect(page.locator('[data-shell]')).toBeVisible()
  await page.locator('[data-shell]').click()
  await expect(page.locator('[data-shell] .xterm-accessibility')).toContainText('shop>', { timeout: 20_000 })
}

/** Waits for the shell to take keys (only Ctrl+C is taken while a command runs). */
async function ready(page: Page): Promise<void> {
  await expect(page.locator('[data-shell]:visible')).toHaveAttribute('data-status', 'ready', {
    timeout: 15_000,
  })
}

async function run(page: Page, code: string): Promise<void> {
  await ready(page)
  await page.keyboard.type(code)
  await page.keyboard.press('Enter')
}

/** Pastes into the terminal as the clipboard does (xterm turns the line ends into CR, as a terminal). */
async function paste(page: Page, text: string): Promise<void> {
  await ready(page)
  await page.locator('[data-shell] textarea').evaluate((area, value) => {
    // The browser's own classes (this package is typed for Node, not the DOM).
    const dom = globalThis as unknown as {
      DataTransfer: new () => { setData(type: string, value: string): void }
      ClipboardEvent: new (type: string, init: object) => unknown
    }
    const data = new dom.DataTransfer()
    data.setData('text/plain', value)
    const event = new dom.ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
    ;(area as unknown as { dispatchEvent(event: unknown): boolean }).dispatchEvent(event)
  }, text)
}

async function csrf(page: Page): Promise<string> {
  return ((await (await page.request.get('api/auth/me')).json()) as { csrfToken: string }).csrfToken
}

/**
 * Documents in a collection, through the REST API: 0 while the database or collection does not exist
 * (404); any other failure fails the test (second review 2026-10-12, minor 26).
 */
async function count(
  page: Page,
  id: string,
  coll: string,
  filter: object = {},
  db = 'shop',
): Promise<number> {
  const res = await page.request.post(`api/connections/${id}/databases/${db}/collections/${coll}/count`, {
    data: { filter },
    headers: { 'x-csrf-token': await csrf(page) },
  })
  if (res.status() === 404) return 0
  expect(res.ok(), `count ${db}.${coll}: ${res.status()}`).toBe(true)
  return ((await res.json()) as { count: number }).count
}

test('the terminal takes pasted code of many lines, completes, shows results and exports (phase 3a-2)', async ({
  page,
}) => {
  await signIn(page)
  await expect(page.getByRole('button', { name: /^Account menu/ })).toBeVisible()
  const id = await connectionId(page)
  await openShell(page, id)
  // The script editor is gone: the terminal is where code is typed.
  await expect(page.locator('[data-shell-editor]')).toHaveCount(0)

  // A paste of many lines (CRLF, as copied on Windows) is shown line by line, never as \x0d; nothing
  // runs until Enter, then the script runs as mongosh runs it: `use` on its own (switching database —
  // sent with the rest as one, mongosh took the query for its words), each statement after it in turn.
  await paste(
    page,
    [
      'use e2eother',
      'db.edmark.deleteMany({})',
      'db.edmark.insertMany([',
      '  { n: 1 },',
      '  { n: 2 },',
      '])',
      'print("pasted " + db.edmark.countDocuments())',
      '',
    ].join('\r\n'),
  )
  const screen = page.locator('[data-shell] .xterm-accessibility')
  await expect(screen).toContainText('... db.edmark.insertMany([')
  await expect(screen).not.toContainText('\\x0d')
  await expect(page.locator('[data-shell]:visible')).toHaveAttribute('data-status', 'ready')
  expect(await count(page, id, 'edmark', {}, 'e2eother')).toBe(0)
  // Once it has run, the databases' collections are read again: the one it made completes.
  const reread = page.waitForResponse((r) =>
    /\/databases\/e2eother\/collections$/.test(new URL(r.url()).pathname),
  )
  await page.keyboard.press('Enter')
  await expect.poll(() => count(page, id, 'edmark', {}, 'e2eother'), { timeout: 15_000 }).toBe(2)
  // print() writes to the terminal, after the statements before it ran.
  await expect(screen).toContainText('pasted 2', { timeout: 15_000 })
  expect(await count(page, id, 'edmark')).toBe(0)
  await reread

  // Tab after "db.edm" completes the collection's name in the terminal, the focus kept there.
  await ready(page)
  await page.keyboard.type('db.edm')
  await page.keyboard.press('Tab')
  await expect(screen.getByRole('listitem').filter({ hasText: /^e2eother> db\.edmark$/ })).toHaveCount(1, {
    timeout: 10_000,
  })
  await page.keyboard.type('.insertOne({ n: 3 })')
  await page.keyboard.press('Enter')
  await expect.poll(() => count(page, id, 'edmark', {}, 'e2eother'), { timeout: 15_000 }).toBe(3)

  // A cursor result shows in the result pane's table.
  await run(page, 'use shop')
  await run(page, 'db.big.find().limit(5)')
  await expect(page.locator('[data-result-table] [data-row]')).toHaveCount(5, { timeout: 15_000 })

  // Export JSON: the downloaded file holds the five documents.
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('[data-result-export-json]').click(),
  ])
  const exported = JSON.parse(readFileSync((await download.path())!, 'utf8')) as unknown[]
  expect(exported).toHaveLength(5)

  // The cursor of a plain find reopens in its collection view.
  await expect(page.locator('[data-result-open]')).toBeVisible({ timeout: 15_000 })
  await page.locator('[data-result-open]').click()
  await expect(page.getByRole('tab', { name: 'Documents', selected: true })).toBeVisible({ timeout: 15_000 })
})

test('a snippet is filled with safe literals, put in the terminal, and runs only on Enter (phase 3a-2)', async ({
  page,
}) => {
  await signIn(page)
  await expect(page.getByRole('button', { name: /^Account menu/ })).toBeVisible()
  const id = await connectionId(page)
  await openShell(page, id)
  await run(page, 'db.snipe.deleteMany({})')
  await expect.poll(() => count(page, id, 'snipe'), { timeout: 15_000 }).toBe(0)

  // Save the line being typed as a snippet with one string parameter, from the shell's menu.
  await ready(page)
  await page.keyboard.type('db.snipe.insertOne({ v: {{v}} })')
  await page.locator('[data-shell-menu] button').click()
  await page.getByRole('menuitem', { name: 'Save as snippet' }).click()
  await page.getByLabel('Name').fill('Tagged insert')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.locator('[data-param-row]')).toHaveCount(0)

  // The line is left empty again (Ctrl+U), then the snippet is opened from the Library and filled
  // with a hostile value: Insert puts inert code in the terminal's line.
  await page.locator('[data-shell]').click()
  await page.keyboard.press('End')
  await page.keyboard.press('Control+u')
  await page.keyboard.press('Control+Shift+L')
  const panel = page.locator('[data-library-page]')
  await expect(panel).toBeVisible()
  await panel
    .locator('[data-type="snippet"]', { hasText: 'Tagged insert' })
    .locator('[data-action="open"]')
    .click()
  const hostile = 'x"); db.big.drop(); ("'
  await page.getByLabel('v (text)').fill(hostile)
  await page.getByRole('button', { name: 'Insert', exact: true }).click()
  await expect(page.locator('[data-shell] .xterm-accessibility')).toContainText(
    'db.snipe.insertOne({ v: "x\\"',
    {
      timeout: 10_000,
    },
  )
  // Nothing ran by itself.
  expect(await count(page, id, 'snipe')).toBe(0)

  // The user runs it: exactly the hostile string is stored as data, and big is untouched.
  await page.keyboard.press('Enter')
  await expect.poll(() => count(page, id, 'snipe', { v: hostile }), { timeout: 15_000 }).toBe(1)
  expect(await count(page, id, 'big')).toBeGreaterThan(0)
})

// User request 2026-10-13 ("ekranı temizle sonuçlarıda temizlesin"): clearing clears the results
// too, and Undo brings them back — from the toast, or later from the empty result pane.
test('clearing the screen clears the results, and Undo brings them back (2026-10-13)', async ({ page }) => {
  await signIn(page)
  await expect(page.getByRole('button', { name: /^Account menu/ })).toBeVisible()
  const id = await connectionId(page)
  await openShell(page, id)
  await run(page, 'db.big.find().limit(2)')
  const pane = page.locator('[data-result-pane]')
  const clear = pane.locator('[data-result-clear]')
  // The screen's rows as the terminal shows them: its live region keeps every echo typed (it
  // is emptied on blur), and both catch up a moment late (review of the cls fix). A row asserted
  // gone was first seen there, so "not there" cannot pass on a screen not yet drawn.
  const rows = page.locator('[data-shell] .xterm-accessibility-tree')
  await expect(clear).toBeVisible()
  await expect(rows).toContainText('db.big.find().limit(2)')
  const shown = await pane.innerText()
  // The pane's own Clear says so, with an Undo that brings the very same results back.
  await clear.click()
  await expect(clear).toHaveCount(0)
  await page.getByRole('button', { name: 'Undo' }).click()
  await expect(clear).toBeVisible()
  expect(await pane.innerText()).toBe(shown)
  // Ctrl+L in the terminal clears the screen and the results; the empty pane offers them back.
  await page.locator('[data-shell]').click()
  await expect(rows).toContainText('db.big.find().limit(2)')
  await page.keyboard.press('Control+l')
  await expect(clear).toHaveCount(0)
  await expect(rows).not.toContainText('db.big.find().limit(2)')
  await pane.locator('[data-result-restore]').click()
  await expect(clear).toBeVisible()
  expect(await pane.innerText()).toBe(shown)
  // cls clears it as well, the line it was typed on included (user report 2026-10-15).
  await page.locator('[data-shell]').click()
  await ready(page)
  await page.keyboard.type('cls')
  await expect(rows).toContainText('shop> cls')
  await page.keyboard.press('Enter')
  await expect(clear).toHaveCount(0)
  await ready(page)
  await expect(rows).not.toContainText('cls')
  await expect(rows).toContainText('shop>')
  // The shell is closed: a user has a few at most.
  await page.getByRole('button', { name: /^Close tab Shell: Local test · shop/ }).click()
})
