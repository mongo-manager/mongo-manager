import { readFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { MongoClient } from 'mongodb'
import { parseConnectionUri } from '../../../shared/src/connections'
import { expect, signIn, test } from '../../fixtures'

/**
 * Phase 3e-1: every Watch screen — waiting, a live list of each kind of change, the detail of an
 * update with and without pre-images and of an insert, paused, the filters open with a refused
 * filter, an ended feed, a standalone server, a database feed — in light and dark, English and
 * Turkish, as PNGs for review. Run: MM_UI_REVIEW=1 pnpm --filter @mongo-manager/e2e ui-review.
 */
test.skip(
  !process.env.MM_UI_REVIEW || !process.env.MM_E2E_RS_URI,
  'UI review runs on demand, on a replica set',
)

type Tree = { [key: string]: string | Tree }
const locales = Object.fromEntries(
  (['en', 'tr'] as const).map((l) => [
    l,
    JSON.parse(
      readFileSync(new URL(`../../../web/src/i18n/locales/${l}.json`, import.meta.url), 'utf8'),
    ) as Tree,
  ]),
) as Record<'en' | 'tr', Tree>
const value = (lang: 'en' | 'tr', key: string) =>
  key.split('.').reduce<string | Tree>((t, k) => (t as Tree)[k]!, locales[lang]) as string

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

test('Watch screens in both themes and languages (phase 3e-1)', async ({ page }) => {
  test.setTimeout(600_000)
  const mongo = await new MongoClient(process.env.MM_E2E_RS_URI!).connect()
  await signIn(page)
  await expect(page.getByRole('button', { name: /^Account menu/ })).toBeVisible()
  const list = (await api(page, 'GET', 'connections')) as Array<{ id: string; name: string }>
  const id =
    list.find((c) => c.name === 'Replica test')?.id ??
    (
      (await api(page, 'POST', 'connections', {
        name: 'Replica test',
        favorite: false,
        readOnly: false,
        settings: parseConnectionUri(process.env.MM_E2E_RS_URI!),
      })) as { id: string }
    ).id
  const local = list.find((c) => c.name === 'Local test')!.id
  const base = (coll: string) => `connections/${id}/databases/review/collections/${coll}`
  await api(page, 'POST', `${base('plain')}/documents`, { documents: [{ _id: 'seed' }] })

  for (const theme of ['light', 'dark'] as const)
    for (const lang of ['en', 'tr'] as const) {
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
      await page.evaluate(
        ([th, l]) => localStorage.setItem('mm:preferences', JSON.stringify({ theme: th, locale: l })),
        [theme, lang] as const,
      )
      const dir = `test-results/ui-review/watch-${theme}-${lang}`
      // Reduced motion still gives every change a 0.01 ms transition: paint two frames before a shot.
      const shot = async (name: string) => {
        await page.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))')
        await page.screenshot({ path: `${dir}-${name}.png` })
      }
      // Changes made before a feed is live are not in it: every step waits for the Live pill first.
      const live = () =>
        expect(page.locator('[data-watch-status]')).toHaveText(new RegExp(value(lang, 'watch.status.live')), {
          timeout: 20_000,
        })
      const coll = `c${theme}${lang}`
      await api(page, 'POST', `${base(coll)}/documents`, { documents: [{ _id: 'seed' }] })

      // Waiting.
      await page.goto(`c/${id}/db/review/coll/${coll}`)
      await page.getByRole('tab', { name: value(lang, 'documents.sections.watch'), exact: true }).click()
      await live()
      await expect(page.getByText(value(lang, 'watch.empty.title'))).toBeVisible({ timeout: 20_000 })
      await shot('01-waiting')

      // A live list of every kind of change, with a long Turkish-length key.
      await api(page, 'POST', `${base(coll)}/documents`, {
        documents: [
          { _id: 'order-2026-10-05-0001', status: 'new', total: 120, customer: { name: 'Ayşe Yılmaz' } },
          { _id: 'order-2026-10-05-0002-with-a-very-long-identifier-to-see-truncation', status: 'new' },
        ],
      })
      const got = (await api(page, 'POST', `${base(coll)}/documents/get`, {
        _id: 'order-2026-10-05-0001',
      })) as { hash: string }
      await api(page, 'POST', `${base(coll)}/documents/update`, {
        _id: 'order-2026-10-05-0001',
        set: { status: 'paid', paidAt: { $date: '2026-10-05T10:00:00Z' } },
        unset: ['customer'],
        hash: got.hash,
      })
      await api(page, 'POST', `${base(coll)}/documents/delete`, {
        _id: 'order-2026-10-05-0002-with-a-very-long-identifier-to-see-truncation',
      })
      await expect(page.locator('[data-watch-row]')).toHaveCount(4, { timeout: 20_000 })
      await shot('02-live-list')

      // The update without pre-images, and an insert.
      await page.locator('[data-watch-row]').nth(1).click()
      await shot('03-update-no-pre-images')
      await page.locator('[data-watch-row]').nth(3).click()
      await shot('04-insert')

      // Paused, with a change waiting.
      await page.locator('[data-watch-pause]').click()
      await expect(page.locator('[data-watch-catch-up]')).toBeVisible()
      await shot('05-paused')
      await page.locator('[data-watch-catch-up]').click()

      // The filters, with a filter MongoDB refuses.
      await page.locator('[data-watch-filter-toggle]').click()
      await page.locator('[data-watch-filter-editor] textarea').fill('{ $nope: 1 }')
      await page.locator('[data-watch-filter-apply]').click()
      await expect(page.getByText(value(lang, 'watch.reason.internal'))).toBeVisible({ timeout: 20_000 })
      await shot('06-filter-refused')

      // Pre-images on: the update as a before/after diff.
      // The app does not turn pre-images on (spec §7): the fixture does, as the guide's collMod would.
      const pre = `p${theme}${lang}`
      await mongo
        .db('review')
        .dropCollection(pre)
        .catch(() => undefined)
      await mongo.db('review').createCollection(pre, { changeStreamPreAndPostImages: { enabled: true } })
      await api(page, 'POST', `${base(pre)}/documents`, { documents: [{ _id: 1, status: 'new', total: 5 }] })
      await page.goto(`c/${id}/db/review/coll/${pre}`)
      await page.getByRole('tab', { name: value(lang, 'documents.sections.watch'), exact: true }).click()
      await live()
      const one = (await api(page, 'POST', `${base(pre)}/documents/get`, { _id: 1 })) as { hash: string }
      await api(page, 'POST', `${base(pre)}/documents/update`, {
        _id: 1,
        set: { status: 'paid', total: 7 },
        hash: one.hash,
      })
      await page.locator('[data-watch-row]').first().click({ timeout: 20_000 })
      await shot('07-update-diff')

      // A database feed, and an ended feed (the collection dropped).
      await page.goto(`c/${id}/db/review`)
      await page.getByRole('tab', { name: value(lang, 'database.sections.watch'), exact: true }).click()
      await live()
      await api(page, 'POST', `${base(coll)}/documents`, { documents: [{ _id: 'db-scope' }] })
      await expect(page.locator('[data-watch-row]').first()).toBeVisible({ timeout: 20_000 })
      await shot('08-database-feed')
      await page.goto(`c/${id}/db/review/coll/${pre}`)
      await page.getByRole('tab', { name: value(lang, 'documents.sections.watch'), exact: true }).click()
      await live()
      await mongo.db('review').dropCollection(pre)
      await expect(page.getByText(value(lang, 'watch.reason.invalidate'))).toBeVisible({ timeout: 20_000 })
      await shot('09-ended')

      // A standalone server.
      await page.goto(`c/${local}`)
      await page.getByRole('tab', { name: value(lang, 'performance.sections.watch'), exact: true }).click()
      await expect(page.getByText(value(lang, 'watch.reason.not_replica_set'))).toBeVisible({
        timeout: 20_000,
      })
      await shot('10-standalone')

      // A narrow window: nothing cut at 1024 px.
      await page.setViewportSize({ width: 1024, height: 768 })
      await page.goto(`c/${id}/db/review/coll/${coll}`)
      await page.getByRole('tab', { name: value(lang, 'documents.sections.watch'), exact: true }).click()
      await live()
      await shot('11-narrow')
      await page.setViewportSize({ width: 1440, height: 900 })
    }
  await mongo.close()
})
