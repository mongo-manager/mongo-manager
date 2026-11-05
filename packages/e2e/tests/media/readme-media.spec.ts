// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { writeFileSync } from 'node:fs'
import type { Locator, Page } from '@playwright/test'
import { MongoClient } from 'mongodb'
import { expect, signIn, test } from '../../fixtures'
import { CURSOR_SCRIPT, press } from './cursor'
import { MEDIA_DB, seedStore } from './seed'

/**
 * README, landing page and Product Hunt media (2026-10-31): the app's main screens in both themes,
 * and a recorded tour with the time each scene starts, on a made-up store. On demand only; after the
 * first run's setup:
 *   MM_MEDIA=1 pnpm --filter @mongo-manager/e2e exec playwright test tests/01-first-run.spec.ts tests/media --project=chrome
 * The pictures land in test-results/media; scripts/readme-media.mjs makes the published files.
 */
test.skip(!process.env.MM_MEDIA, 'Media are made on demand')

const OUT = 'test-results/media'
const CONNECTION = 'Acme Store'
/** Plugins approved for the Plugins page's picture: some enabled, the rest waiting. */
const APPROVED = ['charts', 'data-dictionary', 'geojson-map']

async function connectionId(page: Page): Promise<string> {
  const list = (await (await page.request.get('api/connections')).json()) as Array<{
    id: string
    name: string
  }>
  return (list.find((c) => c.name === CONNECTION) ?? list.find((c) => c.name === 'Local test'))!.id
}
/** The test connection, named as a store's would be (this run's data only). */
async function nameConnection(page: Page, id: string): Promise<void> {
  const me = (await (await page.request.get('api/auth/me')).json()) as { csrfToken: string }
  const res = await page.request.patch(`api/connections/${id}`, {
    data: { name: CONNECTION },
    headers: { 'x-csrf-token': me.csrfToken, origin: new URL(page.url()).origin },
  })
  expect(res.ok()).toBe(true)
}
async function settle(page: Page): Promise<void> {
  // The assistant's open stream keeps the network from going quiet: waited for a while, not forever.
  await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => undefined)
  await page.waitForTimeout(700)
}
/** Reads and writes on the store for a while, so the server's charts have something to draw. */
async function load(ms: number): Promise<void> {
  const client = new MongoClient(process.env.MM_E2E_MONGO_URI!)
  try {
    const orders = client.db(MEDIA_DB).collection('orders')
    const events = client.db(MEDIA_DB).collection('events')
    const end = Date.now() + ms
    let i = 0
    while (Date.now() < end) {
      const burst = 20 + Math.round(30 * Math.abs(Math.sin(i++ / 3)))
      await Promise.all(
        Array.from({ length: burst }, (_, k) =>
          k % 4 === 0
            ? events.insertOne({ type: 'view', at: new Date() })
            : orders
                .find({ status: k % 2 ? 'paid' : 'shipped' })
                .limit(50)
                .toArray(),
        ),
      )
      await new Promise((r) => setTimeout(r, 250))
    }
  } finally {
    await client.close()
  }
}

test.beforeAll(async () => {
  await seedStore(process.env.MM_E2E_MONGO_URI!)
  // The first run's own database is not the store's.
  const client = new MongoClient(process.env.MM_E2E_MONGO_URI!)
  await client.db('shop').dropDatabase()
  await client.close()
})

