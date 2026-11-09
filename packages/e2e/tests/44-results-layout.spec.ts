// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { Locator, Page } from '@playwright/test'
import { MongoClient } from 'mongodb'
import { expect, signIn, test } from '../fixtures'

/**
 * User report 2026-11-07: the results of a collection of big documents (request logs of some 60 KB:
 * 300-item arrays, 30 headers, a 40-line stack, a 2 KB one-line message) — the table kept its room
 * under chips, the focus never hid under the frozen columns, a cell's popover stayed in the window,
 * Back found the results where they were, and the breadcrumb stayed readable. The data is invented.
 */
const DB = 'resultslayout'
const COLL = 'requestlogs'

function requestLog(n: number) {
  const headers: Record<string, string> = Object.fromEntries(
    Array.from({ length: 30 }, (_, k) => [
      `x-custom-${k}`,
      `value-${k}-${n % 2 ? 'odd' : 'even'}-${'h'.repeat(60)}`,
    ]),
  )
  // Every log carries this one: offered as a suggestion, it would filter nothing out.
  headers['x-region'] = `eu-west-${'r'.repeat(40)}`
  return {
    _id: `req-${String(n).padStart(4, '0')}`,
    ts: new Date(Date.UTC(2026, 10, 1, 0, n)),
    service: n % 3 ? 'billing' : 'catalog',
    level: n % 5 === 0 ? 'error' : 'info',
    durationMs: 100 + n,
    request: {
      method: n % 2 ? 'POST' : 'GET',
      url: `https://shop.example.test/api/orders?page=${n}&filter=${'x'.repeat(200)}`,
      headers,
      items: Array.from({ length: 300 }, (_, i) => ({ sku: `SKU-${i}`, qty: (i % 4) + 1, price: 10 + i })),
    },
    response: { status: 200, size: 1000 + n, body: { ok: true } },
    stack: Array.from({ length: 40 }, (_, i) => `    at step${i} (/opt/shop/lib/step${i}.js:${i}:${n})`).join(
      '\n',
    ),
    message: `A very long single-line message ${'lorem ipsum '.repeat(170)}`,
    trailer: 'last-field-value',
  }
}

test.beforeAll(async () => {
  const client = new MongoClient(process.env.MM_E2E_MONGO_URI!)
  try {
    const db = client.db(DB)
    await db.dropDatabase()
    await db.collection(COLL).insertMany(Array.from({ length: 30 }, (_, i) => requestLog(i + 1)) as never[])
  } finally {
    await client.close()
  }
})

async function openCollection(page: Page, width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height })
  await signIn(page)
  await expect(page.getByRole('button', { name: /^Account menu/ })).toBeVisible()
  const list = (await (await page.request.get('api/connections')).json()) as Array<{
    id: string
    name: string
  }>
  const id = list.find((c) => c.name === 'Local test')!.id
  await page.goto(`c/${id}/db/${DB}/coll/${COLL}`)
  await expect(page.getByRole('button', { name: /^Open document / }).first()).toBeVisible()
}

async function filterBy(page: Page, filter: string): Promise<void> {
  const box = page.getByRole('textbox', { name: 'Filter', exact: true })
  await box.fill(filter)
  await box.press('Enter')
}

/** The box that scrolls the results of the view shown. */
const scrollerOf = (inside: Locator) =>
  inside.locator('xpath=ancestor::div[contains(concat(" ", @class, " "), " overflow-auto ")][1]')
const tableScroller = (page: Page) => scrollerOf(page.locator('tbody tr[data-row]').first())

/** The rows of the table wholly inside the window. */
async function rowsInSight(page: Page, height: number): Promise<number> {
  let n = 0
  for (const row of await page.locator('tbody tr[data-row]').all()) {
    const box = await row.boundingBox()
    if (box && box.y >= 0 && box.y + box.height <= height) n++
  }
  return n
}

