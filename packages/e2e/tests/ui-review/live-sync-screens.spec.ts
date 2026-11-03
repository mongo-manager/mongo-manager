import { readFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { MongoClient } from 'mongodb'
import { parseConnectionUri } from '../../../shared/src/connections'
import { expect, signIn, test } from '../../fixtures'

/**
 * Phase 3e-2: every Live sync screen — the empty tab, the wizard's steps and its summary with
 * warnings, cards live, catching up, paused, needing attention (a refused document), completed and
 * failed, the details, the finish dialog — in light and dark, English and Turkish, as PNGs for review.
 * Run: MM_UI_REVIEW=1 pnpm --filter @mongo-manager/e2e exec playwright test tests/01-first-run.spec.ts tests/ui-review/live-sync-screens.spec.ts --project=chrome
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

async function api(page: Page, method: 'GET' | 'POST' | 'DELETE', path: string, data?: object) {
  const me = await (await page.request.get('api/auth/me')).json()
  const res = await page.request.fetch(`api/${path}`, {
    method,
    ...(data ? { data } : {}),
    headers: { 'x-csrf-token': me.csrfToken, origin: new URL(page.url()).origin },
  })
  expect(res.ok(), await res.text()).toBe(true)
  return res.status() === 204 ? null : res.json()
}
async function connection(page: Page, name: string): Promise<string> {
  const list = (await api(page, 'GET', 'connections')) as Array<{ id: string; name: string }>
  return (
    list.find((c) => c.name === name)?.id ??
    (
      (await api(page, 'POST', 'connections', {
        name,
        favorite: false,
        readOnly: false,
        settings: parseConnectionUri(process.env.MM_E2E_RS_URI!),
      })) as { id: string }
    ).id
  )
}
/** Plans and starts a sync through the API (the wizard has its own screens). */
async function startSync(
  page: Page,
  mongo: MongoClient,
  source: string,
  target: string,
  coll: string,
  extra: object = {},
) {
  // A collection sync needs its source collection.
  await mongo
    .db('review')
    .createCollection(coll)
    .catch(() => undefined)
  const body = {
    source: { connectionId: source, db: 'review', coll },
    target: { connectionId: target, db: 'reviewcopy', coll },
    confirmOverwrite: true,
    ...extra,
  }
  const plan = (await api(page, 'POST', `connections/${source}/live-syncs/plan`, body)) as {
    planHash: string
  }
  return (
    (await api(page, 'POST', `connections/${source}/live-syncs`, { ...body, planHash: plan.planHash })) as {
      id: string
    }
  ).id
}

test('Live sync screens in both themes and languages (phase 3e-2)', async ({ page }) => {
  test.setTimeout(900_000)
  const mongo = await new MongoClient(process.env.MM_E2E_RS_URI!).connect()
  try {
    await signIn(page)
    await expect(page.getByRole('button', { name: /^Account menu/ })).toBeVisible()
    const source = await connection(page, 'Replica test')
    const target = await connection(page, 'Replica copy')
    // Clean slate: earlier runs' syncs and collections go.
    for (const s of (
      (await api(page, 'GET', 'live-syncs')) as { syncs: Array<{ id: string; state: string }> }
    ).syncs) {
      if (!['completed', 'failed', 'stopped'].includes(s.state))
        await api(page, 'POST', `live-syncs/${s.id}/stop`)
      await api(page, 'DELETE', `live-syncs/${s.id}`)
    }
    await mongo.db('review').dropDatabase()
    await mongo.db('reviewcopy').dropDatabase()

    for (const theme of ['light', 'dark'] as const)
      for (const lang of ['en', 'tr'] as const) {
        await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
        await page.evaluate(
          ([th, l]) => localStorage.setItem('mm:preferences', JSON.stringify({ theme: th, locale: l })),
          [theme, lang] as const,
        )
        const dir = `test-results/ui-review/livesync-${theme}-${lang}`
        const shot = async (name: string) => {
          await page.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))')
          await page.screenshot({ path: `${dir}-${name}.png` })
        }
        const t = (key: string) => value(lang, key)
        const syncs = (await api(page, 'GET', 'live-syncs')) as {
          syncs: Array<{ id: string; state: string }>
        }
        for (const s of syncs.syncs) {
          if (!['completed', 'failed', 'stopped'].includes(s.state))
            await api(page, 'POST', `live-syncs/${s.id}/stop`)
          await api(page, 'DELETE', `live-syncs/${s.id}`)
        }

        // 1. The empty tab.
        await page.goto('live-syncs')
        await expect(page.getByText(t('liveSync.empty.title'))).toBeVisible()
        await shot('01-empty')

        // 2. The wizard: target, options, summary with warnings.
        const coll = `w${theme}${lang}`
        await mongo
          .db('review')
          .collection(coll)
          .insertMany(Array.from({ length: 50 }, (_, i) => ({ _id: i, email: `u${i}@x` })) as never[])
        await mongo
          .db('reviewcopy')
          .collection(coll)
          .insertOne({ _id: 'there' } as never)
        await page.goto(`c/${source}/db/review/coll/${coll}`)
        await page.keyboard.press('Control+k')
        await page
          .getByPlaceholder(t('palette.placeholder'))
          .fill(t('palette.commands.liveSync').replace('…', ''))
        await page.keyboard.press('Enter')
        const wizard = page.getByRole('dialog')
        await wizard.getByLabel(t('liveSync.wizard.targetConnection')).selectOption(target)
        await wizard.getByLabel(t('liveSync.wizard.database')).fill('reviewcopy')
        await shot('02-wizard-target')
        await wizard.getByRole('button', { name: t('liveSync.wizard.next') }).click()
        await shot('03-wizard-options')
        await wizard.getByRole('button', { name: t('liveSync.wizard.next') }).click()
        await expect(wizard.getByText(t('liveSync.warning.overwrite'))).toBeVisible({ timeout: 20_000 })
        await shot('04-wizard-summary-refused')
        await wizard.getByRole('button', { name: t('liveSync.wizard.back') }).click()
        await wizard.locator('input[type="radio"][value="merge"]').check()
        await wizard.getByRole('button', { name: t('liveSync.wizard.next') }).click()
        await wizard.getByLabel(t('liveSync.wizard.confirmOverwrite')).check()
        await expect(wizard.getByRole('button', { name: t('liveSync.wizard.start') })).toBeEnabled({
          timeout: 20_000,
        })
        await shot('05-wizard-summary-ready')
        await wizard.getByRole('button', { name: t('liveSync.wizard.start') }).click()

        // 3. Cards: live, paused, a refused document, completed.
        const card = (c: string) => page.locator('[data-sync]').filter({ hasText: c }).first()
        await expect(card(coll).locator('[data-state]')).toHaveText(new RegExp(t('liveSync.state.live')), {
          timeout: 60_000,
        })
        const paused = await startSync(page, mongo, source, target, `p${theme}${lang}`, {
          startMode: 'from_now',
        })
        const refused = `r${theme}${lang}`
        await mongo.db('reviewcopy').collection(refused).createIndex({ k: 1 }, { unique: true })
        await mongo
          .db('reviewcopy')
          .collection(refused)
          .insertOne({ _id: 'taken', k: 1 } as never)
        await startSync(page, mongo, source, target, refused, { startMode: 'from_now' })
        await expect
          .poll(async () => ((await api(page, 'GET', `live-syncs/${paused}`)) as { state: string }).state, {
            timeout: 30_000,
          })
          .toBe('live')
        await api(page, 'POST', `live-syncs/${paused}/pause`)
        await mongo
          .db('review')
          .collection(refused)
          .insertOne({ _id: 'clash', k: 1 } as never)
        await expect(card(refused).locator('[data-state]')).toHaveText(
          new RegExp(t('liveSync.state.attention')),
          { timeout: 60_000 },
        )
        await card(coll)
          .getByRole('button', { name: t('liveSync.action.verify') })
          .click()
        await expect(card(coll)).toContainText(t('liveSync.card.verified').split('{')[0]!.trim(), {
          timeout: 60_000,
        })
        await shot('06-cards')

        // 4. Details, and the finish dialog.
        // The card's own menu (its label puts the name first in Turkish).
        await card(coll).locator('button[aria-haspopup="menu"]').click()
        await page.getByRole('menuitem', { name: t('liveSync.action.details') }).click()
        await expect(page.getByRole('heading', { name: t('liveSync.detail.activity') })).toBeVisible()
        await shot('07-details')
        await page.keyboard.press('Escape')
        await card(coll)
          .getByRole('button', { name: t('liveSync.action.finish') })
          .click()
        await shot('08-finish')
        await page.getByRole('button', { name: t('liveSync.finish.confirm') }).click()
        await expect(card(coll).locator('[data-state]')).toHaveText(
          new RegExp(t('liveSync.state.completed')),
          { timeout: 60_000 },
        )
        await shot('09-completed')
      }
  } finally {
    // The next spec (Watch) names its collections as this one does: none is left behind.
    await mongo
      .db('review')
      .dropDatabase()
      .catch(() => undefined)
    await mongo
      .db('reviewcopy')
      .dropDatabase()
      .catch(() => undefined)
    await mongo.close()
  }
})
