// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { Page } from '@playwright/test'
import { MongoClient } from 'mongodb'
import { expect, signIn, test } from '../fixtures'

/**
 * User request 2026-11-04: a document opens as a page, not a drawer — prev and next walk the results,
 * a search finds a value deep in it, the tree edits in place — and a first-time user finds how to
 * open one. The data is invented: reservations of invented guests, nested as real ones are.
 */
const DB = 'docpage'

function reservation(n: number) {
  const id = `R-${String(n).padStart(4, '0')}`
  const payments = Array.from({ length: n >= 58 ? 400 : 3 }, (_, i) => ({
    method: i % 5 === 0 ? 'transfer' : 'card',
    amount: 100 + i,
    refunds: i % 7 === 0 ? [{ amount: 5, reason: { code: 'late', note: { text: 'checked out late' } } }] : [],
  }))
  return {
    _id: id,
    big: n >= 58,
    status: n % 2 ? 'pending' : 'paid',
    guest: {
      name: `Guest ${n}`,
      contact: {
        email: `guest${n}@example.test`,
        address: { city: 'Lakeside', geo: { lat: 40.1, lng: 29.2 } },
      },
    },
    rooms: [
      { number: `${100 + n}`, nights: [{ date: '2026-07-01', rates: [{ base: 120, tax: { amount: 12 } }] }] },
    ],
    payments,
    notes: ['late arrival'],
  }
}

/** An invented stack trace of 40 lines. */
const TRACE = Array.from({ length: 40 }, (_, i) => `    at step${i} (app.js:${i}:1)`).join('\n')

test.beforeAll(async () => {
  const client = new MongoClient(process.env.MM_E2E_MONGO_URI!)
  try {
    const db = client.db(DB)
    await db.dropDatabase()
    await db
      .collection('reservations')
      .insertMany(Array.from({ length: 60 }, (_, i) => reservation(i + 1)) as never[])
    await db
      .collection('logs')
      .insertOne({ _id: 'L-1', trace: TRACE, windows: TRACE.replace(/\n/g, '\r\n') } as never)
  } finally {
    await client.close()
  }
})

async function openCollection(page: Page): Promise<void> {
  await signIn(page)
  await expect(page.getByRole('button', { name: /^Account menu/ })).toBeVisible()
  const list = (await (await page.request.get('api/connections')).json()) as Array<{
    id: string
    name: string
  }>
  const id = list.find((c) => c.name === 'Local test')!.id
  await page.goto(`c/${id}/db/${DB}/coll/reservations`)
  await expect(page.getByRole('button', { name: /^Open document / }).first()).toBeVisible()
}

async function filterBy(page: Page, filter: string): Promise<void> {
  const box = page.getByRole('textbox', { name: 'Filter', exact: true })
  await box.fill(filter)
  await box.press('Enter')
}

const docPage = (page: Page) => page.locator('[data-document-page]')
const title = (page: Page) => docPage(page).locator('h2')
const counter = (page: Page) => docPage(page).locator('[data-match-count]')

test('a first-time user finds Edit and Delete at the start of a row, and opens a document by its _id', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await openCollection(page)
  await expect(page.locator('[data-open-hint]')).toContainText('Edit and Delete are at the start of each row')
  // User report 2026-11-05: in sight without the pointer over the row, before its first field.
  const row = page.locator('tbody tr[data-row]').first()
  const lead = row.locator('[data-row-lead]')
  await expect(lead.getByRole('button', { name: /^Edit document / })).toBeVisible()
  await expect(lead.getByRole('button', { name: /^Delete document / })).toBeVisible()
  await expect(lead.getByRole('button', { name: /^Actions for document / })).toBeVisible()
  const leadBox = (await lead.boundingBox())!
  const idBox = (await row.locator('td[data-field="_id"]').boundingBox())!
  expect(leadBox.x + leadBox.width).toBeLessThanOrEqual(idBox.x + 1)
  await page.screenshot({ path: info.outputPath('row-actions-lead.png') })
  await lead.getByRole('button', { name: /^Edit document / }).click()
  await expect(docPage(page).getByRole('tab', { name: 'Edit' })).toHaveAttribute('aria-selected', 'true')
  await expect(docPage(page).getByRole('textbox', { name: 'Document', exact: true })).toHaveValue(
    /"_id": "R-/,
  )
  await page.getByRole('button', { name: 'Back to results' }).click()
  const started = Date.now()
  await page
    .getByRole('button', { name: /^Open document / })
    .first()
    .click()
  await expect(docPage(page)).toBeVisible()
  expect(Date.now() - started).toBeLessThan(10_000)
  await expect(page.getByRole('complementary')).toHaveCount(0)
  await page.screenshot({ path: info.outputPath('document-page-open.png') })
  await page.getByRole('button', { name: 'Back to results' }).click()
  await page.locator('[data-open-hint]').getByRole('button', { name: 'Got it' }).click()
  await expect(page.locator('[data-open-hint]')).toHaveCount(0)

  // User report 2026-11-07: a dialog opened with its close button's tooltip up, until hovered.
  await page.mouse.move(5, 5)
  await lead.getByRole('button', { name: /^Delete document / }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await page.waitForTimeout(800)
  await expect(page.getByRole('tooltip')).toHaveCount(0)
  await page.screenshot({ path: info.outputPath('dialog-opened.png') })
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
})

