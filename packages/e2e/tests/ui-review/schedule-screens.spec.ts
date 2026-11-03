import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { expect, signIn, test } from '../../fixtures'

/**
 * Phase 3d-3c V9: every schedule and key screen — the Scheduled backups tab (empty, cards in every
 * state, scheduling off, a card's menu), the run history, the editor's steps and their variants,
 * Account settings → Backup keys with the create and import flows, restoring a backup-key file, and
 * the user menu's badge — in light and dark, English and Turkish, as PNGs for review against U1–U15
 * and V1–V8. The tab's lists, a kept backup and the restore's answers are scripted in the browser;
 * the destination and the active key are real. Run: MM_UI_REVIEW=1 pnpm --filter @mongo-manager/e2e ui-review.
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
const value = (lang: 'en' | 'tr', key: string) =>
  key.split('.').reduce<string | Tree>((t, k) => (t as Tree)[k]!, locales[lang]) as string
/** A message as a pattern: its text up to the first placeholder (the whole text when exact). */
function text(lang: 'en' | 'tr', key: string, exact = false): RegExp {
  const head = value(lang, key).split('|')[0]!.split('{')[0]!.trim()
  const escaped = head.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(exact ? `^${escaped}$` : escaped)
}
/** A message with its placeholders filled (first plural form). */
const say = (lang: 'en' | 'tr', key: string, values: Record<string, string>) =>
  value(lang, key)
    .split('|')[0]!
    .trim()
    .replace(/\{(\w+)\}/g, (_, k: string) => values[k] ?? '')

async function api(page: Page, method: 'POST' | 'GET', path: string, data?: object) {
  const me = await (await page.request.get('api/auth/me')).json()
  const res = await page.request.fetch(`api/${path}`, {
    method,
    ...(data ? { data } : {}),
    headers: { 'x-csrf-token': me.csrfToken, origin: new URL(page.url()).origin },
  })
  expect(res.ok(), await res.text()).toBe(true)
  return res.json()
}

const HOUR = 3_600_000
const DAY = 24 * HOUR
const OUTCOMES = [
  'succeeded',
  'succeeded',
  'partial',
  'succeeded',
  'failed',
  'succeeded',
  'skipped',
  'succeeded',
  'missed',
  'succeeded',
  'succeeded',
  'succeeded',
  'partial',
  'succeeded',
]
const marks = (now: number, from = 0) =>
  OUTCOMES.slice(from).map((outcome, i) => ({
    id: randomUUID(),
    dueAt: now - (14 - from - i) * DAY,
    outcome,
    reason: outcome === 'partial' ? 'send_failed' : outcome === 'failed' ? 'connection' : null,
  }))

/** Every state a card can be in. */
function scripted(
  now: number,
  connectionId: string,
  destination: { id: string; name: string },
  key: { id: string; fingerprint: string },
) {
  const base = {
    owner: { id: 'admin', username: 'admin' },
    mine: true,
    connectionId,
    connectionName: 'Local test',
    dump: {
      scope: { kind: 'database', db: 'shop', views: true },
      engine: 'builtin',
      indexes: true,
      options: true,
      anonymous: false,
    },
    format: 'mmbak',
    key: { id: key.id, name: 'Key 1', fingerprint: key.fingerprint, state: 'active' },
    timeZone: 'Europe/Istanbul',
    destinations: [{ ...destination, coldStorage: false }],
    keepOnServer: false,
    retention: { last: 7, daily: 14, weekly: 8, monthly: 12 },
    state: 'active',
    pause: null,
    createdAt: now - 30 * DAY,
    updatedAt: now - DAY,
  }
  return [
    {
      ...base,
      id: randomUUID(),
      name: 'Nightly shop',
      cadence: { kind: 'daily', times: ['02:00'] },
      nextRunAt: now + 5 * HOUR,
      lastRuns: marks(now),
    },
    {
      ...base,
      id: randomUUID(),
      name: 'Orders every 6 hours',
      cadence: { kind: 'hourly', every: 6, minute: 15 },
      keepOnServer: true,
      nextRunAt: now + 2 * HOUR,
      // Final review I4: a card whose last run failed shows it, with the reason.
      lastRuns: [
        ...marks(now, 5),
        { id: randomUUID(), dueAt: now - HOUR, outcome: 'failed', reason: 'connection' },
      ],
    },
    {
      ...base,
      id: randomUUID(),
      name: 'Weekday archive',
      cadence: { kind: 'cron', expression: '0 3 * * 1-5' },
      state: 'paused',
      nextRunAt: null,
      pause: { reason: 'key_inactive', by: 'system', byName: null },
      lastRuns: [],
    },
    {
      ...base,
      id: randomUUID(),
      name: 'Month-end export',
      format: 'gzip',
      key: null,
      cadence: { kind: 'monthly', day: 'last', time: '23:30' },
      state: 'paused',
      nextRunAt: null,
      pause: { reason: 'owner', by: 'owner', byName: null },
      lastRuns: marks(now, 13),
    },
    {
      ...base,
      id: randomUUID(),
      name: 'Reporting copy for the quarterly board pack, kept long',
      mine: false,
      owner: { id: 'bob', username: 'bob' },
      cadence: { kind: 'weekly', days: [1, 4], time: '04:00' },
      nextRunAt: now + 3 * DAY,
      lastRuns: [{ id: randomUUID(), dueAt: now - 10 * 60_000, outcome: 'running' }],
    },
  ]
}