test('the results table keeps its room under suggestion and filter chips', async ({ page }, info) => {
  await openCollection(page, 1280, 720)
  await filterBy(
    page,
    '{ level: "info", service: "billing", durationMs: { $gt: 100 }, "request.method": "POST", trailer: "last-field-value" }',
  )
  await expect(page.locator('[data-filter-chips] [data-chip]')).toHaveCount(5)
  const chips = page.locator('[data-suggestions] [data-chip]')
  await expect(chips.first()).toBeVisible()
  // A long suggestion is cut short, whole in its title; one every document holds is never offered.
  for (const chip of await chips.all()) {
    const box = (await chip.boundingBox())!
    expect(box.width).toBeLessThanOrEqual(330)
    expect(await chip.getAttribute('title')).toContain(
      (await chip.getAttribute('aria-label'))!.replace(/^Add /, '').replace(/ to the filter$/, ''),
    )
  }
  await expect(page.locator('[data-suggestions]')).not.toContainText('x-region')
  const scroller = tableScroller(page)
  expect((await scroller.boundingBox())!.height).toBeGreaterThanOrEqual(200)
  await scroller.scrollIntoViewIfNeeded()
  expect(await rowsInSight(page, 720)).toBeGreaterThanOrEqual(4)
  await page.screenshot({ path: info.outputPath('chips-1280.png') })

  // Fifteen conditions: still rows to read.
  const many = Array.from(
    { length: 15 },
    (_, k) => `"request.headers.x-custom-${k}": { $exists: true }`,
  ).join(', ')
  await filterBy(page, `{ ${many} }`)
  await expect(page.locator('[data-filter-chips] [data-chip]')).toHaveCount(15)
  await expect(page.locator('tbody tr[data-row]').first()).toBeAttached()
  await tableScroller(page).scrollIntoViewIfNeeded()
  expect(await rowsInSight(page, 720)).toBeGreaterThanOrEqual(4)
  await page.screenshot({ path: info.outputPath('chips-15-conditions.png') })
})

/** Where the frozen columns end, and the header's bottom, in the window. */
async function frozenEdges(page: Page): Promise<{ right: number; head: number }> {
  const lead = page.locator('tbody tr[data-row]').first().locator('td:has([data-row-lead])')
  const leadBox = (await lead.boundingBox())!
  const head = (await page.locator('thead').boundingBox())!
  return { right: leadBox.x + leadBox.width, head: head.y + head.height }
}
/** The focused element's box, and whether it sits in a frozen (sticky) cell. */
const focused = (page: Page) =>
  page.evaluate<{ left: number; top: number; frozen: boolean; head: boolean; row: string | null }>(`(() => {
    const el = document.activeElement
    const r = el.getBoundingClientRect()
    const cell = el.closest('td, th')
    return {
      left: r.left,
      top: r.top,
      frozen: !!cell && getComputedStyle(cell).position === 'sticky',
      head: !!el.closest('thead'),
      row: el.closest('tr[data-row]')?.getAttribute('data-key') ?? null,
    }
  })()`)

test('the focus never hides under the frozen columns or the header (WCAG 2.4.11)', async ({ page }) => {
  await openCollection(page, 1440, 900)
  const edges = await frozenEdges(page)
  // From a row's last field back to its first, the keyboard's way.
  const row = page.locator('tbody tr[data-row]').nth(2)
  await row.locator('td[data-field="trailer"]').focus()
  for (let i = 0; i < 30; i++) {
    await page.keyboard.press('Shift+Tab')
    const now = await focused(page)
    if (now.frozen) break
    expect(now.left, `step ${i}`).toBeGreaterThanOrEqual(edges.right - 1)
  }
  // The headers too.
  await page.locator('thead th[data-column="trailer"] button[data-sort]').focus()
  for (let i = 0; i < 30; i++) {
    await page.keyboard.press('Shift+Tab')
    const now = await focused(page)
    if (now.frozen || !now.head) break
    expect(now.left, `header step ${i}`).toBeGreaterThanOrEqual(edges.right - 1)
  }
  // Up the rows: a row half under the sticky header is moved out from under it.
  const scroller = tableScroller(page)
  await scroller.evaluate((el) => {
    el.scrollLeft = 0
    el.scrollTop = 4 * 36 + 18
  })
  const fifth = page.locator('tbody tr[data-row]').nth(5)
  await fifth.locator('td[data-field="level"]').evaluate((el) => el.focus({ preventScroll: true }))
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press('Shift+Tab')
    const now = await focused(page)
    if (now.head) break
    expect(now.top, `up step ${i}`).toBeGreaterThanOrEqual(edges.head - 1)
    if (!now.frozen) expect(now.left, `up step ${i}`).toBeGreaterThanOrEqual(edges.right - 1)
  }
})

test('a cell’s nested value stays in the window when a branch opens inside it', async ({ page }, info) => {
  await openCollection(page, 1440, 900)
  await page.locator('tbody tr[data-row]').nth(2).locator('td[data-field="request"] button').first().click()
  const popup = page.locator('[data-ds-popup][role="dialog"]')
  await expect(popup).toBeVisible()
  await popup.getByRole('button', { name: 'Expand headers' }).click()
  await expect
    .poll(async () => {
      const box = (await popup.boundingBox())!
      return box.y >= 0 && box.y + box.height <= 900
    })
    .toBe(true)
  await page.screenshot({ path: info.outputPath('popover-headers.png') })
})

