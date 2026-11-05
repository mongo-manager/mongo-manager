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

test.beforeAll(async () => {
  const client = new MongoClient(process.env.MM_E2E_MONGO_URI!)
  try {
    const db = client.db(DB)
    await db.dropDatabase()
    await db
      .collection('reservations')
      .insertMany(Array.from({ length: 60 }, (_, i) => reservation(i + 1)) as never[])
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
}) => {
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
  await expect(docPage(page).locator('[data-test="diff"]')).toContainText('payments')
  await docPage(page).getByRole('button', { name: 'Save changes' }).click()
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

  await title(page).click()
  await page.keyboard.press('Alt+ArrowDown')
  await expect(title(page)).not.toContainText(opened)
  await expect(search).toHaveValue('transfer')
  await expect(counter(page)).toHaveText('1 of 80')
})

test('goes on to the next document after a save took this one out of the query', async ({ page }) => {
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
  const input = docPage(page).locator('[data-tree-editor] input').first()
  await input.fill('paid')
  await input.press('Enter')
  await docPage(page).getByRole('button', { name: 'Review and save' }).click()
  await docPage(page).getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByText('Document saved.')).toBeVisible()
  await expect(docPage(page).locator('[data-stale]')).toBeVisible()
  await docPage(page).getByRole('button', { name: 'Next document' }).click()
  await expect(title(page)).not.toHaveText(first)
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
  } finally {
    await client.close()
  }
})