// User request 2026-11-05: "freeze the buttons at the start" — the fields scroll sideways under them.
test('keeps the selection box and the row’s actions in place while the fields scroll sideways', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 900, height: 700 })
  await openCollection(page)
  const row = page.locator('tbody tr[data-row]').first()
  const lead = row.locator('[data-row-lead]')
  const box = row.locator('input[type="checkbox"]')
  const before = { lead: (await lead.boundingBox())!, box: (await box.boundingBox())! }
  // These reservations fit the page; a collection of many fields gives a table this wide.
  // (Through the style object: the page's CSP refuses a style attribute.)
  await row.locator('xpath=ancestor::table[1]').evaluate((t) => {
    t.style.minWidth = '3000px'
  })
  const scroller = row.locator(
    'xpath=ancestor::div[contains(concat(" ", @class, " "), " overflow-auto ")][1]',
  )
  const scrolled = await scroller.evaluate((el) => {
    el.scrollLeft = 400
    return { left: el.scrollLeft, wide: el.scrollWidth, shown: el.clientWidth }
  })
  expect(scrolled.left, JSON.stringify(scrolled)).toBeGreaterThan(100)
  const after = { lead: (await lead.boundingBox())!, box: (await box.boundingBox())! }
  expect(after.lead.x).toBeCloseTo(before.lead.x, 0)
  expect(after.box.x).toBeCloseTo(before.box.x, 0)
  // The fields pass under the frozen cells: at the actions' place, the actions are on top, and the
  // header's corner stays over the headers too.
  const [x, y] = [after.lead.x + after.lead.width - 4, after.lead.y + after.lead.height / 2]
  const onTop = await page.evaluate(`!!document.elementFromPoint(${x}, ${y})?.closest('[data-row-lead]')`)
  expect(onTop).toBe(true)
  await page.screenshot({ path: info.outputPath('row-actions-frozen.png') })
})