/** The document at the top of the results' box (its _id button's name), and how far into it the box is. */
const topOfResults = (page: Page) =>
  page.evaluate<{ key: string; offset: number; scrolled: number }>(`(() => {
    const opener = document.querySelector('[data-open-id]')
    let box = opener.parentElement
    while (box && getComputedStyle(box).overflowY !== 'auto') box = box.parentElement
    const top = box.getBoundingClientRect().top
    const item = [...box.querySelectorAll('li')].find((li) => li.querySelector('[data-open-id]') && li.getBoundingClientRect().bottom > top)
    return {
      key: item.querySelector('[data-open-id]').getAttribute('aria-label'),
      offset: Math.round(top - item.getBoundingClientRect().top),
      scrolled: box.scrollTop,
    }
  })()`)

test('Back to results finds the JSON, Cards and table views where they were', async ({ page }) => {
  await openCollection(page, 1280, 800)
  const views = page.getByRole('radiogroup', { name: 'View' })
  for (const mode of ['JSON', 'Cards']) {
    await views.getByRole('radio', { name: mode }).click()
    const buttons = page.locator('[data-open-id]')
    await expect(buttons).toHaveCount(20)
    // Far down: the next-to-last document of the page, in the middle of the box. The documents are
    // laid out as they come in sight, so it is brought there until it stays.
    const opened = buttons.nth(18)
    for (let i = 0; i < 6; i++) {
      await opened.evaluate((el) => el.scrollIntoView({ block: 'center' }))
      await page.waitForTimeout(100)
    }
    const before = await topOfResults(page)
    expect(before.scrolled, mode).toBeGreaterThan(2000)
    await opened.click()
    await page.getByRole('button', { name: 'Back to results' }).click()
    // The same document at the top of the box, as far into it.
    await expect
      .poll(
        async () => {
          const now = await topOfResults(page)
          return now.key === before.key && Math.abs(now.offset - before.offset) <= 2
        },
        { message: mode },
      )
      .toBe(true)
  }
  await views.getByRole('radio', { name: 'Table' }).click()
  const scroller = tableScroller(page)
  await scroller.evaluate((el) => {
    el.scrollLeft = 300
    el.scrollTop = 200
  })
  const where = await scroller.evaluate((el) => ({ left: el.scrollLeft, top: el.scrollTop }))
  expect(where.left).toBeGreaterThan(200)
  // The row's Edit button stays in sight (frozen) while the fields are scrolled sideways.
  await page
    .locator('tbody tr[data-row]')
    .nth(8)
    .getByRole('button', { name: /^Edit document / })
    .click()
  await page.getByRole('button', { name: 'Back to results' }).click()
  await expect.poll(() => tableScroller(page).evaluate((el) => el.scrollLeft)).toBe(where.left)
  expect(await tableScroller(page).evaluate((el) => el.scrollTop)).toBe(where.top)
})

test('editing a cell in place keeps the columns where they are', async ({ page }, info) => {
  await openCollection(page, 1440, 900)
  const level = page.locator('thead th[data-column="level"]')
  const duration = page.locator('thead th[data-column="durationMs"]')
  const before = { level: (await level.boundingBox())!, duration: (await duration.boundingBox())! }
  await page.locator('tbody tr[data-row]').first().locator('td[data-field="level"]').dblclick()
  const editor = page.locator('[data-test="inline-editor"]')
  await expect(editor).toBeFocused()
  const after = { level: (await level.boundingBox())!, duration: (await duration.boundingBox())! }
  expect(Math.abs(after.level.width - before.level.width)).toBeLessThanOrEqual(1)
  expect(Math.abs(after.duration.x - before.duration.x)).toBeLessThanOrEqual(1)
  // Still room to type: the editor is at least as wide as the cell's text.
  expect((await editor.boundingBox())!.width).toBeGreaterThanOrEqual(56)
  await page.screenshot({ path: info.outputPath('inline-editor.png') })
  await editor.press('Escape')
})

test('the breadcrumb stays readable beside the badges at 1024 px', async ({ page }, info) => {
  await openCollection(page, 1024, 640)
  const bar = page.locator('[data-region="topbar"]')
  const current = bar.getByRole('button', { name: 'Switch collection' })
  await expect(current).toBeVisible()
  const badge = bar.getByText('admin', { exact: true })
  await expect(badge).toBeVisible()
  const crumbs = (await bar.getByRole('navigation', { name: 'Location' }).locator('ol').boundingBox())!
  const badgeBox = (await badge.boundingBox())!
  expect(crumbs.x + crumbs.width).toBeLessThanOrEqual(badgeBox.x)
  const name = current.getByText(COLL, { exact: true })
  const nameBox = (await name.boundingBox())!
  expect(nameBox.x + nameBox.width).toBeLessThanOrEqual(badgeBox.x)
  // Shown whole: not cut short while there is room.
  expect(await name.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
  // The search box narrows first: the database is not cut short either.
  const db = bar.getByRole('button', { name: 'Switch database' }).getByText(DB, { exact: true })
  expect(await db.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
  await page.screenshot({ path: info.outputPath('breadcrumb-1024.png') })
})
