// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { readFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import type { Page } from '@playwright/test'
import { parseConnectionUri } from '../../../shared/src/connections'
import { expect, localHeaders, test } from '../../fixtures'

/**
 * Plugins wave 3 (design): test data handed to
 * the Import wizard and imported, the data dictionary saved, a reshape handed to Aggregations, a log
 * file analysed in the browser, binary values and dates told in their cells with an image gallery,
 * and the core data model's marks and Mermaid export — in Chrome, on real data.
 */
const WAVE3 = ['mock-data', 'data-dictionary', 'reshape', 'log-analyzer', 'binary-preview', 'local-time']
/** A 32 × 32 PNG avatar, as Test data makes them. */
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAYklEQVR42u3UsREAEAyF4beBTZVWM4izj55DDkkU7y71/xUSCCmqDggQMANyLd28BMa63MBxXWjgpi4xCHwPqG+RxR1YXDJ/U+c3UFxTyZVtGdzX1wae1BeGB3BWnxkE/IEG5Q5opGwhzU8AAAAASUVORK5CYII='

async function api(page: Page, method: 'GET' | 'POST', path: string, data?: object) {
  const local = await localHeaders(page)
  const me = await (await page.request.get('api/auth/me', { headers: local })).json()
  const res = await page.request.fetch(`api/${path}`, {
    method,
    ...(data ? { data } : {}),
    headers: { ...local, 'x-csrf-token': me.csrfToken, origin: new URL(page.url()).origin },
  })
  expect(res.ok(), await res.text()).toBe(true)
  return res.json()
}
async function approve(page: Page, id: string): Promise<void> {
  const card = page.locator(`[data-plugin="${id}"]`)
  await card.getByRole('button', { name: 'Approve and enable' }).click()
  await page.locator('[data-test="confirm"]').click()
  await expect(card.locator('[data-plugin-status]')).toHaveText('Enabled')
}
/** Left as found for the tests after this one, even when this one fails halfway. */
async function disableAll(page: Page, ids: string[]): Promise<void> {
  await page.goto('/plugins')
  for (const id of ids) {
    const disable = page.locator(`[data-plugin="${id}"]`).getByRole('button', { name: 'Disable' })
    if (await disable.isVisible()) await disable.click()
  }
}
test.afterEach(async ({ page }) => disableAll(page, WAVE3))
const section = (page: Page, name: string) =>
  page.getByRole('tablist', { name: 'Collection sections' }).getByRole('tab', { name, exact: true })
const frame = (page: Page) => page.frameLocator('[data-plugin-frame] iframe:visible')
/**
 * Wave 3 second review: a file or documents asked for within 5 seconds of a press in the app's own
 * page (a tab clicked) are asked about first — the unit tests cover that question; here the press
 * is left behind, so the plugin's own click is taken as it is.
 */
const pastAppPress = (page: Page) => page.waitForTimeout(5_200)
const shot = async (page: Page, name: string) => {
  if (process.env.MM_UI_REVIEW) await page.screenshot({ path: `test-results/ui-review/w3-${name}.png` })
}

/** A mongod log of 4.4 and later: a slow scan, a warning, a connection. */
const LOG = [
  {
    t: { $date: '2026-10-26T10:00:00.000Z' },
    s: 'I',
    c: 'CONTROL',
    id: 23403,
    msg: 'Build Info',
    attr: { buildInfo: { version: '8.0.4' } },
  },
  {
    t: { $date: '2026-10-26T10:01:00.000Z' },
    s: 'I',
    c: 'COMMAND',
    id: 51803,
    msg: 'Slow query',
    attr: {
      type: 'command',
      ns: 'wave3.people',
      command: { find: 'people', filter: { email: 'ada@example.com' } },
      planSummary: 'COLLSCAN',
      docsExamined: 900,
      nreturned: 1,
      durationMillis: 640,
    },
  },
  { t: { $date: '2026-10-26T10:02:00.000Z' }, s: 'W', c: 'STORAGE', id: 20001, msg: 'Low disk' },
  {
    t: { $date: '2026-10-26T10:02:00.000Z' },
    s: 'I',
    c: 'NETWORK',
    id: 22943,
    msg: 'Connection accepted',
    attr: { remote: '10.0.0.1:51000', connectionCount: 4 },
  },
]
  .map((l) => JSON.stringify(l))
  .join('\n')