test('screenshots, light and dark', async ({ page }) => {
  test.setTimeout(300_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  await signIn(page)
  await expect(page.getByRole('button', { name: /^Account menu/ })).toBeVisible()
  const id = await connectionId(page)
  await nameConnection(page, id)
  /** The scene in the light theme, then the dark one — by the app's own switch, nothing reloaded. */
  const shot = async (name: string) => {
    await settle(page)
    await page.screenshot({ path: `${OUT}/${name}-light.png` })
    await page.getByRole('button', { name: 'Switch to dark theme' }).click()
    await settle(page)
    await page.screenshot({ path: `${OUT}/${name}-dark.png` })
    await page.getByRole('button', { name: 'Switch to light theme' }).click()
  }
  const rows = page.getByRole('row', { name: /^Select document / })

  // The collection's documents, a filter applied.
  await page.goto(`c/${id}/db/${MEDIA_DB}/coll/orders`)
  await expect(rows.first()).toBeVisible()
  const filter = page.getByRole('textbox', { name: 'Filter', exact: true })
  await filter.fill("{ status: 'paid', total: { $gt: 250 } }")
  await filter.press('Enter')
  await expect(rows.first()).toBeVisible()
  await shot('documents')

  // An aggregation: revenue by channel, each stage with its preview.
  await page.getByRole('tab', { name: 'Aggregations' }).click()
  for (const [operator, value] of [
    ['$match', "{ status: { $in: ['paid', 'shipped'] } }"],
    ['$group', "{ _id: '$channel', orders: { $sum: 1 }, revenue: { $sum: '$total' } }"],
    ['$sort', '{ revenue: -1 }'],
  ] as const) {
    await page.getByRole('button', { name: 'Add stage' }).click()
    await page.getByRole('combobox', { name: 'Find a stage' }).fill(operator.slice(1))
    await page.locator(`[role="option"][data-operator="${operator}"]`).click()
    await page.locator('[data-stage]').last().locator('textarea').fill(value)
  }
  await expect(page.locator('[data-stage]').last().locator('[data-preview]')).toContainText('3 documents')
  await shot('aggregation')

  // The schema the documents have.
  await page.getByRole('tab', { name: 'Schema' }).click()
  await page.getByRole('button', { name: 'Analyse' }).click()
  await expect(page.getByText('documents sampled')).toBeVisible({ timeout: 20_000 })
  await shot('schema')

  // Why a query is slow: its plan.
  await page.getByRole('tab', { name: 'Documents' }).click()
  await filter.fill("{ channel: 'marketplace', 'customer.city': 'Berlin' }")
  await filter.press('Enter')
  await expect(rows.first()).toBeVisible()
  await page.getByRole('button', { name: 'Why is it slow?' }).click()
  await expect(page.getByRole('tree', { name: 'Winning plan' })).toBeVisible()
  await shot('explain')

  // The command palette, finding commands.
  await page.getByRole('tab', { name: 'Documents' }).click()
  await expect(rows.first()).toBeVisible()
  await page.keyboard.press('Control+k')
  await page.keyboard.type('export', { delay: 40 })
  await expect(page.getByRole('option', { name: /Export this collection/ })).toBeVisible()
  await settle(page)
  await page.screenshot({ path: `${OUT}/palette-light.png` })
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Switch to dark theme' }).click()
  await page.keyboard.press('Control+k')
  await page.keyboard.type('export', { delay: 40 })
  await expect(page.getByRole('option', { name: /Export this collection/ })).toBeVisible()
  await settle(page)
  await page.screenshot({ path: `${OUT}/palette-dark.png` })
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Switch to light theme' }).click()

  // The server's performance, under some load.
  await page.goto(`c/${id}`)
  await page.getByRole('tab', { name: 'Performance' }).click()
  await expect(page.getByRole('heading', { name: 'Profiler' })).toBeVisible({ timeout: 20_000 })
  await load(40_000)
  // As text: this package is typed without the DOM.
  await page.evaluate("document.querySelector('#main .overflow-auto')?.scrollTo(0, 0)")
  await shot('performance')

  // The plugins: some approved and enabled, the rest waiting for an administrator.
  await page.goto('plugins')
  for (const plugin of APPROVED) {
    const card = page.locator(`[data-plugin="${plugin}"]`)
    await card.getByRole('button', { name: 'Approve and enable' }).click()
    await page.locator('[data-test="confirm"]').click()
    await expect(card.locator('[data-plugin-status]')).toHaveText('Enabled')
  }
  await page.getByRole('radio', { name: /^Enabled/ }).click()
  await expect(page.locator('[data-plugin]')).toHaveCount(APPROVED.length)
  await page.getByRole('radio', { name: /^All/ }).click()
  await shot('plugins')

  // Team mode's security: two-factor policy, sessions, panel access and sign-in bans.
  await page.goto('users')
  await page.locator('#users-view-security').click()
  await expect(page.locator('main [data-sign-in-bans]')).toBeVisible()
  await shot('security')

  // The assistant in agent mode: a question answered from the data, then a change on its card.
  await useAi(page)
  await page.goto(`c/${id}/db/${MEDIA_DB}/coll/orders`)
  await expect(rows.first()).toBeVisible()
  const panel = await openAgent(page)
  await documentsToggle(panel).click()
  await ask(page, panel, ASK_REVENUE)
  await expect(panel.getByText(/brings in the most/).first()).toBeVisible({ timeout: 30_000 })
  await ask(page, panel, ASK_FASTER)
  await expect(panel.locator('[data-agent-card]').getByRole('button', { name: 'Confirm' })).toBeVisible({
    timeout: 30_000,
  })
  // The card's own buttons in sight: the change waits for them.
  await panel.locator('[data-agent-card]').getByRole('button', { name: 'Confirm' }).scrollIntoViewIfNeeded()
  await shot('ai-agent')
})

/** The words the made-up provider answers (packages/e2e/global-setup.ts). */
const ASK_REVENUE = 'Which sales channel brings in the most revenue in Acme Store?'
const ASK_FASTER = 'Make the Berlin marketplace orders faster'

/** An API call as the signed-in page makes it. */
async function api(page: Page, method: string, path: string, data?: object) {
  const me = (await (await page.request.get('api/auth/me')).json()) as { csrfToken: string }
  return page.request.fetch(`api/${path}`, {
    method,
    ...(data ? { data } : {}),
    headers: { 'x-csrf-token': me.csrfToken, origin: new URL(page.url()).origin },
  })
}
/** The test's made-up model as the only provider, and no chat left from another run. */
async function useAi(page: Page): Promise<void> {
  const providers = (await (await api(page, 'GET', 'ai/providers')).json()) as Array<{ id: string }>
  for (const p of providers) await api(page, 'DELETE', `ai/providers/${p.id}`)
  await api(page, 'DELETE', 'ai/chats')
  const made = await api(page, 'POST', 'ai/providers', {
    name: 'Local LLM',
    kind: 'openai',
    baseUrl: `${process.env.MM_E2E_AI_URL}/v1`,
    model: 'llm',
    // The agent adds up the orders' values: the provider may receive them.
    samples: true,
  })
  expect(made.ok()).toBe(true)
}
async function openAgent(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Assistant', exact: true }).click()
  const panel = page.getByRole('complementary', { name: 'Assistant' })
  await panel.getByRole('switch', { name: 'Agent mode' }).check()
  await expect(panel.getByText('You see each change and confirm it.')).toBeVisible()
  await page.getByRole('button', { name: 'Expand the assistant' }).click()
  return panel
}
/** Lets the agent read documents' values for the next message (personal fields stay hidden). */
function documentsToggle(panel: Locator): Locator {
  return panel.getByRole('button', { name: 'Documents', exact: true })
}
async function ask(page: Page, panel: Locator, words: string, typed = false): Promise<void> {
  const box = panel.getByLabel('Message the assistant')
  // The turn before is over: a message sent while it runs is not taken.
  await expect(panel.getByRole('button', { name: 'Send', exact: true })).toBeVisible({ timeout: 30_000 })
  if (typed) {
    await box.click()
    await page.keyboard.type(words, { delay: 32 })
  } else await box.fill(words)
  await box.press('Enter')
}

/** Fills a field a character at a time, as typing looks (an editor's own bracket closing left out). */
async function typeLike(page: Page, field: Locator, text: string, perChar = 38): Promise<void> {
  for (let i = 1; i <= text.length; i++) {
    await field.fill(text.slice(0, i))
    await page.waitForTimeout(perChar)
  }
}

test('tour video, with its scenes marked', async ({ browser, page }) => {
  test.setTimeout(300_000)
  // Signed in once, then a fresh page that records from its first frame (no sign-in shown).
  await page.setViewportSize({ width: 1440, height: 900 })
  await signIn(page)
  await expect(page.getByRole('button', { name: /^Account menu/ })).toBeVisible()
  const id = await connectionId(page)
  await nameConnection(page, id)
  await useAi(page)
  const state = await page.context().storageState()
  const context = await browser.newContext({
    storageState: state,
    viewport: { width: 1440, height: 900 },
    colorScheme: 'light',
    reducedMotion: 'reduce',
    locale: 'en-US',
    recordVideo: { dir: `${OUT}/video`, size: { width: 1440, height: 900 } },
  })
  await context.addInitScript(() => {
    if (!sessionStorage.getItem('mm-media-theme')) {
      localStorage.setItem('mm:preferences', JSON.stringify({ theme: 'light', locale: 'en' }))
      localStorage.removeItem('mm:tabs')
      sessionStorage.setItem('mm-media-theme', '1')
    }
  })
  await context.addInitScript(CURSOR_SCRIPT)
  const v = await context.newPage()
  // The recording starts with the page: scene times are counted from here.
  const started = Date.now()
  const marks: Array<{ scene: string; start: number; end: number }> = []
  const scene = async (name: string, body: () => Promise<void>) => {
    const start = (Date.now() - started) / 1000
    await body()
    marks.push({ scene: name, start, end: (Date.now() - started) / 1000 })
  }
  // The server busy the whole time: its charts show a store at work when they come on screen.
  const busy = load(90_000)
  const rows = v.getByRole('row', { name: /^Select document / })
  const pause = (ms: number) => v.waitForTimeout(ms)
  const filter = v.getByRole('textbox', { name: 'Filter', exact: true })
  try {
    await v.goto(`c/${id}/db/${MEDIA_DB}/coll/products`)
    await expect(rows.first()).toBeVisible()
    await pause(1200)

    await scene('query', async () => {
      await press(v, v.getByRole('treeitem', { name: 'orders', exact: true }).locator(':scope > div').first())
      await expect(rows.first()).toBeVisible()
      await pause(700)
      await press(v, filter)
      await typeLike(v, filter, "{ status: 'paid', total: { $gt: 250 } }")
      await pause(300)
      await press(v, v.getByRole('button', { name: 'Find', exact: true }))
      await expect(v.getByText(/of 2\d\d/).first()).toBeVisible()
      await pause(1800)
    })

    await scene('aggregation', async () => {
      await press(v, v.getByRole('tab', { name: 'Aggregations' }))
      await pause(600)
      for (const [operator, value] of [
        ['$match', "{ status: { $in: ['paid', 'shipped'] } }"],
        ['$group', "{ _id: '$channel', orders: { $sum: 1 }, revenue: { $sum: '$total' } }"],
      ] as const) {
        await press(v, v.getByRole('button', { name: 'Add stage' }))
        const find = v.getByRole('combobox', { name: 'Find a stage' })
        await typeLike(v, find, operator.slice(1), 70)
        await pause(400)
        await press(v, v.locator(`[role="option"][data-operator="${operator}"]`))
        const editor = v.locator('[data-stage]').last().locator('textarea')
        await press(v, editor)
        await typeLike(v, editor, value, 28)
        await pause(1300)
      }
      await expect(v.locator('[data-stage]').last().locator('[data-preview]')).toContainText('3 documents')
      await pause(1800)
    })

    await scene('schema', async () => {
      await press(v, v.getByRole('tab', { name: 'Schema' }))
      await press(v, v.getByRole('button', { name: 'Analyse' }))
      await expect(v.getByText('documents sampled')).toBeVisible({ timeout: 20_000 })
      await pause(2400)
    })

    await scene('explain', async () => {
      await press(v, v.getByRole('tab', { name: 'Documents' }))
      await press(v, filter)
      await typeLike(v, filter, "{ channel: 'marketplace', 'customer.city': 'Berlin' }", 30)
      await v.keyboard.press('Enter')
      await expect(rows.first()).toBeVisible()
      await pause(500)
      await press(v, v.getByRole('button', { name: 'Why is it slow?' }))
      await expect(v.getByRole('tree', { name: 'Winning plan' })).toBeVisible()
      await pause(2400)
    })

    await scene('ai', async () => {
      await press(v, v.getByRole('button', { name: 'Assistant', exact: true }))
      const panel = v.getByRole('complementary', { name: 'Assistant' })
      // The mode is the person's own setting: switched on only if it is off.
      const agentMode = panel.getByRole('switch', { name: 'Agent mode' })
      if (!(await agentMode.isChecked())) await press(v, agentMode)
      await expect(panel.getByText('You see each change and confirm it.')).toBeVisible()
      await pause(500)
      await press(v, v.getByRole('button', { name: 'Expand the assistant' }))
      await pause(400)
      await press(v, documentsToggle(panel))
      await pause(500)
      await press(v, panel.getByLabel('Message the assistant'))
      await ask(v, panel, ASK_REVENUE, true)
      await expect(panel.getByText(/brings in the most/).first()).toBeVisible({ timeout: 30_000 })
      await pause(2600)
      await ask(v, panel, ASK_FASTER, true)
      const confirm = panel.locator('[data-agent-card]').getByRole('button', { name: 'Confirm' })
      await expect(confirm).toBeVisible({ timeout: 30_000 })
      await pause(1800)
      await press(v, confirm)
      await expect(panel.getByText('Done: the index is being built')).toBeVisible({ timeout: 30_000 })
      await pause(2400)
      await press(v, v.getByRole('button', { name: 'Assistant', exact: true }))
      await pause(400)
    })

    await scene('palette', async () => {
      await v.keyboard.press('Control+k')
      await pause(400)
      await v.keyboard.type('export', { delay: 90 })
      await expect(v.getByRole('option', { name: /Export this collection/ })).toBeVisible()
      await pause(1400)
      await v.keyboard.press('Escape')
    })

    await scene('performance', async () => {
      // The row itself: an open connection's item holds its databases too.
      await press(
        v,
        v.getByRole('treeitem', { name: CONNECTION, exact: true }).locator(':scope > div').first(),
      )
      await expect(v.getByRole('tab', { name: 'Performance' })).toBeVisible()
      await press(v, v.getByRole('tab', { name: 'Performance' }))
      await expect(v.getByRole('heading', { name: 'Operations per second' })).toBeVisible({
        timeout: 20_000,
      })
      // Long enough for the live charts to draw a few samples.
      await pause(7000)
    })

    await scene('dark', async () => {
      await press(v, v.getByRole('button', { name: /^Switch to dark theme/ }))
      await pause(2800)
    })
  } finally {
    // The video is written as the page closes, whatever happened above.
    await v.close()
    await context.close()
    await busy
    writeFileSync(`${OUT}/video/marks.json`, JSON.stringify(marks, null, 2))
  }
})