test('searches a long reservation, edits a payment in the tree, saves, and goes on to the next', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await openCollection(page)
  await filterBy(page, '{ big: true }')
  await expect(page.getByRole('button', { name: /^Open document / })).toHaveCount(3)
  // The first of the three, whatever the order: each holds 400 payments.
  await page
    .getByRole('button', { name: /^Open document / })
    .first()
    .click()
  await expect(title(page)).toContainText('R-00')
  const opened = (await title(page).textContent())!.replace('Document ', '').trim()

  const search = docPage(page).getByRole('searchbox', { name: 'Search in the document' })
  await search.fill('transfer')
  await expect(counter(page)).toHaveText('1 of 80')
  await search.press('Enter')
  await search.press('Enter')
  await expect(counter(page)).toHaveText('3 of 80')
  await expect(
    docPage(page).locator('[role="treeitem"][data-path="payments.10.method"] mark[data-current]'),
  ).toHaveText('transfer')

  const amount = docPage(page).locator('[role="treeitem"][data-path="payments.10.amount"]')
  await amount.click()
  await amount.press('Enter')
  const input = docPage(page).locator('[data-tree-editor] input').first()
  await input.fill('999')
  await input.press('Enter')
  await expect(docPage(page).locator('[data-change-count]')).toHaveText('1 unsaved change')
  await docPage(page).getByRole('button', { name: 'Review and save' }).click()
  // An array is compared whole (the shared diff): the review names it.
  const diff = docPage(page).locator('[data-test="diff"]')
  await expect(diff).toContainText('payments')
  // User request 2026-11-07: the old line beside the new across the page, the rest folded.
  const changed = diff.locator('tr[data-row="mod"]')
  await expect(changed).toHaveCount(1)
  await expect(changed.locator('td').nth(1)).toContainText('amount: 110')
  await expect(changed.locator('td').nth(3)).toContainText('amount: 999')
  await expect(changed.locator('td').nth(3).locator('mark')).toHaveText('999')
  await expect(diff.locator('tr[data-fold]')).toHaveCount(2)
  expect((await changed.locator('td').nth(3).boundingBox())!.width).toBeGreaterThan(500)
  await page.screenshot({ path: info.outputPath('review-diff-1440.png') })

  // User report 2026-11-07, walked as the user did. The views and the search are not over the review.
  await expect(docPage(page).getByRole('tablist')).toHaveCount(0)
  await expect(docPage(page).getByRole('searchbox')).toHaveCount(0)
  // The values changed, in words, over the lines.
  await expect(diff.locator('[data-review-summary]')).toContainText('payments.10.amount')
  // User report 2026-11-07: "the changed line must always be seen", whatever opens or folds.
  const inSight = () => expect(changed).toBeInViewport()
  await diff
    .locator('tr[data-fold]')
    .first()
    .locator('[data-open-above] button, button[data-open-above]')
    .click()
  await inSight()
  // Scrolled up to the fold, as a person would to reach it, and all of it opened.
  const openAll = diff.locator('tr[data-fold]').first().locator('[data-open-all]')
  await openAll.scrollIntoViewIfNeeded()
  await openAll.click()
  await inSight()
  await page.screenshot({ path: info.outputPath('review-diff-opened.png') })
  // Folded again from its top, far from the change.
  await diff.locator('tr[data-hide-row] [data-hide]').first().click()
  await expect(diff.locator('tr[data-fold]')).toHaveCount(2)
  await inSight()
  // The 2505 lines after it opened, then every line.
  await diff.locator('tr[data-fold]').last().locator('[data-open-all]').click()
  await inSight()
  await diff.locator('[data-review-all]').click()
  await expect(diff.locator('tr[data-fold]')).toHaveCount(0)
  await inSight()
  // Scrolled away by hand: a button brings the change back.
  const content = diff.locator('[data-document-content]')
  await content.evaluate((el) => (el.scrollTop = el.scrollHeight))
  await expect(changed).not.toBeInViewport()
  const back = diff.locator('[data-back-to-change]')
  await expect(back).toBeVisible()
  await expect(back).toContainText('Back to the change')
  await page.screenshot({ path: info.outputPath('review-diff-away.png') })
  await back.click()
  await inSight()
  await expect(back).toHaveCount(0)
  // The map at the side shows where the change is; a press on it scrolls there, N comes back.
  const map = diff.locator('[data-change-map]')
  await expect(map.locator('.bg-info, .bg-danger, .bg-success')).not.toHaveCount(0)
  const mapBox = (await map.boundingBox())!
  await page.mouse.click(mapBox.x + mapBox.width / 2, mapBox.y + mapBox.height - 4)
  await expect(changed).not.toBeInViewport()
  await page.keyboard.press('n')
  await inSight()
  await expect(changed).toHaveAttribute('data-current', 'true')
  await diff.locator('[data-review-all]').click()
  await expect(diff.locator('tr[data-fold]')).toHaveCount(2)
  await inSight()
  await page.screenshot({ path: info.outputPath('review-diff-back.png') })

  // User request 2026-11-07: writing the whole document is a choice that changes the review.
  await diff.getByRole('radio', { name: /The whole document/ }).check()
  await expect(diff.locator('[data-review-field]')).toHaveCount(1)
  await expect(diff.locator('[data-review-field]')).toHaveAttribute('data-kind', 'replaced')
  await expect(diff.locator('[data-rewritten]')).toContainText('fields you did not change')
  await expect(diff.locator('[data-rewritten] code')).toHaveText(['big', 'status', 'guest', 'rooms', 'notes'])
  await expect(diff.locator('[data-review-bar] h2')).toContainText('The whole document')
  await expect(docPage(page).getByRole('button', { name: 'Replace document' })).toBeVisible()
  await expect(diff.locator('[data-review-summary]')).toContainText('payments.10.amount')
  await page.screenshot({ path: info.outputPath('review-diff-whole.png') })
  await diff.getByRole('radio', { name: /Only the changed fields/ }).check()
  await expect(diff.locator('[data-review-field]')).toHaveAttribute('data-kind', 'changed')
  await expect(docPage(page).getByRole('button', { name: 'Save changes' })).toBeVisible()

  await diff.getByRole('radio', { name: 'Unified' }).click()
  await expect(diff.locator('table')).toHaveAttribute('data-layout', 'unified')
  await expect(diff.locator('tr[data-row="del"]')).toContainText('amount: 110')
  await expect(diff.locator('tr[data-row="add"]')).toContainText('amount: 999')
  await page.screenshot({ path: info.outputPath('review-diff-unified.png') })
  // The same in the dark theme (the review's colours are the theme's).
  await page.getByRole('button', { name: 'Switch to dark theme' }).click()
  await page.screenshot({ path: info.outputPath('review-diff-unified-dark.png') })
  await page.getByRole('button', { name: 'Switch to light theme' }).click()
  await diff.locator('[role="region"]').focus()
  // Saved from the keyboard.
  await page.keyboard.press('Control+Enter')
  await expect(page.getByText('Document saved.')).toBeVisible()

  const client = new MongoClient(process.env.MM_E2E_MONGO_URI!)
  try {
    const saved = await client
      .db(DB)
      .collection('reservations')
      .findOne({ _id: opened as never })
    expect((saved!.payments as Array<{ amount: number }>)[10]!.amount).toBe(999)
    expect((saved!.payments as unknown[]).length).toBe(400)
  } finally {
    await client.close()
  }

  // User report 2026-11-07: the save goes back to the results, the saved document marked there.
  await expect(docPage(page)).toHaveCount(0)
  await expect(page.locator('tbody tr[data-last-opened]')).toContainText(opened)
  await expect(page.getByText('no longer matches the query')).toHaveCount(0)
  await page.screenshot({ path: info.outputPath('saved-back-to-results.png') })
})