/** A run history with every outcome and kind. */
function history(now: number, destination: { id: string; name: string }) {
  const run = (over: object) => ({
    id: randomUUID(),
    kind: 'scheduled',
    reason: null,
    message: null,
    backupId: null,
    dumpJobId: null,
    sendJobId: null,
    size: 48 * 1024 * 1024,
    copies: [{ destinationId: destination.id, name: destination.name, state: 'complete', reason: null }],
    removals: [],
    missed: null,
    missedMore: false,
    keyFingerprint: 'K-1a2b3c4d',
    ...over,
  })
  return [
    run({
      dueAt: now - HOUR,
      startedAt: now - HOUR,
      finishedAt: now - HOUR + 95_000,
      outcome: 'succeeded',
      removals: [{ location: destination.id, name: destination.name, removed: 2, failed: 0, waiting: 0 }],
    }),
    run({
      dueAt: now - DAY,
      startedAt: now - DAY,
      finishedAt: now - DAY + 140_000,
      outcome: 'partial',
      reason: 'send_failed',
      message: 'Not sent — Office NAS: The destination is full.',
      copies: [
        { destinationId: destination.id, name: destination.name, state: 'complete', reason: null },
        { destinationId: randomUUID(), name: 'Office NAS', state: 'failed', reason: 'quota' },
      ],
    }),
    run({
      dueAt: now - 2 * DAY,
      startedAt: now - 2 * DAY,
      finishedAt: now - 2 * DAY + 4000,
      outcome: 'failed',
      reason: 'connection',
      copies: [],
      size: null,
    }),
    run({
      dueAt: now - 3 * DAY,
      startedAt: null,
      finishedAt: now - 3 * DAY,
      outcome: 'skipped',
      reason: 'overlap',
      copies: [],
      size: null,
    }),
    run({
      dueAt: now - 5 * DAY,
      startedAt: null,
      finishedAt: now - 4 * DAY,
      outcome: 'missed',
      reason: 'server_down',
      copies: [],
      size: null,
      missed: 4,
    }),
    run({
      dueAt: now - 6 * DAY,
      kind: 'catchup',
      startedAt: now - 6 * DAY + HOUR,
      finishedAt: now - 6 * DAY + HOUR + 80_000,
      outcome: 'succeeded',
    }),
  ]
}

const settle = (page: Page, ms = 700) => page.waitForTimeout(ms)

