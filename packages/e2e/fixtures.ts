// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { test as base, expect, type BrowserContext, type Locator, type Page } from '@playwright/test'
import { mintLaunchToken, readLaunchSecret } from '../server/src/auth/launch'
import { LOCAL_PORT } from './playwright.config'

export const ADMIN = { username: 'admin', password: 'correct-horse-battery-1' }

const CSP_VIOLATION = /Content Security Policy|Refused to (apply|load|execute|evaluate)/i

/** Collects CSP violations of a page; use it for pages of extra browser contexts too. */
export function watchCsp(page: Page, violations: string[]): void {
  page.on('console', (message) => {
    if (CSP_VIOLATION.test(message.text())) violations.push(message.text())
  })
}

/**
 * Records every request and websocket of a page that leaves the app's origin (data: and blob:
 * URLs never leave the browser). Use it for pages of extra browser contexts too.
 */
export function watchOrigins(page: Page, appOrigin: string, foreign: string[]): void {
  watchContext(page.context(), appOrigin, foreign)
}

const watched = new WeakMap<BrowserContext, string[]>()

/**
 * Watches a whole browser context: every page, popup and service worker in it, and every
 * websocket its pages open. Watching the same context twice records each request once.
 */
export function watchContext(context: BrowserContext, appOrigin: string, foreign: string[]): void {
  if (watched.has(context)) return
  watched.set(context, foreign)
  const leaves = (url: string) => !/^(data|blob|about):/.test(url) && new URL(url).origin !== appOrigin
  context.on('request', (request) => {
    if (leaves(request.url())) foreign.push(`${request.method()} ${request.url()}`)
  })
  const sockets = (page: Page) =>
    page.on('websocket', (ws) => {
      if (leaves(ws.url().replace(/^ws/, 'http'))) foreign.push(`WEBSOCKET ${ws.url()}`)
    })
  context.pages().forEach(sockets)
  context.on('page', sockets)
}

/**
 * Security audit 2026-10-16: a one-time link that opens the local-mode server, made from its data
 * directory's secret as `mongo-manager open` makes it.
 */
export function localLaunchPath(): string {
  const secret = readLaunchSecret(process.env.MM_E2E_LOCAL_DIR!)
  if (!secret) throw new Error('The local-mode server has no launch secret')
  return `launch/${mintLaunchToken(secret, Date.now())}`
}

/**
 * Review of the audit fixes (important 1): local mode answers an API call only with the browser's
 * page key besides its cookie; the page keeps the key in its own storage. The headers a test's own
 * request (page.request) needs to be that page.
 */
export async function localHeaders(page: Page): Promise<Record<string, string>> {
  const key = await page.evaluate(() => localStorage.getItem('mm:local-key'))
  return key ? { 'x-mm-local': key } : {}
}

export const test = base.extend<{ cspViolations: string[]; foreignRequests: string[]; launched: void }>({
  /** Every test fails on a Content-Security-Policy violation in the browser console (Review Focus 5). */
  cspViolations: [
    async ({ page }, use) => {
      const violations: string[] = []
      watchCsp(page, violations)
      await use(violations)
      expect(violations, 'CSP violations').toEqual([])
    },
    { auto: true },
  ],
  /** Every test fails if the browser contacts any origin but the app's (spec §3.6 offline test). */
  foreignRequests: [
    async ({ context, baseURL }, use) => {
      const foreign: string[] = []
      watchContext(context, new URL(baseURL!).origin, foreign)
      await use(foreign)
      expect(foreign, 'requests to other origins').toEqual([])
    },
    { auto: true },
  ],
  /**
   * In local mode every test's browser first opens the app from a launch link, as a person does: the
   * API answers only a browser holding its cookie (security audit 2026-10-16). Set up after the
   * watchers above, so they see this load too.
   */
  launched: [
    async ({ page, baseURL }, use) => {
      if (baseURL && new URL(baseURL).port === String(LOCAL_PORT)) {
        await page.goto(localLaunchPath())
        await page.waitForURL((url) => !url.pathname.includes('/launch/'))
        // CI 2026-10-20: the page claims its key once, after the link; a test that went on before
        // the claim's answer came left the claim used and the key with no page: "not allowed".
        await page
          .waitForFunction(() => localStorage.getItem('mm:local-key') !== null, undefined, {
            timeout: 15_000,
          })
          .catch((e: unknown) => {
            throw new Error('The page did not store its local key within 15 s', {
              cause: e,
            })
          })
      }
      await use()
    },
    { auto: true },
  ],
})
export { expect }

/**
 * The documents table's row whose `name` cell is `name`, by that cell alone: a row's text holds its
 * ObjectId too, whose hex can spell a name (6ada… on 2026-10-23 matched "Ada"; CI 2026-10-23).
 */
export function rowNamed(page: Page, name: string): Locator {
  return page
    .locator('tbody tr')
    .filter({ has: page.locator('td[data-field="name"] [data-cell-value]').getByText(name, { exact: true }) })
}

export async function signIn(page: Page, user = ADMIN): Promise<void> {
  await page.goto('/')
  await page.getByLabel('Username').fill(user.username)
  await page.getByLabel('Password', { exact: true }).fill(user.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
}

/** UI redesign R1 revision 2 §3.1: opens a page from a sidebar group (opening the group if needed). */
export async function openFromSidebar(page: Page, group: string, item: string): Promise<void> {
  const nav = page.getByRole('navigation', { name: 'Application' })
  const toggle = nav.getByRole('button', { name: new RegExp(`^${group}`) }).first()
  if ((await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click()
  await nav.getByRole('button', { name: new RegExp(`^${item}`) }).click()
}

/** UI redesign R1 revision 2 §3.2: Sign out is the account menu's last item. */
export async function signOut(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^Account menu/ }).click()
  await page.getByRole('menuitem', { name: 'Sign out' }).click()
}

/**
 * User request 2026-10-24: a database's backups are a tab of its own (named by its id, so in either
 * language): the database's page with that tab open, and its Backups card.
 */
export async function openDatabaseBackups(page: Page, connectionId: string, db: string): Promise<Locator> {
  await page.goto(`c/${connectionId}/db/${db}`)
  return showDatabaseBackups(page, connectionId, db)
}

/** The database's Backups tab chosen on its page (again after a reload: the section is not kept). */
export async function showDatabaseBackups(page: Page, connectionId: string, db: string): Promise<Locator> {
  await page.locator('#main [role="tab"][id$="-backups"]').click()
  return page.locator(`#backups-${connectionId}-${db}`)
}

/** User request 2026-10-24: one entry of a personal-data rule, picked from what its picker lists. */
export async function pickRulePart(page: Page, card: Locator, marker: string, name: string): Promise<void> {
  await card.locator(`[${marker}] button`).click()
  await page
    .getByRole('option')
    .filter({ has: page.getByText(name, { exact: true }) })
    .click()
}

export async function openAccount(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^Account menu/ }).click()
  await page.getByRole('menuitem', { name: 'Account settings' }).click()
  await expect(page.getByRole('heading', { name: 'Two-factor authentication' })).toBeVisible()
}