test('says so when a save took the document out of the query, back at the results', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await openCollection(page)
  await filterBy(page, "{ status: 'pending', big: false }")
  await page
    .getByRole('button', { name: /^Open document / })
    .first()
    .click()
  const first = (await title(page).textContent())!.trim()
  const status = docPage(page).locator('[role="treeitem"][data-path="status"]')
  await status.click()
  await status.press('Enter')
  const input = docPage(page).locator('[data-tree-editor] textarea').first()
  await input.fill('paid')
  await input.press('Enter')
  await docPage(page).getByRole('button', { name: 'Review and save' }).click()
  await docPage(page).getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByText('Document saved.')).toBeVisible()
  await expect(page.getByText('The saved document no longer matches the query')).toBeVisible()
  await expect(docPage(page)).toHaveCount(0)
  await expect(
    page.locator('tbody tr[data-row]').filter({ hasText: first.replace('Document ', '') }),
  ).toHaveCount(0)
})

// Review 2026-11-07 (critical): a one-line box saved a 40-line stack trace as one line, and the
// review, cut after 200 characters, did not show it.
test('changes a line of a stack trace in the tree, its line breaks kept, the change shown before the save', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await signIn(page)
  await expect(page.getByRole('button', { name: /^Account menu/ })).toBeVisible()
  const list = (await (await page.request.get('api/connections')).json()) as Array<{
    id: string
    name: string
  }>
  await page.goto(`c/${list.find((c) => c.name === 'Local test')!.id}/db/${DB}/coll/logs`)
  await page
    .getByRole('button', { name: /^Open document / })
    .first()
    .click()
  for (const field of ['trace', 'windows']) {
    const line = docPage(page).locator(`[role="treeitem"][data-path="${field}"]`)
    await line.click()
    await line.press('Enter')
    const box = docPage(page).locator('[data-tree-editor] textarea')
    // The browser gives every break back as \n, the Windows ones too.
    await expect(box).toHaveValue(TRACE)
    await box.fill(TRACE.replace('step30', 'retry30'))
    await box.press('Enter')
    await expect(box).toHaveCount(0)
  }
  await docPage(page).getByRole('button', { name: 'Review and save' }).click()
  const diff = docPage(page).locator('[data-test="diff"]')
  await expect(diff.locator('mark')).toHaveCount(4)
  await expect(diff).toContainText('retry30 (app.js:30:1)')
  await docPage(page).getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByText('Document saved.')).toBeVisible()

  const client = new MongoClient(process.env.MM_E2E_MONGO_URI!)
  try {
    const saved = await client
      .db(DB)
      .collection('logs')
      .findOne({ _id: 'L-1' as never })
    expect(saved!.trace).toBe(TRACE.replace('step30', 'retry30'))
    expect(saved!.windows).toBe(TRACE.replace('step30', 'retry30').replace(/\n/g, '\r\n'))
  } finally {
    await client.close()
  }
})