for (const theme of ['light', 'dark'] as const)
  for (const lang of ['en', 'tr'] as const)
    test(`schedule screens — ${theme}, ${lang}`, async ({ page }) => {
      test.setTimeout(300_000)
      const T = (key: string, exact = false) => text(lang, key, exact)
      // The account menu is named after the user: "Account menu for ada", "ada hesap menüsü".
      const accountMenu = lang === 'tr' ? / hesap menüsü/ : /^Account menu/
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
      await page.setViewportSize({ width: 1440, height: 900 })
      await signIn(page)
      await expect(page.getByRole('button', { name: /^Account menu/ })).toBeVisible()
      await page.evaluate(
        ([th, l]) => localStorage.setItem('mm:preferences', JSON.stringify({ theme: th, locale: l })),
        [theme, lang] as const,
      )
      const dir = `test-results/ui-review/sched-${theme}-${lang}`
      const shot = (name: string, mask: Locator[] = []) =>
        page.screenshot({ path: `${dir}-${name}.png`, mask })

      // The real pieces: a folder destination and an active key (made once, kept for every run).
      const connections = (await (await page.request.get('api/connections')).json()) as Array<{
        id: string
        name: string
      }>
      const connectionId = connections.find((c) => c.name === 'Local test')!.id
      const all = (await api(page, 'GET', 'backup-destinations/all')) as Array<{ id: string; name: string }>
      const destination =
        all.find((d) => d.name === 'Review disk') ??
        ((await api(page, 'POST', 'backup-destinations', {
          type: 'folder',
          name: 'Review disk',
          config: { path: join(process.env.MM_E2E_DEST_ROOT!, 'sched-review') },
        })) as { id: string; name: string })
      let keys = (await api(page, 'GET', 'backup-keys')) as Array<{
        id: string
        fingerprint: string
        state: string
      }>
      if (!keys.some((k) => k.state === 'active')) {
        const created = (await api(page, 'POST', 'backup-keys', {})) as { key: { id: string }; kit: string }
        await api(page, 'POST', `backup-keys/${created.key.id}/confirm`, {
          check: created.kit.match(/MMKEY1-\S+/)![0].slice(-4),
        })
        keys = (await api(page, 'GET', 'backup-keys')) as typeof keys
      }
      const key = keys.find((k) => k.state === 'active')!
      const now = Date.now()

      // Scripted lists, switched per screen.
      let mode: 'empty' | 'scripted' | 'off' = 'scripted'
      const list = scripted(now, connectionId, destination, key)
      const runs = history(now, destination)
      await page.route(/\/api\/backup-schedules$/, (route) =>
        route.request().method() === 'GET'
          ? route.fulfill({ json: { enabled: mode !== 'off', schedules: mode === 'empty' ? [] : list } })
          : route.continue(),
      )
      await page.route(/\/api\/backup-schedules\/[^/]+\/runs$/, (route) => route.fulfill({ json: runs }))

      // 1. The tab: empty, the cards (1440 and 1024), scheduling off, a card's menu, the run history.
      mode = 'empty'
      await page.goto('schedules')
      await expect(page.getByRole('heading', { name: T('schedules.empty.title') })).toBeVisible()
      await settle(page)
      await shot('00-tab-empty')
      mode = 'scripted'
      await page.goto('schedules')
      const card = page.getByRole('article', { name: 'Nightly shop' })
      await expect(card).toBeVisible()
      await settle(page)
      await shot('01-tab-cards')
      await page.setViewportSize({ width: 1024, height: 768 })
      await settle(page)
      await shot('01b-tab-cards-1024')
      await page.setViewportSize({ width: 1440, height: 900 })
      mode = 'off'
      await page.goto('schedules')
      await expect(page.getByRole('status').first()).toBeVisible()
      await settle(page)
      await shot('02-tab-off')
      mode = 'scripted'
      await page.goto('schedules')
      await card
        .getByRole('button', { name: say(lang, 'schedules.card.more', { name: 'Nightly shop' }) })
        .click()
      await settle(page)
      await shot('03-card-menu')
      await page.keyboard.press('Escape')
      await card.getByRole('button', { name: T('schedules.card.history', true) }).click()
      await expect(page.getByRole('dialog')).toBeVisible()
      await settle(page)
      await shot('04-run-history')
      await page.keyboard.press('Escape')

      // 2. The editor: What, When in every form, Protection, Where, Retention presets, Summary.
      await page.getByRole('button', { name: T('schedules.new', true) }).click()
      const editor = page.getByRole('dialog')
      const nextStep = () => editor.getByRole('button', { name: T('schedules.editor.next', true) }).click()
      // The cadence chips hide their radio (sr-only) inside the label: choose one as a person does.
      const cadence = (kind: string) =>
        editor.locator(`label:has(> input[name="cadence"][value="${kind}"])`).click()
      await editor
        .getByLabel(T('schedules.editor.what.connection', true))
        .selectOption({ label: 'Local test' })
      await editor.locator('input[name="scope"][value="server"]').check()
      await settle(page)
      await shot('10-editor-what')
      await nextStep()
      for (const kind of ['hourly', 'daily', 'weekly', 'monthly'] as const) {
        await cadence(kind)
        if (kind === 'daily')
          for (let i = 0; i < 3; i++)
            await editor.getByRole('button', { name: T('schedules.editor.when.addTime', true) }).click()
        await settle(page)
        await shot(`11-editor-when-${kind}`)
      }
      await cadence('cron')
      await editor.getByLabel(T('schedules.editor.when.cronLabel', true)).fill('*/30 * * * *')
      await settle(page)
      await shot('11e-editor-when-cron-refused')
      await editor.getByLabel(T('schedules.editor.when.cronLabel', true)).fill('0 2 * * 1-5')
      await settle(page)
      await shot('11f-editor-when-cron')
      // A combobox (a datalist of zones) inside its label: getByLabel would read its value into the label.
      const zone = editor.getByRole('combobox', { name: T('schedules.editor.when.zone', true) })
      await zone.fill('Mars/Olympus')
      await settle(page)
      await shot('11g-editor-when-zone-invalid')
      await zone.fill('Europe/Istanbul')
      await nextStep()
      await settle(page, 1200)
      await shot('12-editor-protection')
      await nextStep()
      await editor.locator('[data-destination]').first().click()
      // Its label holds the help line too: the name starts with the choice.
      await editor.getByRole('checkbox', { name: T('schedules.editor.where.keep') }).check()
      await settle(page)
      await shot('13-editor-where')
      await nextStep()
      for (const preset of ['daily30', 'standard', 'long', 'custom'] as const) {
        await editor.locator(`input[name="retention"][value="${preset}"]`).check()
        await settle(page)
        await shot(`14-editor-retention-${preset}`)
      }
      await nextStep()
      await settle(page, 1500)
      await shot('15-editor-summary')
      await page.setViewportSize({ width: 1024, height: 768 })
      await settle(page)
      await shot('15b-editor-summary-1024')
      await page.setViewportSize({ width: 1440, height: 900 })
      await editor.getByRole('button', { name: T('common.cancel', true) }).click()
      await editor.getByRole('button', { name: T('common.sheet.discard', true) }).click()

      // 3. Backup keys: the list, an import refused, the create flow (on a scripted answer, kit masked).
      await page.getByRole('button', { name: accountMenu }).click()
      await page.getByRole('menuitem', { name: T('header.settings', true) }).click()
      await page.getByRole('heading', { name: T('keys.title', true) }).scrollIntoViewIfNeeded()
      await settle(page)
      await shot('20-keys')
      await page.getByRole('button', { name: T('keys.import', true) }).click()
      await page.getByLabel(T('keys.importFlow.kit', true)).fill('MMKEY1-AAAA-BBBB')
      // The sidebar has an Import button too: the one in the dialog.
      await page
        .getByRole('dialog')
        .getByRole('button', { name: T('keys.importFlow.submit', true) })
        .click()
      await settle(page)
      await shot('21-keys-import-refused')
      await page.keyboard.press('Escape')
      await page.route(/\/api\/backup-keys$/, (route) =>
        route.request().method() === 'POST'
          ? route.fulfill({
              status: 201,
              json: {
                key: {
                  id: randomUUID(),
                  name: 'Key 9',
                  fingerprint: 'K-0f1e2d3c',
                  state: 'pending',
                  createdAt: now,
                  confirmedAt: null,
                  retiredAt: null,
                  uses: { schedules: 0, backups: 0 },
                },
                kit: 'Mongo Manager — backup key recovery kit\n\nMMKEY1-0000-1111-2222-3333-4444-5555-6666-7777-8888-9999-AAAA-BBBB-CCCC-DDDD\n',
                fileName: 'mongo-manager-backup-key-K-0f1e2d3c.txt',
              },
            })
          : route.continue(),
      )
      await page
        .getByRole('button', { name: T('keys.rotate', true) })
        .first()
        .click()
      await page
        .getByRole('dialog')
        .getByRole('button', { name: T('keys.rotate', true) })
        .click()
      const flow = page.getByRole('dialog', { name: T('keys.createFlow.rotateTitle', true) })
      await settle(page)
      await shot('22-keys-create-intro')
      await flow.getByRole('button', { name: T('keys.create', true) }).click()
      await settle(page)
      await shot('23-keys-create-kit', [flow.locator('[data-test="kit"]')])
      await flow.getByLabel(T('keys.createFlow.saved', true)).check()
      await flow.getByRole('button', { name: T('keys.createFlow.next', true) }).click()
      await settle(page)
      await shot('24-keys-create-confirm')
      await flow.getByRole('button', { name: T('common.cancel', true) }).click()
      await page.getByRole('button', { name: T('keys.createFlow.leave', true) }).click()
      await page.unroute(/\/api\/backup-keys$/)

      // 4. Restoring a backup-key file: the kit asked for, another key's kit refused, opened with the key.
      const kept = {
        id: randomUUID(),
        name: 'shop-20261004-020000.mmbak',
        jobId: null,
        connectionId,
        scope: { kind: 'database', db: 'shop', views: true },
        engine: 'builtin',
        format: 'mmbak',
        masked: false,
        anonymous: false,
        size: 48 * 1024 * 1024,
        sha256: 'x',
        namespaces: 1,
        startedAt: now - 3 * HOUR,
        finishedAt: now - 3 * HOUR + 60_000,
        expiresAt: now + 21 * HOUR,
        copies: [],
        schedule: { id: list[0]!.id, name: 'Nightly shop' },
      }
      const summary = {
        container: 'mmbak',
        serverVersion: '8.2.6',
        toolVersion: 'mongo-manager 2.0.0',
        mongoManager: null,
        namespaces: [{ db: 'shop', coll: 'orders', type: 'collection', indexes: 2, ttl: [], capped: false }],
      }
      let inspectAnswer: object = { state: 'key', fingerprint: key.fingerprint, password: false }
      await page.route(/\/api\/backups(\?[^/]*)?$/, (route) =>
        route.request().method() === 'GET' ? route.fulfill({ json: [kept] }) : route.continue(),
      )
      await page.route(/\/api\/backups\/inspect$/, (route) =>
        (route.request().postDataJSON() as { kit?: string }).kit
          ? route.fulfill({
              status: 400,
              json: { code: 'VALIDATION_ERROR', message: 'x', details: { reason: 'backup_key' } },
            })
          : route.fulfill({ json: inspectAnswer }),
      )
      await page.route(/\/api\/connections\/[^/]+\/restore\/plan$/, (route) =>
        route.fulfill({
          json: {
            planHash: 'b'.repeat(64),
            summary,
            namespaces: [
              {
                from: { db: 'shop', coll: 'orders' },
                to: { db: 'shop', coll: 'orders' },
                type: 'collection',
                exists: false,
                documents: null,
                action: 'create',
                ttl: [],
                confirmName: false,
              },
            ],
            missingRules: [],
            mayAddRules: false,
            tools: { available: false },
            checks: [],
            refusals: [],
          },
        }),
      )
      const openRestore = async () => {
        await page.goto(`c/${connectionId}`)
        // The connection's backups are in its own Backups tab, not on the Overview.
        await page
          .getByRole('tablist', { name: value(lang, 'performance.sections.label') })
          .getByRole('tab', { name: value(lang, 'performance.sections.backups'), exact: true })
          .click()
        await page
          .locator(`#backups-${connectionId}`)
          .getByRole('button', { name: /^(?:Actions for .+|.+ için işlemler)$/ })
          .first()
          .click()
        await page.getByRole('menuitem', { name: T('backup.list.restore') }).click()
        return page.getByRole('dialog')
      }
      let restore = await openRestore()
      await expect(restore.locator('[data-test="kit-unlock"]')).toBeVisible()
      await settle(page)
      await shot('30-restore-kit')
      await restore.getByLabel(T('backup.unlock.kit', true)).fill('MMKEY1-0000-1111')
      await restore.getByRole('button', { name: T('backup.unlock.open', true) }).click()
      await settle(page)
      await shot('31-restore-kit-refused')
      await page.keyboard.press('Escape')
      inspectAnswer = {
        state: 'ready',
        summary,
        openedWith: { kind: 'key', fingerprint: key.fingerprint, name: 'Key 1' },
      }
      restore = await openRestore()
      // The whole sentence, its placeholders filled: in Turkish it starts with the key's name.
      await expect(
        restore
          .getByText(
            say(lang, 'backup.unlock.openedWithKey', { name: 'Key 1', fingerprint: key.fingerprint }),
          )
          .first(),
      ).toBeVisible()
      await settle(page)
      await shot('32-restore-opened-with-key')
      await page.setViewportSize({ width: 1024, height: 768 })
      await settle(page)
      await shot('32b-restore-opened-with-key-1024')
      await page.setViewportSize({ width: 1440, height: 900 })
      await page.keyboard.press('Escape')

      // 5. The user menu with the attention badge.
      await page.goto('schedules')
      await page.getByRole('button', { name: accountMenu }).click()
      await settle(page)
      await shot('40-user-menu-badge')
    })
