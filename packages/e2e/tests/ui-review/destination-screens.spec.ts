// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Locator, Page, WebSocketRoute } from '@playwright/test'
import { expect, openDatabaseBackups, showDatabaseBackups, signIn, test } from '../../fixtures'

/**
 * Phase 3d-3b V9: every destination screen — the destinations page (empty, failing, every status) and
 * editor (a passed and a failed test, the Google device sign-in), Where in the dump sheet, copies (being
 * sent, failed with Retry), a destination's list, sending, restoring from a destination and a download
 * in progress — in light and dark, English and Turkish, as PNGs for review against U1–U14 and V1–V8.
 * Nothing here reaches the network: the seeded S3 and WebDAV destinations sit at documentation
 * addresses the egress refuses at once, and Google's sign-in is scripted in the browser.
 * Run: MM_UI_REVIEW=1 pnpm --filter @mongo-manager/e2e ui-review (after a build).
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

/** A message as a pattern: its text up to the first placeholder (the whole text when exact). */
function text(lang: 'en' | 'tr', key: string, exact = false): RegExp {
  const value = key.split('.').reduce<string | Tree>((t, k) => (t as Tree)[k]!, locales[lang]) as string
  const head = value.split('|')[0]!.split('{')[0]!.trim()
  const escaped = head.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(exact ? `^${escaped}$` : escaped)
}

/** A message with its placeholders filled (first plural form), for messages that start with one. */
function say(lang: 'en' | 'tr', key: string, values: Record<string, string>): string {
  const value = key.split('.').reduce<string | Tree>((t, k) => (t as Tree)[k]!, locales[lang]) as string
  return value
    .split('|')[0]!
    .trim()
    .replace(/\{(\w+)\}/g, (_, k: string) => values[k] ?? '')
}

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

type DestinationRow = { id: string; name: string; status: { state: string } }

/**
 * Three destinations, made once: a tested folder, and a Cold Storage bucket and a Nextcloud at
 * documentation addresses (192.0.2.0/24, never reachable) whose tests fail at once — "Needs attention".
 */
async function seed(page: Page): Promise<Record<string, string>> {
  const all = (await api(page, 'GET', 'backup-destinations/all')) as DestinationRow[]
  const ids = Object.fromEntries(all.map((d) => [d.name, d.id]))
  const want = [
    { type: 'folder', name: 'Server disk', config: { path: join(process.env.MM_E2E_DEST_ROOT!, 'review') } },
    {
      type: 's3',
      name: 'Spaces archive',
      config: {
        preset: 'spacesCold',
        endpoint: 'https://192.0.2.30',
        region: 'fra1',
        bucket: 'mm-archive',
        // An address, not a name: no DNS lookup of "mm-archive.192.0.2.30".
        pathStyle: true,
      },
      secrets: { accessKeyId: 'DO00EXAMPLEKEY', secretAccessKey: 'example-secret-key-0000' },
    },
    {
      type: 'webdav',
      name: 'Office Nextcloud',
      config: {
        preset: 'nextcloud',
        url: 'https://192.0.2.20/remote.php/dav/files/backup',
        username: 'backup',
      },
      secrets: { password: 'example-app-password' },
    },
  ]
  for (const d of want)
    if (!ids[d.name]) ids[d.name] = ((await api(page, 'POST', 'backup-destinations', d)) as { id: string }).id
  await api(page, 'POST', `backup-destinations/${ids['Server disk']}/test`, {})
  // Tests are rate-limited per administrator: the refused ones are tested once.
  const now = (await api(page, 'GET', 'backup-destinations/all')) as DestinationRow[]
  for (const name of ['Spaces archive', 'Office Nextcloud'])
    if (now.find((d) => d.name === name)?.status.state !== 'failed')
      await api(page, 'POST', `backup-destinations/${ids[name]}/test`, {})
  return ids
}

/** A Drive connected by OAuth whose sign-in Google no longer accepts (only the page sees it). */
const reconnectDrive = (now: number) => ({
  id: randomUUID(),
  name: 'Team Drive',
  type: 'gdrive',
  config: {
    auth: 'oauth',
    clientId: '123456789012-review.apps.googleusercontent.com',
    folderName: 'Mongo Manager backups',
  },
  secrets: { clientSecret: true, refreshToken: true, serviceAccountKey: false },
  keyHint: null,
  policy: { encryptedOnly: true },
  status: {
    state: 'reconnect',
    checkedAt: now - 3_600_000,
    reason: 'reconnect',
    account: 'backups@example.com',
  },
  grants: [],
  usage: { copies: 12, bytes: 18 * 1024 ** 3 },
  createdAt: now - 30 * 86_400_000,
  updatedAt: now - 3_600_000,
})