for (const size of [
  { width: 1024, height: 768 },
  { width: 768, height: 1024 },
]) {
  test(`fits the page at ${size.width}×${size.height}, nothing over anything`, async ({ page }, info) => {
    await page.setViewportSize(size)
    await openCollection(page)
    await page
      .getByRole('button', { name: /^Open document / })
      .first()
      .click()
    await expect(docPage(page)).toBeVisible()
    const problems = (await page.evaluate(`(() => {
      const out = []
      if (document.documentElement.scrollWidth > window.innerWidth) out.push('page scrolls sideways')
      for (const el of document.querySelectorAll('[data-document-page], [data-document-page] *'))
        if (getComputedStyle(el).position === 'fixed') out.push('fixed: ' + el.tagName + '.' + el.className)
      return out
    })()`)) as string[]
    expect(problems).toEqual([])
    await page.screenshot({ path: info.outputPath(`document-page-${size.width}.png`) })
  })
}

test('opens every action of a row with a right click', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await openCollection(page)
  await page
    .locator('tbody tr[data-row]')
    .first()
    .locator('td[data-field="status"]')
    .click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Edit', exact: true }).click()
  await expect(docPage(page)).toBeVisible()
  await expect(docPage(page).getByRole('tab', { name: 'Edit' })).toHaveAttribute('aria-selected', 'true')
})

// User report 2026-11-05: an image as base64 dragged the edit view. Its text shows the value by its
// size, and a save of another field leaves the image as it was, byte for byte.
test('edits beside a base64 image, which the text shows by its size and the save keeps whole', async ({
  page,
}) => {
  const photo = `data:image/png;base64,${Buffer.alloc(300_000, 7).toString('base64')}`
  const client = new MongoClient(process.env.MM_E2E_MONGO_URI!)
  try {
    await client.db(DB).collection('guests').deleteMany({})
    await client
      .db(DB)
      .collection('guests')
      .insertOne({ _id: 'G-1' as never, name: 'Guest 1', photo })
    await page.setViewportSize({ width: 1440, height: 900 })
    await signIn(page)
    await expect(page.getByRole('button', { name: /^Account menu/ })).toBeVisible()
    const list = (await (await page.request.get('api/connections')).json()) as Array<{
      id: string
      name: string
    }>
    await page.goto(`c/${list.find((c) => c.name === 'Local test')!.id}/db/${DB}/coll/guests`)
    await page.getByRole('button', { name: 'Edit document G-1' }).click()
    const text = docPage(page).getByRole('textbox', { name: 'Document', exact: true })
    await expect(text).toHaveValue(/"photo": "⟨391 KB · [0-9a-f]{16}⟩"/)
    expect((await text.inputValue()).length).toBeLessThan(400)
    await text.fill((await text.inputValue()).replace('"Guest 1"', '"Guest One"'))
    await docPage(page).getByRole('button', { name: 'Review and save' }).click()
    await docPage(page).getByRole('button', { name: 'Save changes' }).click()
    await expect(page.getByText('Document saved.')).toBeVisible()
    const saved = await client
      .db(DB)
      .collection('guests')
      .findOne({ _id: 'G-1' as never })
    expect(saved!.name).toBe('Guest One')
    expect(saved!.photo).toBe(photo)
  } finally {
    await client.close()
  }
})