test('the wave 3 plugins, each on real data, and the data model’s marks and Mermaid', async ({ page }) => {
  test.setTimeout(300_000)
  await page.goto('/')
  const { id } = (await api(page, 'POST', 'connections', {
    name: 'Wave 3',
    favorite: false,
    readOnly: false,
    settings: parseConnectionUri(process.env.MM_E2E_MONGO_URI!),
  })) as { id: string }
  // A database left by an earlier run never counts (wave 3 review).
  const local = await localHeaders(page)
  const me = await (await page.request.get('api/auth/me', { headers: local })).json()
  await page.request.fetch(`api/connections/${id}/databases/wave3`, {
    method: 'DELETE',
    data: { confirm: 'wave3' },
    headers: { ...local, 'x-csrf-token': me.csrfToken, origin: new URL(page.url()).origin },
  })
  const docs = (coll: string) => `connections/${id}/databases/wave3/collections/${coll}/documents`
  const people = [0, 1, 2].map((i) => ({
    _id: { $oid: `65a1b2c3d4e5f60718293b0${i}` },
    name: ['Ada', 'Grace', 'Linus'][i],
    email: `user${i}@example.com`,
    status: ['active', 'left', 'active'][i],
    createdAt: { $date: new Date(Date.UTC(2026, 0, 5 + i, 10)).toISOString() },
    avatar: { $binary: { base64: PNG, subType: '00' } },
    address: { city: ['Izmir', 'Ankara', 'Bursa'][i], zip: `3500${i}` },
  }))
  await api(page, 'POST', docs('people'), { documents: people })
  await api(page, 'POST', docs('orders'), {
    documents: [
      { userId: people[0]!._id, total: 5 },
      { userId: people[1]!._id, total: 7 },
    ],
  })
  // A unique and a plain index: the model marks them UQ and IX.
  const indexes = `connections/${id}/databases/wave3/collections/people/indexes`
  await api(page, 'POST', indexes, { key: { email: 1 }, options: { unique: true } })
  await api(page, 'POST', indexes, { key: { status: 1 }, options: {} })
  await expect
    .poll(
      async () => ((await api(page, 'GET', indexes)) as Array<{ name: string }>).map((ix) => ix.name).sort(),
      {
        timeout: 30_000,
      },
    )
    .toEqual(['_id_', 'email_1', 'status_1'])
  await page.goto('/plugins')
  for (const plugin of WAVE3) await approve(page, plugin)

  const url = `c/${id}/db/wave3/coll/people`
  await page.goto(url)
  // Local time and binary preview: what a date and a binary value are, in their cells' tooltips.
  const tooltip = page.getByRole('tooltip', { includeHidden: true })
  await page.locator('td[data-field="createdAt"]').first().hover()
  await expect(tooltip).toContainText(/Local time: .*\(UTC/)
  await page.locator('td[data-field="avatar"]').first().hover()
  await expect(tooltip).toContainText('Binary preview: PNG image · 32 × 32')

  // Binary preview: the images of the documents, one opened large.
  await section(page, 'Images').click()
  await expect(frame(page).locator('#gallery img')).toHaveCount(3)
  await shot(page, 'images')
  await frame(page).locator('.bp-thumb').first().click()
  await expect(frame(page).locator('#large')).toBeVisible()
  await frame(page).locator('#close').click()

  // Test data: five documents shaped like these, handed to the Import wizard and imported.
  await section(page, 'Test data').click()
  await expect(frame(page).locator('#fields tbody tr[data-plan="email"]')).toBeVisible()
  await frame(page).locator('#count').fill('5')
  await frame(page).locator('#count').press('Tab')
  await expect(frame(page).locator('#preview')).toContainText('@')
  await shot(page, 'test-data')
  await pastAppPress(page)
  await frame(page).locator('#insert').click()
  const wizard = page.getByRole('dialog')
  await expect(wizard).toContainText('Documents from Test data (mock-data)')
  await wizard.getByRole('button', { name: 'Next', exact: true }).click()
  await wizard.getByRole('button', { name: 'Next', exact: true }).click()
  await wizard.getByRole('button', { name: 'Import', exact: true }).click()
  await expect
    .poll(
      async () =>
        (
          (await api(page, 'POST', `connections/${id}/databases/wave3/collections/people/count`, {
            filter: {},
          })) as {
            count: number
          }
        ).count,
      { timeout: 60_000 },
    )
    .toBe(8)
  await page.keyboard.press('Escape')

  // Reshape: an object flattened, previewed, then handed to Aggregations.
  await page.goto(url)
  await section(page, 'Reshape').click()
  await frame(page).locator('#kind').selectOption('flatten')
  await frame(page).locator('#add-step').click()
  await expect(frame(page).locator('#after')).toContainText('address_city')
  // A nest's fields ticked in their list (2026-10-26 user report: they were drawn over each other).
  await frame(page).locator('#kind').selectOption('nest')
  await frame(page).locator('#add-step').click()
  const nest = frame(page).locator('[data-step="nest"]')
  await nest.getByRole('checkbox', { name: 'name', exact: true }).check()
  await nest.getByRole('checkbox', { name: 'email', exact: true }).check()
  await expect(nest.locator('[data-picked]')).toContainText('Chosen: 2 of')
  await nest.getByRole('textbox', { name: 'Into' }).fill('contact')
  await nest.getByRole('textbox', { name: 'Into' }).press('Tab')
  await expect(frame(page).locator('#after')).toContainText('contact')
  await shot(page, 'reshape')
  await frame(page).locator('#use').click()
  // In Aggregations, as a stage of its own (wave 3 review: never only the question's text).
  await expect(section(page, 'Aggregations')).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('[data-stage]').first()).toContainText('address_city')

  // Data dictionary: the database documented, saved as Markdown.
  await page.goto(url)
  await section(page, 'Data dictionary').click()
  const dictionary = frame(page).locator('section[data-collection="people"]')
  await expect(dictionary).toContainText('address.city')
  await expect(dictionary).toContainText('_id_')
  // Keys as names, never as the bridge's Extended JSON (wave 3 review).
  await expect(dictionary).not.toContainText('$numberInt')
  await shot(page, 'dictionary')
  const [markdown] = await Promise.all([
    page.waitForEvent('download'),
    pastAppPress(page).then(() => frame(page).locator('#save-markdown').click()),
  ])
  expect(markdown.suggestedFilename()).toBe('wave3-dictionary.md')
  expect(readFileSync(await markdown.path(), 'utf8')).toContain('## people')
  // As a page: the app's own policy first, no script.
  const [html] = await Promise.all([
    page.waitForEvent('download'),
    pastAppPress(page).then(() => frame(page).locator('#save-html').click()),
  ])
  expect(html.suggestedFilename()).toBe('wave3-dictionary.html')
  const page_ = readFileSync(await html.path(), 'utf8')
  expect(page_.startsWith('<!doctype html>')).toBe(true)
  expect(page_).toContain("default-src 'none'")
  expect(page_).not.toContain('<script')
  expect(page_).toContain('people')

  // Log analyzer: a log file read in the browser, its slow scan and warning found.
  await page.locator('[data-sidebar-plugin-page]', { hasText: 'Log analyzer' }).click()
  const logs = frame(page)
  await logs
    .locator('#file')
    .setInputFiles({ name: 'mongod.log', mimeType: 'text/plain', buffer: Buffer.from(LOG) })
  await expect(logs.locator('#summary')).toContainText('8.0.4')
  await expect(logs.locator('tr[data-shape]').first()).toContainText('COLLSCAN')
  await expect(logs.locator('#messages')).toContainText('Low disk')
  await shot(page, 'logs')
  // No value of the log is shown until its example is asked for.
  await expect(logs.locator('body')).not.toContainText('ada@example.com')
  // Third review: a rotated log joined from two gzip parts is read whole in Chromium, whose
  // decompressor stops after the first part.
  const joined = Buffer.concat([gzipSync(Buffer.from(`${LOG}\n`)), gzipSync(Buffer.from(`${LOG}\n`))])
  await logs.locator('#another').click()
  await logs
    .locator('#file')
    .setInputFiles({ name: 'mongod.log.gz', mimeType: 'application/gzip', buffer: joined })
  await expect(logs.getByText(/mongod\.log\.gz: 8 lines/)).toBeVisible()
  // 2026-10-26 (user report): the sort changes the slow operations' order in Chromium too.
  const slow = (field: string, ms: number) =>
    JSON.stringify({
      t: { $date: '2026-10-26T10:01:00.000Z' },
      s: 'I',
      c: 'COMMAND',
      id: 51803,
      msg: 'Slow query',
      attr: {
        type: 'command',
        ns: 'wave3.people',
        command: { find: 'people', filter: { [field]: 1 } },
        planSummary: 'IXSCAN { x: 1 }',
        durationMillis: ms,
      },
    })
  const sorted = [
    ...Array.from({ length: 4 }, () => slow('often', 120)),
    slow('rare', 400),
    slow('mid', 210),
    slow('mid', 210),
  ].join('\n')
  await logs.locator('#another').click()
  await logs
    .locator('#file')
    .setInputFiles({ name: 'sorted.log', mimeType: 'text/plain', buffer: Buffer.from(sorted) })
  const order = () =>
    logs
      .locator('tr[data-shape]')
      .evaluateAll((rows) =>
        rows.map((r) => ['often', 'rare', 'mid'].find((f) => r.getAttribute('data-shape')!.includes(f))),
      )
  await expect.poll(order).toEqual(['often', 'mid', 'rare'])
  for (const [value, expected] of [
    ['count', ['often', 'mid', 'rare']],
    ['max', ['rare', 'mid', 'often']],
    ['p95', ['rare', 'mid', 'often']],
    ['total', ['often', 'mid', 'rare']],
  ] as const) {
    await logs.locator(`#sort [data-value="${value}"]`).click()
    await expect(logs.locator(`#sort [data-value="${value}"]`)).toHaveAttribute('aria-checked', 'true')
    await expect.poll(order).toEqual(expected)
    if (value === 'p95') await shot(page, 'logs-sorted')
  }
  // A measure's column header sorts by it too, and is marked as the column sorted by.
  await logs.locator('thead button[data-sort="max"]').click()
  await expect.poll(order).toEqual(['rare', 'mid', 'often'])
  await expect(logs.locator('#sort [data-value="max"]')).toHaveAttribute('aria-checked', 'true')
  await expect(logs.locator('thead th[aria-sort="descending"]')).toHaveText('Max')

  // The core data model: keys, indexes and the Mermaid export.
  await page.goto(`c/${id}/db/wave3`)
  await page.getByRole('tablist', { name: 'Database sections' }).getByRole('tab', { name: 'Model' }).click()
  await page.getByRole('button', { name: 'Read the model' }).click()
  await expect(page.locator('[data-node="people"] [data-mark="pk"]')).toBeVisible()
  await expect(page.locator('[data-node="people"] [data-mark="unique"]')).toHaveCount(1)
  await expect(page.locator('[data-node="people"] [data-mark="index"]')).toHaveCount(1)
  await expect(page.locator('[data-edge][data-kind="reference"]').first()).toHaveAttribute(
    'marker-start',
    /many/,
  )
  // 2026-10-26 (user report): a box dragged moves alone; the diagram and the other boxes stay.
  const box = page.locator('[data-node="people"] rect')
  const other = page.locator('[data-node="orders"] rect')
  const x0 = Number(await box.getAttribute('x'))
  const y0 = Number(await box.getAttribute('y'))
  const otherX = await other.getAttribute('x')
  const view = await page.locator('[data-model-scene]').getAttribute('transform')
  const held = (await box.boundingBox())!
  await page.mouse.move(held.x + 40, held.y + 12)
  await page.mouse.down()
  await page.mouse.move(held.x + 140, held.y + 72, { steps: 8 })
  await page.mouse.up()
  await expect.poll(async () => Number(await box.getAttribute('x'))).toBeGreaterThan(x0 + 40)
  expect(Number(await box.getAttribute('y'))).toBeGreaterThan(y0 + 20)
  await expect(other).toHaveAttribute('x', otherX!)
  await expect(page.locator('[data-model-scene]')).toHaveAttribute('transform', view!)
  await expect(page.locator('[data-model-reset]')).toBeVisible()
  // A box pressed with the mouse shows no focus ring (Chrome drew its own on an SVG box); Tab does.
  // As text: this package is typed without the DOM.
  const ring = () =>
    page.evaluate<string>(`(() => {
      const el = document.activeElement
      if (!el || !el.getAttribute('data-node')) return 'not a box'
      const s = getComputedStyle(el)
      return s.outlineStyle === 'none' || s.outlineColor === 'rgba(0, 0, 0, 0)' ? 'hidden' : 'shown'
    })()`)
  expect(await ring()).toBe('hidden')
  await page.keyboard.press('Shift+Tab')
  await page.keyboard.press('Tab')
  expect(await ring()).toBe('shown')
  await shot(page, 'model')
  await page.getByRole('button', { name: 'Export' }).click()
  const [mermaid] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('menuitem', { name: 'Mermaid (ER diagram)' }).click(),
  ])
  expect(mermaid.suggestedFilename()).toBe('wave3-model.mmd')
  const text = readFileSync(await mermaid.path(), 'utf8')
  expect(text).toContain('erDiagram')
  expect(text).toContain('people ||--o{ orders : "userId"')
  expect(text).toContain('string email UK')
  expect(text).toContain('string status "indexed"')

  // The same screens in dark Turkish, for review only.
  if (!process.env.MM_UI_REVIEW) return
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
  await page.evaluate(() => {
    localStorage.setItem('mm:preferences', JSON.stringify({ theme: 'dark', locale: 'tr' }))
    localStorage.removeItem('mm:tabs')
  })
  const tab = (name: string) =>
    page.locator('[role="tab"]', { hasText: new RegExp(`^\\s*${name}\\s*$`) }).first()
  const settle = () => page.evaluate('new Promise((r) => setTimeout(() => requestAnimationFrame(r), 600))')
  for (const [name, file] of [
    ['Görseller', 'images'],
    ['Test verisi', 'test-data'],
    ['Yeniden şekillendir', 'reshape'],
    ['Veri sözlüğü', 'dictionary'],
  ] as const) {
    await page.goto(url)
    await tab(name).click()
    if (file === 'reshape') {
      await frame(page).locator('#kind').selectOption('flatten')
      await frame(page).locator('#add-step').click()
      await frame(page).locator('#kind').selectOption('nest')
      await frame(page).locator('#add-step').click()
    }
    await settle()
    await page.screenshot({ path: `test-results/ui-review/w3-dark-tr-${file}.png` })
  }
  await page.locator('[data-sidebar-plugin-page]', { hasText: 'Log analizcisi' }).click()
  await frame(page)
    .locator('#file')
    .setInputFiles({ name: 'mongod.log', mimeType: 'text/plain', buffer: Buffer.from(LOG) })
  await expect(frame(page).locator('#summary')).toContainText('8.0.4')
  await settle()
  await page.screenshot({ path: 'test-results/ui-review/w3-dark-tr-logs.png' })
  await page.goto(`c/${id}/db/wave3`)
  await tab('Model').click()
  await page.getByRole('button', { name: 'Modeli oku' }).click()
  await expect(page.locator('[data-node="people"]')).toBeVisible()
  await settle()
  await page.screenshot({ path: 'test-results/ui-review/w3-dark-tr-model.png' })
})