const settle = (page: Page, ms = 700) => page.waitForTimeout(ms)
const next = (dialog: Locator, lang: 'en' | 'tr') =>
  dialog.getByRole('button', { name: text(lang, 'dataTransfer.next') }).click()

for (const theme of ['light', 'dark'] as const)
  for (const lang of ['en', 'tr'] as const)
    test(`destination screens — ${theme}, ${lang}`, async ({ page }) => {
      test.setTimeout(300_000)
      const T = (key: string, exact = false) => text(lang, key, exact)

      // Scripted answers, switched per screen: the admin list, Google's device sign-in, a copy and a
      // download in progress, and jobs pushed through the real-time channel.
      let adminList: 'real' | 'empty' | 'error' | 'reconnect' = 'real'
      await page.route(/\/api\/backup-destinations\/all$/, async (route) => {
        if (adminList === 'empty') return route.fulfill({ json: [] })
        if (adminList === 'error')
          return route.fulfill({
            status: 500,
            json: { code: 'internal', message: 'Internal server error', correlationId: 'review' },
          })
        if (adminList === 'real') return route.continue()
        const res = await route.fetch()
        return route.fulfill({ response: res, json: [...(await res.json()), reconnectDrive(Date.now())] })
      })
      let deviceAnswer: { state: string; account?: string } = { state: 'pending' }
      await page.route(/\/api\/backup-destinations\/google\/device$/, (route) =>
        route.fulfill({
          json: {
            flowId: randomUUID(),
            userCode: 'WDJB-MJHT',
            verificationUrl: 'https://www.google.com/device',
            expiresAt: Date.now() + 30 * 60_000,
            interval: 1,
          },
        }),
      )
      await page.route(/\/api\/backup-destinations\/google\/device\/[^/]+$/, (route) =>
        route.fulfill({ json: deviceAnswer }),
      )
      let sendingCopy: { backupId: string; copy: object } | null = null
      await page.route(/\/api\/backups(\?[^/]*)?$/, async (route) => {
        if (!sendingCopy || route.request().method() !== 'GET') return route.continue()
        const res = await route.fetch()
        const rows = (await res.json()) as Array<{ id: string; copies: object[] }>
        const { backupId, copy } = sendingCopy
        return route.fulfill({
          response: res,
          json: rows.map((r) => (r.id === backupId ? { ...r, copies: [...r.copies, copy] } : r)),
        })
      })
      let fakeFetch: { uploadId: string; job: object; size: number } | null = null
      await page.route(/\/api\/backup-destinations\/[^/]+\/backups\/fetch$/, (route) =>
        fakeFetch
          ? route.fulfill({
              status: 202,
              json: { uploadId: fakeFetch.uploadId, job: fakeFetch.job, verified: true },
            })
          : route.continue(),
      )
      await page.route(/\/api\/backups\/inspect$/, (route) => {
        const body = route.request().postDataJSON() as { source?: { uploadId?: string } } | null
        if (!fakeFetch || body?.source?.uploadId !== fakeFetch.uploadId) return route.continue()
        const { size } = fakeFetch
        return route.fulfill({ json: { state: 'waiting', received: Math.round(size * 0.42), size } })
      })
      // The real channel, passed through; scripted jobs are pushed after its snapshot (which replaces
      // the whole list).
      let jobsSocket: WebSocketRoute | null = null
      let snapshotSeen = false
      await page.routeWebSocket(/\/ws$/, (ws) => {
        jobsSocket = ws
        const server = ws.connectToServer()
        server.onMessage((message) => {
          ws.send(message)
          if (typeof message === 'string' && message.includes('"type":"snapshot"')) snapshotSeen = true
        })
      })
      const pushJob = (job: object) =>
        jobsSocket?.send(JSON.stringify({ ch: 'jobs', type: 'update', payload: { job, now: Date.now() } }))
      const dropJob = (id: string) =>
        jobsSocket?.send(JSON.stringify({ ch: 'jobs', type: 'gone', payload: { id } }))

      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
      await page.setViewportSize({ width: 1440, height: 900 })
      await signIn(page)
      await expect(page.getByRole('button', { name: /^Account menu/ })).toBeVisible()
      await page.evaluate(
        ([th, l]) => localStorage.setItem('mm:preferences', JSON.stringify({ theme: th, locale: l })),
        [theme, lang] as const,
      )
      const dir = `test-results/ui-review/dest-${theme}-${lang}`
      const shot = (name: string) => page.screenshot({ path: `${dir}-${name}.png` })

      // The destinations page: empty (in every run), then failing to load.
      adminList = 'empty'
      await page.goto('destinations')
      await expect(page.getByRole('heading', { name: T('destinations.empty.title') })).toBeVisible()
      await settle(page)
      await shot('00-destinations-empty')
      adminList = 'error'
      await page.goto('destinations')
      await expect(page.getByRole('alert').first()).toBeVisible({ timeout: 20_000 })
      await settle(page)
      await shot('00b-destinations-error')

      // Every status: Healthy, Needs attention (the refused addresses), Reconnect needed (Drive).
      adminList = 'real'
      const ids = await seed(page)
      adminList = 'reconnect'
      await page.goto('destinations')
      await expect(page.getByText(T('destinations.status.reconnect', true))).toBeVisible()
      await expect(page.getByText(T('destinations.status.failed', true)).first()).toBeVisible()
      await settle(page)
      await shot('01-destinations-list')
      // The Drive's own editor offers Reconnect, with the stored client secret.
      await page
        .getByRole('article', { name: 'Team Drive' })
        .getByRole('button', { name: say(lang, 'destinations.card.actions', { name: 'Team Drive' }) })
        .click()
      await page.getByRole('menuitem', { name: T('destinations.card.edit') }).click()
      const editor = page.getByRole('dialog')
      await expect(
        editor.getByRole('button', { name: T('destinations.drive.reconnect', true) }),
      ).toBeVisible()
      await settle(page)
      await shot('01b-editor-drive-reconnect')
      adminList = 'real'

      // The editor: type, S3 provider (Cold Storage), connection — at 1440 and 1024.
      await page.goto('destinations')
      await page
        .getByRole('button', { name: T('destinations.add') })
        .first()
        .click()
      await settle(page)
      await shot('02-editor-type')
      await editor.getByRole('radio', { name: T('destinations.type.s3') }).check()
      await next(editor, lang)
      await editor.getByRole('radio', { name: T('destinations.preset.spacesCold') }).check()
      await settle(page)
      await shot('03-editor-s3-provider')
      await next(editor, lang)
      await settle(page)
      await shot('04-editor-s3-connection')
      await page.setViewportSize({ width: 1024, height: 768 })
      await settle(page)
      await shot('04b-editor-s3-connection-1024')
      await page.setViewportSize({ width: 1440, height: 900 })

      // Google Drive: the connection step, then the device sign-in waiting, approved and expired.
      await page.goto('destinations')
      await page
        .getByRole('button', { name: T('destinations.add') })
        .first()
        .click()
      await editor.getByRole('radio', { name: T('destinations.type.gdrive') }).check()
      await next(editor, lang)
      await settle(page)
      await shot('05-editor-drive-provider')
      await next(editor, lang)
      await settle(page)
      await shot('05-editor-drive-connection')
      await editor
        .getByLabel(T('destinations.drive.clientId', true))
        .fill('123456789012-review.apps.googleusercontent.com')
      await editor.getByLabel(T('destinations.drive.clientSecret', true)).fill('GOCSPX-review-client-secret')
      deviceAnswer = { state: 'pending' }
      await editor.getByRole('button', { name: T('destinations.drive.connect') }).click()
      await expect(editor.getByText('WDJB-MJHT')).toBeVisible()
      await expect(editor.getByText(T('destinations.drive.waiting'))).toBeVisible()
      await settle(page, 2200)
      await shot('05c-editor-drive-waiting')
      deviceAnswer = { state: 'approved', account: 'backups@example.com' }
      await expect(
        editor.getByText(say(lang, 'destinations.drive.connected', { account: 'backups@example.com' })),
      ).toBeVisible({ timeout: 10_000 })
      await settle(page)
      await shot('05d-editor-drive-approved')
      deviceAnswer = { state: 'expired' }
      await editor.getByRole('button', { name: T('destinations.drive.again', true) }).click()
      await expect(editor.getByText(T('destinations.drive.expired', true))).toBeVisible({ timeout: 10_000 })
      await settle(page)
      await shot('05e-editor-drive-expired')

      // WebDAV: the connection step, then a test that fails at once (an address never allowed) and
      // the question before saving it untested.
      await page.goto('destinations')
      await page
        .getByRole('button', { name: T('destinations.add') })
        .first()
        .click()
      await editor.getByRole('radio', { name: T('destinations.type.webdav') }).check()
      await next(editor, lang)
      await settle(page)
      await shot('06-editor-webdav-provider')
      await next(editor, lang)
      await settle(page)
      await shot('06-editor-webdav-connection')
      await editor.getByLabel(T('destinations.editor.name', true)).fill('Branch office')
      await editor.getByLabel(T('destinations.editor.url', true)).fill('https://192.0.2.10/dav')
      await editor.getByLabel(T('destinations.editor.username', true)).fill('backup')
      await editor.getByLabel(T('destinations.editor.password', true)).fill('example-app-password')
      await next(editor, lang)
      await next(editor, lang)
      await editor.getByRole('button', { name: T('destinations.test.run') }).click()
      await expect(editor.getByText(T('destinations.test.skipped', true)).first()).toBeVisible()
      await settle(page, 1200)
      await shot('06c-editor-test-failed')
      await editor.getByRole('button', { name: T('destinations.editor.save', true) }).click()
      await expect(editor.getByRole('alertdialog')).toBeVisible()
      await settle(page)
      await shot('06d-editor-save-untested')

      // A folder: access, then the live test.
      await page.goto('destinations')
      await page
        .getByRole('button', { name: T('destinations.add') })
        .first()
        .click()
      await editor.getByRole('radio', { name: T('destinations.type.folder') }).check()
      await next(editor, lang)
      await editor.getByLabel(T('destinations.editor.name', true)).fill('Review disk')
      await editor
        .getByLabel(T('destinations.editor.path', true))
        .fill(join(process.env.MM_E2E_DEST_ROOT!, `review-${theme}-${lang}`))
      await next(editor, lang)
      await settle(page)
      await shot('07-editor-access')
      await next(editor, lang)
      await editor.getByRole('button', { name: T('destinations.test.run') }).click()
      await expect(editor.getByText(T('destinations.test.step.delete'))).toBeVisible()
      await settle(page, 1200)
      await shot('08-editor-test-passed')

      // Where, in the dump sheet: a refusal first (a plain archive to an encrypted-only destination).
      const list = (await (await page.request.get('api/connections')).json()) as Array<{
        id: string
        name: string
      }>
      const id = list.find((c) => c.name === 'Local test')!.id
      const db = `dest_${theme}_${lang}`
      await api(page, 'POST', `connections/${id}/databases/${db}/collections/orders/documents`, {
        documents: Array.from({ length: 30 }, (_, i) => ({ i, total: i * 3 })),
      })
      const card = await openDatabaseBackups(page, id, db)
      await card.scrollIntoViewIfNeeded()
      await card.getByRole('button', { name: T('backup.start') }).click()
      const dump = page.getByRole('dialog')
      await settle(page, 1200)
      // Encrypted-only destinations say why they cannot take a plain archive, and offer the fix.
      await expect(dump.locator('[data-destination]').first()).toBeVisible()
      await settle(page, 1200)
      await shot('09-dump-where-refused')
      await dump.getByRole('radio', { name: T('backup.format.mmbak') }).check()
      await dump.getByLabel(T('backup.password.label', true)).fill('correct horse battery staple')
      await dump.getByLabel(T('backup.password.repeat')).fill('correct horse battery staple')
      await dump.locator('[data-destination]').filter({ hasText: 'Server disk' }).click()
      await settle(page, 1200)
      await shot('10-dump-where-ready')
      await dump
        .getByRole('button', { name: T('backup.start') })
        .last()
        .click()
      await expect(dump).toBeHidden()

      // Copies on the kept backup, then the destination's own list.
      const row = card.locator('[data-backup-row]').first()
      await expect(row).toBeVisible({ timeout: 60_000 })
      // The copy's badge: sent to Server disk, read back and verified.
      await expect(row.locator('li').filter({ hasText: 'Server disk' })).toBeVisible({ timeout: 60_000 })
      await settle(page)
      await shot('11-backups-copies')
      await card.getByRole('tab', { name: 'Server disk' }).click()
      await expect(card.locator('[data-remote-row]').first()).toBeVisible({ timeout: 15_000 })
      await settle(page)
      await shot('12-remote-list')

      // Send the kept backup elsewhere: to the Nextcloud at a refused address, which fails at once
      // and leaves a failed copy with its reason, Retry and Discard.
      await card.locator('[data-source="server"]').click()
      // UI redesign R3 leftovers: a backup's Send is in its row's "…" menu.
      await card
        .getByRole('button', { name: /^(?:Actions for .+|.+ için işlemler)$/ })
        .first()
        .click()
      await page.getByRole('menuitem', { name: T('backup.list.send') }).click()
      const send = page.getByRole('dialog')
      await settle(page)
      await shot('13-send-dialog')
      await send.locator('[data-destination]').filter({ hasText: 'Office Nextcloud' }).click()
      await send.getByRole('button', { name: T('backup.send.send', true) }).click()
      await expect(send).toBeHidden()
      const failedCopy = row.locator('[data-copy-failed]')
      await expect(failedCopy).toBeVisible({ timeout: 30_000 })
      await expect(failedCopy.getByText(T('backup.copies.retry', true))).toBeVisible()
      await settle(page)
      await shot('16-copy-failed')

      // A send in progress (scripted): its copy's progress on the row, and in the jobs a send that
      // moves and one waiting for its destination's transfer slot.
      const kept = (await api(page, 'GET', `backups?connectionId=${id}`)) as Array<{
        id: string
        name: string
        size: number
        scope: { db?: string }
      }>
      const backup = kept.find((b) => b.scope.db === db)!
      sendingCopy = {
        backupId: backup.id,
        copy: {
          id: randomUUID(),
          destinationId: ids['Spaces archive'],
          destinationName: 'Spaces archive',
          state: 'sending',
          sent: Math.round(backup.size * 0.42),
          size: backup.size,
          error: null,
          reason: null,
          completedAt: null,
        },
      }
      const job = (over: object) => ({
        id: randomUUID(),
        kind: 'backup.send',
        connectionId: id,
        db,
        coll: '*',
        targetConnectionId: null,
        target: backup.name,
        state: 'running',
        progress: null,
        estimate: null,
        error: null,
        startedAt: Date.now() - 40_000,
        finishedAt: null,
        mine: true,
        cancellable: true,
        ...over,
      })
      const moving = job({ progress: { done: Math.round(backup.size * 0.4), total: backup.size } })
      const waiting = job({
        target: `${backup.name.replace(/\.mmbak$/, '')}-2.mmbak`,
        progress: { done: 0, total: backup.size },
        waitingFor: ['Spaces archive'],
      })
      snapshotSeen = false
      await page.reload()
      await showDatabaseBackups(page, id, db)
      await expect.poll(() => snapshotSeen, { timeout: 15_000 }).toBe(true)
      pushJob(moving)
      pushJob(waiting)
      await settle(page, 1100)
      pushJob({ ...moving, progress: { done: Math.round(backup.size * 0.42), total: backup.size } })
      await expect(
        card.locator('[data-backup-row]').first().getByRole('progressbar', { name: 'Spaces archive' }),
      ).toBeVisible({ timeout: 15_000 })
      await page.getByRole('button', { name: T('jobs.title') }).click()
      await expect(page.locator('[data-test="jobs-panel"]')).toContainText(
        say(lang, 'jobs.waitingFor', { names: 'Spaces archive' }),
      )
      await settle(page)
      await shot('17-send-in-progress')
      await page.keyboard.press('Escape')
      dropJob(moving.id)
      dropJob(waiting.id)
      sendingCopy = null

      // Restore from a destination: the picker, then a download being previewed.
      await openDatabaseBackups(page, id, db)
      await card.scrollIntoViewIfNeeded()
      await card
        .getByRole('button', { name: T('backup.menu.restore') })
        .first()
        .click()
      let restore = page.getByRole('dialog')
      await restore.getByRole('tab', { name: T('backup.restore.source.destination') }).click()
      // The seeded Nextcloud and Spaces bucket are refused: their error states are screens too.
      await settle(page, 1500)
      await shot('14a-restore-picker-unreachable')
      await restore
        .getByRole('combobox', { name: T('backup.remote.source') })
        .selectOption({ label: 'Server disk' })
      await expect(restore.locator('[data-remote-pick]').first()).toBeVisible({ timeout: 15_000 })
      await settle(page)
      await shot('14-restore-picker')
      await restore.locator('[data-remote-pick]').first().click()
      await settle(page, 1500)
      await shot('15-restore-fetched')

      // A download in progress (scripted): the sheet waits for it, and the jobs show it.
      fakeFetch = {
        uploadId: randomUUID(),
        size: backup.size,
        job: job({
          kind: 'backup.fetch',
          db: '*',
          progress: { done: Math.round(backup.size * 0.42), total: backup.size },
          verified: true,
        }),
      }
      await openDatabaseBackups(page, id, db)
      await card.scrollIntoViewIfNeeded()
      await card
        .getByRole('button', { name: T('backup.menu.restore') })
        .first()
        .click()
      restore = page.getByRole('dialog')
      await restore.getByRole('tab', { name: T('backup.restore.source.destination') }).click()
      await restore
        .getByRole('combobox', { name: T('backup.remote.source') })
        .selectOption({ label: 'Server disk' })
      await restore.locator('[data-remote-pick]').first().click()
      await expect(restore.getByText(T('backup.remote.waiting')).first()).toBeVisible()
      await settle(page, 1200)
      await shot('18-fetch-in-progress')
      fakeFetch = null
    })