// User report 2026-11-05: "in the edit view, scrolling freezes" — a service record with a signature
// as base64, under the length the text folds, wrapped over a hundred rows. The text and its colours
// scroll as one box, a search's match after the signature comes into sight, and typing at the end
// keeps the caret in sight.
test('scrolls the text of a document with a long signature as one, and finds what comes after it', async ({
  page,
}) => {
  const signature = Buffer.alloc(7_000, 'mm-signature').toString('base64')
  const client = new MongoClient(process.env.MM_E2E_MONGO_URI!)
  try {
    await client.db(DB).collection('services').deleteMany({})
    await client
      .db(DB)
      .collection('services')
      .insertOne({ _id: 106 as never, complaint: 'no sound', signature, deliveredBy: 'front desk' })
    await page.setViewportSize({ width: 1440, height: 900 })
    await signIn(page)
    await expect(page.getByRole('button', { name: /^Account menu/ })).toBeVisible()
    const list = (await (await page.request.get('api/connections')).json()) as Array<{
      id: string
      name: string
    }>
    await page.goto(`c/${list.find((c) => c.name === 'Local test')!.id}/db/${DB}/coll/services`)
    await page.getByRole('button', { name: 'Edit document 106' }).click()
    const text = docPage(page).getByRole('textbox', { name: 'Document', exact: true })
    await expect(text).toHaveValue(/"signature": "bW0t/)
    const scroller = docPage(page).locator('[data-code-scroller]')
    const colours = scroller.locator('pre[aria-hidden="true"]')
    const tops = async () => [(await text.boundingBox())!.y, (await colours.boundingBox())!.y]

    const box = (await scroller.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    for (let i = 0; i < 8; i++) await page.mouse.wheel(0, 240)
    await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(500)
    const [textTop, coloursTop] = await tops()
    expect(textTop).toBeCloseTo(coloursTop!, 0)
    expect(await text.evaluate((el) => el.scrollTop)).toBe(0)

    // User report 2026-11-07: the field was only as tall as the box, so the end of a long document
    // could be scrolled to but not clicked or changed. It is as tall as its text.
    const textHeight = (await text.boundingBox())!.height
    expect(textHeight).toBeGreaterThan(box.height)
    expect(textHeight).toBeCloseTo((await colours.boundingBox())!.height, 0)
    await scroller.evaluate((el) => (el.scrollTop = el.scrollHeight))
    await page.mouse.click(box.x + 40, box.y + box.height - 24)
    await expect(text).toBeFocused()
    const caret = await text.evaluate((el) => (el as unknown as { selectionStart: number }).selectionStart)
    expect(caret).toBeGreaterThan((await text.inputValue()).length - 40)

    await scroller.evaluate((el) => (el.scrollTop = 0))
    await docPage(page).getByRole('searchbox', { name: 'Search in the document' }).fill('front desk')
    await expect(counter(page)).toHaveText('1 of 1')
    const mark = scroller.locator('mark[data-current]')
    await expect(mark).toHaveText(/front/)
    await expect
      .poll(async () => {
        const at = (await mark.first().boundingBox())!
        const frame = (await scroller.boundingBox())!
        return at.y >= frame.y && at.y + at.height <= frame.y + frame.height
      })
      .toBe(true)

    await scroller.evaluate((el) => (el.scrollTop = 0))
    await text.click({ position: { x: 20, y: 12 } })
    await page.keyboard.press('Control+End')
    await page.keyboard.type(' ')
    await expect
      .poll(() => scroller.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop))
      .toBeLessThan(40)
    // Review 2026-11-07: the first key that makes the text invalid shows the error under the box a
    // moment later, which shrinks it; the caret stays in sight.
    await page.keyboard.type('X')
    await expect(text).toHaveAttribute('aria-invalid', 'true')
    await expect
      .poll(() => scroller.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop))
      .toBeLessThan(40)
  } finally {
    await client.close()
  }
})

/**
 * Where the colours draw the caret's line: the field's own caret cannot be measured. As text: this
 * package is typed without the DOM.
 */
const caretLine = (page: Page) =>
  page.evaluate<{ top: number; bottom: number }>(`(() => {
    const box = document.querySelector('[data-document-page] [data-code-scroller]')
    const area = box.querySelector('textarea')
    const walker = document.createTreeWalker(box.querySelector('pre'), NodeFilter.SHOW_TEXT)
    let left = area.selectionStart
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (left < node.length) {
        const range = document.createRange()
        range.setStart(node, left)
        range.setEnd(node, left + 1)
        const at = range.getBoundingClientRect()
        return { top: at.top, bottom: at.bottom }
      }
      left -= node.length
    }
    return null
  })()`)

