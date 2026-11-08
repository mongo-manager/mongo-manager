// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { Page } from '@playwright/test'
import { parseConnectionUri } from '../../../shared/src/connections'
import { expect, localHeaders, test } from '../../fixtures'

/**
 * Plugin screens for review (user request 2026-10-10: the plugin tabs redesigned): every plugin tab
 * before and after its main action, the SQL panel and the document actions, on real data — light
 * English and dark Turkish, as PNGs in test-results/ui-review.
 * Run: MM_UI_REVIEW=1 pnpm --filter @mongo-manager/e2e exec playwright test tests/local/15-plugin-screens.spec.ts --project=local
 */
test.skip(!process.env.MM_UI_REVIEW, 'UI review runs on demand')

const PLUGINS = [
  'charts',
  'document-diff',
  'duplicate-finder',
  'geojson-map',
  'references',
  'schema-health',
  'sql-to-mongodb',
  'time-hints',
  'value-search',
]
const CITIES = [
  ['Izmir', 27.14, 38.42],
  ['Ankara', 32.85, 39.93],
  ['Istanbul', 28.98, 41.01],
  ['Bursa', 29.06, 40.19],
] as const

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

test('every plugin screen, light English and dark Turkish', async ({ page }) => {
  test.setTimeout(600_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
  const { id } = (await api(page, 'POST', 'connections', {
    name: 'Shop',
    favorite: false,
    readOnly: false,
    settings: parseConnectionUri(process.env.MM_E2E_MONGO_URI!),
  })) as { id: string }
  const base = (coll: string) => `connections/${id}/databases/shop/collections/${coll}/documents`
  const customers = Array.from({ length: 12 }, (_, i) => ({
    _id: { $oid: `65a1b2c3d4e5f60718293a${(16 + i).toString(16)}` },
    name: ['Ada', 'Grace', 'Linus', 'Barbara', 'Ken', 'Margaret'][i % 6] + ` ${i}`,
    email: `user${i % 9}@example.com`,
    city: CITIES[i % 4]![0],
  }))
  await api(page, 'POST', base('customers'), { documents: customers })
  await api(page, 'POST', base('orders'), {
    documents: Array.from({ length: 60 }, (_, i) => {
      const [city, lng, lat] = CITIES[i % 4]!
      return {
        orderNo: 1000 + i,
        customerId: customers[i % 12]!._id,
        status: ['shipped', 'paid', 'new', 'cancelled'][i % 4],
        city,
        total: i % 11 === 0 ? `${i * 3}` : { $numberDouble: String(i * 3.5 + 10) },
        createdAt: { $date: new Date(Date.UTC(2026, i % 9, 1 + (i % 27), 10)).toISOString() },
        placedAt: 1767225600 + i * 86400,
        location: { type: 'Point', coordinates: [lng + (i % 5) / 50, lat + (i % 3) / 50] },
        items: [
          { productId: customers[(i + 1) % 12]!._id, qty: 1 + (i % 3), price: 9.9 },
          { productId: customers[(i + 2) % 12]!._id, qty: 2, price: 4.5 },
        ],
        ...(i % 7 === 0 ? { coupon: 'SPRING' } : {}),
      }
    }),
  })

  await page.goto('/plugins')
  await expect(page.locator('[data-plugin="charts"]')).toBeVisible()
  await page.screenshot({ path: 'test-results/ui-review/plugins-page-before.png', fullPage: true })
  for (const plugin of PLUGINS) {
    const card = page.locator(`[data-plugin="${plugin}"]`)
    await card.getByRole('button', { name: 'Approve and enable' }).click()
    await page.locator('[data-test="confirm"]').click()
    await expect(card.locator('[data-plugin-status]')).toHaveText('Enabled')
  }
  await page.screenshot({ path: 'test-results/ui-review/plugins-page-after.png', fullPage: true })
  if (process.env.MM_UI_REVIEW_PAGE_ONLY) return

  for (const [theme, lang] of [
    ['light', 'en'],
    ['dark', 'tr'],
  ] as const) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
    await page.evaluate(
      ([th, l]) => {
        localStorage.setItem('mm:preferences', JSON.stringify({ theme: th, locale: l }))
        localStorage.removeItem('mm:tabs')
      },
      [theme, lang] as const,
    )
    await page.goto(`c/${id}/db/shop/coll/orders`)
    await expect(page.locator('tbody tr').first()).toBeVisible()
    const dir = `test-results/ui-review/plugins-${theme}-${lang}`
    const shot = async (name: string) => {
      await page.waitForTimeout(400)
      await page.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))')
      await page.screenshot({ path: `${dir}-${name}.png` })
    }
    await shot('00-documents')
    const sections = page
      .getByRole('tablist')
      .filter({ has: page.getByRole('tab') })
      .first()
    const tab = (en: string, tr: string) =>
      page.locator('[role="tab"]', { hasText: new RegExp(`^\\s*${lang === 'tr' ? tr : en}\\s*$`) }).first()
    // The section shown: a value search stays loaded, out of sight, after its tab (ui.keepOpen).
    const frame = () => page.frameLocator('[data-plugin-frame] iframe:visible')
    void sections

    const steps: Array<[string, string, string, (() => Promise<void>) | null]> = [
      [
        '10-charts',
        'Charts',
        'Grafikler',
        async () => {
          await frame().locator('#field').selectOption('city')
          await frame()
            .locator('button', { hasText: lang === 'tr' ? 'Çiz' : 'Draw' })
            .click()
          await frame().locator('#data > summary').click()
        },
      ],
      [
        '20-duplicates',
        'Duplicates',
        'Yinelenenler',
        async () => {
          await frame().locator('#fields').fill('city, status')
          await frame().locator('#find').click()
        },
      ],
      ['30-map', 'Map', 'Harita', null],
      [
        '40-references',
        'References',
        'Referanslar',
        async () => {
          await frame().locator('button').first().click()
        },
      ],
      [
        '50-health',
        'Health',
        'Sağlık',
        async () => {
          await frame().locator('button').first().click()
        },
      ],
      [
        '60-sql',
        'SQL',
        'SQL',
        async () => {
          await frame()
            .locator('#sql')
            .fill(
              'select o.orderNo, o.status, o.total, c.name, c.email from orders o join customers c on o.customerId = c._id where o.status = "shipped" and o.total > 20 order by o.total desc limit 10',
            )
          await frame().locator('#format').click()
          await frame().locator('#run').click()
          // A joined column's source, on its heading.
          await frame().locator('#results [data-note]').first().hover()
        },
      ],
      [
        '65-sql-complete',
        'SQL',
        'SQL',
        async () => {
          await frame().locator('#sql').click()
          await page.keyboard.press('Control+A')
          await page.keyboard.type('SELECT * FROM orders WHERE st')
        },
      ],
      [
        '70-search',
        'Search',
        'Ara',
        async () => {
          await frame().locator('#term').fill('ankara')
          await frame().locator('#term').press('Enter')
        },
      ],
    ]
    for (const [name, en, tr, act] of steps) {
      await tab(en, tr).click()
      await expect(page.locator('[data-plugin-frame] iframe:visible')).toBeVisible()
      await shot(`${name}-a`)
      if (act) {
        await act().catch((e: unknown) => console.log(`${name}: ${String(e).slice(0, 200)}`))
        await page.waitForTimeout(1500)
        await shot(`${name}-b`)
      }
    }
  }
})
