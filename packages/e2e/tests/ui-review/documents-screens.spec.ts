import { readFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { MongoClient } from 'mongodb'
import { expect, signIn, test } from '../../fixtures'

/**
 * UI redesign R1 checkpoint 2: the collection header, the query composer (Query and Ask, Options), the
 * structured query panel, the results toolbar, the Cards view and the inspector (fields, JSON, edit,
 * review, insert) — light and dark, English and Turkish, at 1440×900, and the inspector as an overlay
 * at 1180×820. The assistant's status and answer are scripted (no provider is needed).
 * Run: MM_UI_REVIEW=1 pnpm --filter @mongo-manager/e2e exec playwright test tests/01-first-run.spec.ts tests/ui-review/documents-screens.spec.ts --project=chrome
 */
test.skip(!process.env.MM_UI_REVIEW, 'UI review runs on demand')

type Tree = { [key: string]: string | Tree }
const locales = Object.fromEntries(
  (['en', 'tr'] as const).map((l) => [
    l,
    JSON.parse(
      readFileSync(new URL(`../../../web/src/i18n/locales/${l}.json`, import.meta.url), 'utf8'),
    ) as Tree,
  ]),
) as Record<'en' | 'tr', Tree>
/** A message's text (its first plural form), with its placeholders filled. */
function say(lang: 'en' | 'tr', key: string, values: Record<string, string> = {}): string {
  const value = key.split('.').reduce<string | Tree>((t, k) => (t as Tree)[k]!, locales[lang]) as string
  return value
    .split('|')[0]!
    .trim()
    .replace(/\{(\w+)\}/g, (_, k: string) => values[k] ?? '')
}

async function api(page: Page, method: 'GET' | 'POST', path: string, data?: object) {
  const me = await (await page.request.get('api/auth/me')).json()
  const res = await page.request.fetch(`api/${path}`, {
    method,
    ...(data ? { data } : {}),
    headers: { 'x-csrf-token': me.csrfToken, origin: new URL(page.url()).origin },
  })
  expect(res.ok(), await res.text()).toBe(true)
  return res.status() === 204 ? null : res.json()
}

async function checkFit(page: Page, where: string) {
  const problems = (await page.evaluate(`(() => {
    const out = []
    if (document.documentElement.scrollWidth > window.innerWidth) out.push('page scrolls sideways')
    for (const el of document.querySelectorAll('form[role="search"] button, [data-inspector] header button')) {
      const r = el.getBoundingClientRect()
      if (r.height > 40) out.push('taller than one line: ' + (el.textContent || '').trim().slice(0, 40))
    }
    return out
  })()`)) as string[]
  expect(problems, where).toEqual([])
}

const STATUS = {
  enabled: true,
  allowServerJs: false,
  providers: [
    {
      id: 'p1',
      name: 'Claude',
      kind: 'anthropic',
      model: 'claude-sonnet-5',
      local: false,
      samples: false,
      isDefault: true,
    },
  ],
  limits: { perMinute: 10, perDay: 200, perUser: 2, concurrent: 8 },
}
const ANSWER = [
  {
    type: 'context',
    sent: {
      namespace: 'review.orders',
      schema: null,
      current: null,
      plan: null,
      indexes: null,
      validator: null,
      samples: [],
      leftOut: [],
    },
    provider: { id: 'p1', name: 'Claude', model: 'claude-sonnet-5', kind: 'anthropic' },
  },
  { type: 'text', delta: 'Paid orders over 500, newest first.' },
  {
    type: 'done',
    result: {
      kind: 'query',
      filter: { status: 'paid', total: { $gt: { $numberInt: '500' } } },
      sort: { createdAt: { $numberInt: '-1' } },
    },
    warnings: [],
    usage: { input: 120, output: 30 },
    local: false,
  },
]

test('the Documents screen in both themes and languages (UI redesign R1 checkpoint 2)', async ({ page }) => {
  test.setTimeout(900_000)
  await signIn(page)
  await expect(page.getByRole('button', { name: /^Account menu/ })).toBeVisible()
  const conn = ((await api(page, 'GET', 'connections')) as Array<{ id: string; name: string }>).find(
    (c) => c.name === 'Local test',
  )!.id
  // Realistic orders, once. The AI chat screens put orders of their own (no totals) in the same
  // collection: these screens start from theirs alone.
  const mongo = await new MongoClient(process.env.MM_E2E_MONGO_URI!).connect()
  const fresh = await (async () => {
    try {
      const orders = mongo.db('review').collection('orders')
      const ours = await orders.countDocuments({ orderNo: { $exists: true } })
      const others = await orders.countDocuments({ orderNo: { $exists: false } })
      if (ours === 36 && others === 0) return false
      await orders.deleteMany({})
      return true
    } finally {
      await mongo.close()
    }
  })()
  if (fresh) {
    const statuses = ['paid', 'paid', 'shipped', 'pending', 'refunded']
    const names = ['Ada Kaya', 'Bora Demir', 'Cem Aydın', 'Deniz Şahin', 'Elif Yılmaz', 'Zeynep Arslan']
    await api(page, 'POST', `connections/${conn}/databases/review/collections/orders/documents`, {
      documents: Array.from({ length: 36 }, (_, i) => ({
        orderNo: `ORD-${10001 + i}`,
        status: statuses[i % statuses.length],
        customer: {
          name: names[i % names.length],
          email: `c${i}@example.com`,
          city: i % 2 ? 'İstanbul' : 'Berlin',
        },
        items: Array.from({ length: 1 + (i % 3) }, (_, k) => ({
          sku: `SKU-${1000 + k}`,
          qty: 1 + k,
          price: 49.5 + k * 10,
        })),
        total: 120 + i * 37.5,
        currency: 'EUR',
        tags: i % 4 === 0 ? ['gift'] : [],
        createdAt: { $date: new Date(Date.UTC(2026, 8, 1 + (i % 28), 9 + (i % 10))).toISOString() },
        ...(i % 5 === 0 ? { note: 'Leave at the door' } : {}),
      })),
    })
  }
  // The assistant, scripted: on for this connection, one provider, one answer.
  await page.route(/\/api\/ai\/status$/, (route) => route.fulfill({ json: STATUS }))
  await page.route(/\/api\/connections$/, async (route) => {
    const res = await route.fetch()
    const list = (await res.json()) as Array<{ aiPolicy?: string; permissions: string[] }>
    await route.fulfill({
      json: list.map((c) => ({
        ...c,
        aiPolicy: 'any',
        permissions: [...new Set([...c.permissions, 'ai:use'])],
      })),
    })
  })
  await page.route(/\/ai$/, (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({
          body: ANSWER.map((l) => JSON.stringify(l)).join('\n'),
          contentType: 'application/x-ndjson',
        })
      : route.continue(),
  )

  type Run = { size: { width: number; height: number }; theme: 'light' | 'dark'; lang: 'en' | 'tr' }
  const runs: Run[] = []
  for (const theme of ['light', 'dark'] as const)
    for (const lang of ['en', 'tr'] as const) runs.push({ size: { width: 1440, height: 900 }, theme, lang })
  runs.push({ size: { width: 1180, height: 820 }, theme: 'light', lang: 'en' })

  for (const { size, theme, lang } of runs) {
    const S = (key: string, values: Record<string, string> = {}) => say(lang, key, values)
    await page.setViewportSize(size)
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
    await page.evaluate(
      ([th, l]) => {
        localStorage.setItem('mm:preferences', JSON.stringify({ theme: th, locale: l, accent: 'emerald' }))
        localStorage.removeItem('mm:tabs')
        localStorage.removeItem('mm:layout')
      },
      [theme, lang] as const,
    )
    await page.goto(`c/${conn}/db/review/coll/orders`)
    const documents = page.getByRole('tabpanel', { name: S('documents.sections.documents') })
    await expect(documents.locator('tbody tr').first()).toBeVisible()
    const dir = `test-results/ui-review/documents-${size.width}-${theme}-${lang}`
    const shot = async (name: string) => {
      await page.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))')
      await page.screenshot({ path: `${dir}-${name}.png` })
    }
    const overlay = size.width < 1280
    if (!overlay) {
      await checkFit(page, `${dir} table`)
      await shot('01-table')
      const filter = page.getByRole('textbox', { name: S('query.filter'), exact: true })
      await filter.fill("{ status: 'paid' }")
      await page.getByTitle(S('query.options'), { exact: true }).click()
      await page.getByRole('textbox', { name: S('query.sort'), exact: true }).fill('{ total: -1 }')
      await filter.press('Enter')
      await expect(page.locator('[data-query-panel]')).toBeVisible()
      await checkFit(page, `${dir} options`)
      await shot('02-options-and-panel')
      await page.getByTitle(S('query.options'), { exact: true }).click()

      await page.getByRole('radio', { name: S('query.modes.ask'), exact: true }).click()
      await page
        .getByRole('textbox', { name: S('query.ask.label') })
        .fill(
          lang === 'tr'
            ? '500 üzerindeki ödenmiş siparişler, en yeni önce'
            : 'paid orders over 500, newest first',
        )
      await checkFit(page, `${dir} ask`)
      await shot('03-ask')
      await page.getByRole('button', { name: S('query.ask.generate') }).click()
      // Work in the bar: the assistant asks before replacing it.
      await page
        .getByRole('dialog')
        .getByRole('button', { name: S('ai.insert.replace') })
        .click()
      await expect(page.getByRole('textbox', { name: S('query.filter'), exact: true })).toHaveValue(/paid/)
      await page.getByRole('button', { name: S('query.find'), exact: true }).click()
      await expect(page.locator('[data-query-panel]')).toContainText(
        lang === 'tr' ? 'ödenmiş' : 'paid orders',
      )
      await shot('04-ask-intent-panel')
    }

    await page.getByRole('radio', { name: S('documents.view.cards'), exact: true }).click()
    await expect(documents.locator('[data-card]').first()).toBeVisible()
    await checkFit(page, `${dir} cards`)
    await shot('05-cards')
    await documents.locator('[data-card]').first().locator('li').first().click()
    const inspector = page.locator('[data-inspector]')
    await expect(inspector).toBeVisible()
    await checkFit(page, `${dir} inspector`)
    await shot('06-inspector-fields')
    await inspector.getByRole('tab', { name: S('documents.inspector.json') }).click()
    await shot('07-inspector-json')
    await inspector.getByRole('tab', { name: S('documents.inspector.edit') }).click()
    const text = inspector.getByRole('textbox', { name: S('editor.text'), exact: true })
    await expect(text).toBeVisible()
    await shot('08-inspector-edit')
    await text.fill((await text.inputValue()).replace(/currency: "EUR"/, 'currency: "USD"'))
    await inspector.getByRole('button', { name: S('editor.save'), exact: true }).click()
    await expect(inspector.locator('[data-test="diff"]')).toBeVisible()
    await shot('09-inspector-review')
    await inspector.getByRole('button', { name: S('editor.back'), exact: true }).click()
    await inspector.getByRole('button', { name: S('common.cancel'), exact: true }).click()
    await page
      .getByRole('dialog')
      .getByRole('button', { name: S('connection.discard') })
      .click()
    await page.keyboard.press('Escape')
    await expect(inspector).toHaveCount(0)

    if (!overlay) {
      await page.getByRole('button', { name: S('documents.results.more') }).click()
      await shot('10-results-menu')
      await page.keyboard.press('Escape')
      await page.getByRole('button', { name: S('documents.insert'), exact: true }).click()
      await expect(inspector).toBeVisible()
      await shot('11-insert')
      await page.keyboard.press('Escape')

      // Checkpoint 3: the selection, and Aggregations (empty, a stage with its output, the results).
      await page.getByRole('radio', { name: S('documents.view.table'), exact: true }).click()
      await page.getByRole('checkbox', { name: S('documents.selection.all'), exact: true }).click()
      await expect(page.locator('[data-selection-bar]')).toBeVisible()
      await checkFit(page, `${dir} selection`)
      await shot('12-selection')
      await page.getByRole('button', { name: S('documents.selection.clear'), exact: true }).click()
      await page.getByRole('tab', { name: S('documents.sections.aggregations') }).click()
      await expect(page.locator('[data-results]')).toHaveCount(1)
      await shot('13-aggregation-empty')
      await page
        .getByRole('button', { name: S('aggregation.addQuick', { operator: '$match' }), exact: true })
        .click()
      await page
        .getByRole('textbox', { name: S('aggregation.value', { n: '1' }), exact: true })
        .fill('{ status: "paid" }')
      await expect(page.locator('[data-stage] [data-preview]').first()).toContainText(/\d/)
      await checkFit(page, `${dir} aggregation`)
      await shot('14-aggregation-stage')
      await page.getByRole('button', { name: S('aggregation.run.run'), exact: true }).click()
      await expect(page.locator('[data-run-status]')).toContainText(S('aggregation.run.done'))
      await shot('15-aggregation-results')
      await page.getByRole('tab', { name: S('documents.sections.documents') }).click()
    }
  }
})