// Review 2026-11-07: an undo, a redo and Format went to the page's history, which wrote the text
// again — the caret went to its end and the box with it. The suggestions opened under the whole
// editor, out of the page.
test('keeps the caret where an undo or Format changed the text, and opens suggestions at the caret', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await openCollection(page)
  await filterBy(page, '{ _id: "R-0060" }')
  await page.getByRole('button', { name: 'Edit document R-0060' }).click()
  const text = docPage(page).getByRole('textbox', { name: 'Document', exact: true })
  await expect(text).toHaveValue(/"Guest 60"/)
  const scroller = docPage(page).locator('[data-code-scroller]')
  type Field = { selectionStart: number; setSelectionRange(from: number, to: number): void }
  const caret = () => text.evaluate((el) => (el as unknown as Field).selectionStart)
  const scrolled = () => scroller.evaluate((el) => el.scrollTop)
  // A new editor's caret is at the start: Tab into it showed the end of the document.
  expect(await caret()).toBe(0)

  const at = (await text.inputValue()).indexOf('Guest 60') + 'Guest 60'.length
  await text.click({ position: { x: 20, y: 12 } })
  await text.evaluate((el, to) => (el as unknown as Field).setSelectionRange(to, to), at)
  await page.keyboard.type('Z')
  await expect(text).toHaveValue(/"Guest 60Z"/)
  await page.keyboard.press('Control+z')
  await expect(text).toHaveValue(/"Guest 60"/)
  expect(await caret()).toBe(at)
  expect(await scrolled()).toBeLessThan(100)
  await page.keyboard.press('Control+y')
  await expect(text).toHaveValue(/"Guest 60Z"/)
  expect(await caret()).toBe(at + 1)
  expect(await scrolled()).toBeLessThan(100)

  // A line out of shape near the top: Format writes it again, and the box stays there.
  await page.keyboard.press('Home')
  await page.keyboard.type('   ')
  await docPage(page).locator('[data-format]').click()
  await expect(text).toBeFocused()
  await expect(text).toHaveValue(/\n {4}"name": "Guest 60Z"/)
  const name = (await text.inputValue()).indexOf('"name": "Guest 60Z"')
  expect(Math.abs((await caret()) - name)).toBeLessThan(8)
  expect(await scrolled()).toBeLessThan(100)

  // Ctrl+Space where a key goes: the list opens at the caret, whole, in the window.
  await page.keyboard.press('Control+Home')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Control+Space')
  const list = page.getByRole('listbox', { name: 'Suggestions' })
  await expect(list).toBeVisible()
  await expect(list).toBeInViewport({ ratio: 1 })
  const line = await caretLine(page)
  const placed = (await list.boundingBox())!
  expect(placed.y).toBeGreaterThanOrEqual(line.bottom)
  expect(placed.y).toBeLessThan(line.bottom + 12)
  await expect(text).toHaveAttribute('aria-activedescendant', /-0$/)
  // ArrowUp goes round to the last suggestion: the list scrolls to it, nothing else does.
  const content = docPage(page).locator('[data-document-content]')
  const contentTop = await content.evaluate((el) => el.scrollTop)
  await page.keyboard.press('ArrowUp')
  await expect(list.getByRole('option').last()).toBeInViewport({ ratio: 1 })
  expect(await content.evaluate((el) => el.scrollTop)).toBe(contentTop)
  expect(await scrolled()).toBeLessThan(100)
  const last = list.getByRole('option').last()
  const chosen = (await last.locator('span').first().textContent())!.trim()
  await last.click()
  await expect(list).toHaveCount(0)
  expect(await text.inputValue()).toContain(chosen)
})

// Review 2026-11-07: a one-line field grows with the rows a long value wraps into (up to six); a
// projection that wrapped showed its first row only.
test('shows every row of a long projection that wraps', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 })
  await openCollection(page)
  const options = page.getByRole('button', { name: /^Options(, \d+ set)?$/ })
  if ((await options.getAttribute('aria-expanded')) !== 'true') await options.click()
  const projection = page.getByRole('textbox', { name: 'Project', exact: true })
  await projection.fill('{ status: 1, "guest.name": 1, rooms: 1, notes: 1 }')
  const box = projection.locator('xpath=..')
  const colours = box.locator('pre[aria-hidden="true"]')
  // Two rows or more (each 20 pixels, and the padding), fewer than the six the field grows to.
  await expect.poll(async () => (await colours.boundingBox())!.height).toBeGreaterThan(50)
  expect((await colours.boundingBox())!.height).toBeLessThan(6 * 20 + 16)
  // Nothing of it is hidden in the box: the box is as tall as the rows it is drawn in.
  expect(await box.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1)
})
