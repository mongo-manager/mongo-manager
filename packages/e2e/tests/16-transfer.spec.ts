// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { readFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { expect, signIn, test } from '../fixtures'

/** The API as the signed-in page sees it (same cookies, its CSRF token and origin). */
async function api(page: Page, path: string, data: object) {
  const me = await (await page.request.get('api/auth/me')).json()
  const res = await page.request.post(`api/${path}`, {
    data,
    headers: { 'x-csrf-token': me.csrfToken, origin: new URL(page.url()).origin },
  })
  expect(res.ok(), await res.text()).toBe(true)
  return res.json()
}

/** Phase 3d-1: upload a CSV, map, dry run, import; export the collection as xlsx and download it. */
test('imports a CSV through the wizard and exports the collection as xlsx (phase 3d-1)', async ({ page }) => {
  await signIn(page)
  await expect(page.getByRole('button', { name: /^Account menu/ })).toBeVisible()
  const list = (await (await page.request.get('api/connections')).json()) as Array<{
    id: string
    name: string
  }>
  const id = list.find((c) => c.name === 'Local test')!.id
  await api(page, `connections/${id}/databases/shop/collections/e2etransfer/documents`, {
    documents: [{ name: 'Seed' }],
  })
  await page.goto(`c/${id}/db/shop/coll/e2etransfer`)
  await expect(page.locator('tbody tr', { hasText: 'Seed' })).toBeVisible({ timeout: 15_000 })

  // Import: file, settings (a semicolon is detected), fields, then a dry run and the import. The
  // documents toolbar's buttons, not the sidebar's connection import and export.
  const documents = page.getByRole('tabpanel', { name: 'Documents' })
  // UI redesign R1: the results' data actions are in the toolbar's More menu.
  const fromResults = async (item: string) => {
    await documents.getByRole('button', { name: 'More actions for these results' }).click()
    await page.getByRole('menuitem', { name: item, exact: true }).click()
  }
  await fromResults('Import')
  const wizard = page.getByRole('dialog', { name: 'Import into e2etransfer' })
  await wizard.locator('input[type="file"]').setInputFiles({
    name: 'people.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('id;name;joined\n1;Ali;2024-01-02\n2;Veli;2024-03-04\n'),
  })
  await expect(wizard.getByRole('cell', { name: 'Veli' })).toBeVisible()
  await wizard.getByRole('button', { name: 'Next' }).click()
  await expect(wizard.getByLabel('Type of joined')).toHaveValue('date')
  await wizard.getByRole('button', { name: 'Next' }).click()
  await wizard.getByRole('button', { name: 'Dry run' }).click()
  await expect(wizard.locator('[data-transfer-report]')).toContainText('2 read', { timeout: 20_000 })
  await wizard.getByRole('button', { name: 'Import', exact: true }).click()
  await expect(wizard).toBeHidden()
  // The notice is shown, and read out by the live region: the same text twice.
  await expect(page.getByText('Import finished: people.csv', { exact: true }).first()).toBeVisible({
    timeout: 20_000,
  })
  await expect(page.locator('tbody tr', { hasText: 'Veli' })).toBeVisible()

  // Export: xlsx, then the download offered by the finished job.
  await fromResults('Export')
  const dialog = page.getByRole('dialog', { name: 'Export e2etransfer' })
  await dialog.getByLabel('Format').selectOption('xlsx')
  await dialog.getByRole('button', { name: 'Export', exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByText(/^Export ready: e2etransfer-/).first()).toBeVisible({ timeout: 20_000 })
  await page.getByRole('button', { name: /^Background jobs/ }).click()
  const panel = page.getByRole('dialog', { name: 'Background jobs' })
  // A finished job opens on the jobs page, its actions with it (jobs redesign, 2026-10-08).
  await panel.locator('[data-job]').filter({ hasText: 'Export' }).first().getByRole('button').first().click()
  const downloading = page.waitForEvent('download')
  await page.locator('[data-job-actions]').getByRole('link', { name: 'Download' }).first().click()
  const download = await downloading
  expect(download.suggestedFilename()).toMatch(/^e2etransfer-\d{8}-\d{6}\.xlsx$/)
  const bytes = readFileSync((await download.path())!)
  expect(bytes.subarray(0, 2).toString()).toBe('PK')
})

/** User request 2026-10-10: a pg_dump's tables into collections, then a collection out as SQL. */
// User request 2026-10-11: SQL import and export on the SQL ↔ MongoDB page, never a collection's.
test('imports a SQL dump into a database and exports collections as one SQL file, on the SQL page', async ({
  page,
}) => {
  await signIn(page)
  await expect(page.getByRole('button', { name: /^Account menu/ })).toBeVisible()
  const list = (await (await page.request.get('api/connections')).json()) as Array<{
    id: string
    name: string
  }>
  const id = list.find((c) => c.name === 'Local test')!.id
  await api(page, `connections/${id}/databases/sqle2e/collections/seed/documents`, {
    documents: [{ name: 'Seed' }],
  })
  // A collection's results offer no SQL any more.
  await page.goto(`c/${id}/db/sqle2e/coll/seed`)
  await expect(page.locator('tbody tr', { hasText: 'Seed' })).toBeVisible({ timeout: 15_000 })
  const documents = page.getByRole('tabpanel', { name: 'Documents' })
  await documents.getByRole('button', { name: 'More actions for these results' }).click()
  await expect(page.getByRole('menuitem', { name: 'Import SQL dump…' })).toHaveCount(0)
  await page.keyboard.press('Escape')

  // User request 2026-11-02: the page comes with the SQL → MongoDB plugin — absent until an
  // administrator approves it, there once it runs (turned off again at the end).
  await expect(page.locator('[data-sidebar-sql]')).toHaveCount(0)
  const managed = (await (await page.request.get('api/plugins/manage')).json()) as {
    plugins: Array<{ id: string; digest: string }>
  }
  const sqlPlugin = managed.plugins.find((p) => p.id === 'sql-to-mongodb')!
  await api(page, 'plugins/sql-to-mongodb/approve', { digest: sqlPlugin.digest })
  await page.reload()

  try {
    // The page, from the sidebar: where it works in sight and in its address.
    await page.locator('[data-sidebar-sql]').click()
    await page.locator('[data-sql-database] select').selectOption('sqle2e')
    await expect(page).toHaveURL(new RegExp(`/sql/import/${id}/sqle2e$`))
    await expect(page.locator('[data-sql-connection] select')).toHaveValue(id)
    const dialog = page.locator('[data-sql-import]')
    const dump = [
      "SET client_encoding = 'UTF8';",
      'CREATE TABLE public.orders (id integer NOT NULL, total numeric(10,2), paid boolean, note text);',
      'CREATE TABLE audit.orders (id integer NOT NULL, action text);',
      'COPY public.orders (id, total, paid, note) FROM stdin;',
      '10\t234.20\tt\tİlk sipariş',
      '11\t8.48\tf\t\\N',
      '\\.',
      "INSERT INTO audit.orders VALUES (1, 'created');",
      'ALTER TABLE ONLY public.orders ADD CONSTRAINT orders_pkey PRIMARY KEY (id);',
      'DROP TABLE seed;',
      '',
    ].join('\n')
    await dialog.locator('input[type="file"]').setInputFiles({
      name: 'shop.sql',
      mimeType: 'application/sql',
      buffer: Buffer.from(dump),
    })
    // Two tables of one name, told apart by their schema, each into its own collection.
    await expect(dialog.locator('input[aria-label="Collection for public.orders"]')).toHaveValue(
      'public_orders',
      {
        timeout: 15_000,
      },
    )
    await expect(dialog.locator('input[aria-label="Collection for audit.orders"]')).toHaveValue(
      'audit_orders',
    )
    await dialog.locator('input[aria-label="Collection for public.orders"]').fill('orders')
    // User request 2026-10-12: one step at a time; the job followed on a page of its own.
    await dialog.locator('[data-step-next]').click()
    await expect(dialog.locator('[aria-current="step"]')).toHaveAttribute('data-transfer-step', 'options')
    await dialog.getByRole('button', { name: 'Dry run' }).click()
    await expect(dialog.locator('[aria-current="step"]')).toHaveAttribute('data-transfer-step', 'run')
    await expect(dialog.locator('[data-sql-report]')).toContainText('Dry run: nothing was written.', {
      timeout: 20_000,
    })
    await dialog.getByRole('button', { name: 'Import into sqle2e', exact: true }).click()
    // Its progress and report in place, on the page.
    await expect(dialog.locator('[data-sql-import-job]')).toContainText('Import finished', {
      timeout: 20_000,
    })
    const read = async (coll: string) =>
      (
        (await api(page, `connections/${id}/databases/sqle2e/collections/${coll}/find`, {
          filter: {},
          sort: { _id: 1 },
        })) as { documents: Array<{ document: Record<string, unknown> }> }
      ).documents.map((d) => d.document)
    const orders = await read('orders')
    expect(orders).toHaveLength(2)
    expect(orders[0]).toMatchObject({
      _id: { $numberInt: '10' },
      total: { $numberDecimal: '234.20' },
      paid: true,
      note: 'İlk sipariş',
    })
    expect(await read('audit_orders')).toHaveLength(1)
    // The dump's DROP TABLE was read, never run.
    expect(await read('seed')).toHaveLength(1)

    // Export: two collections of the database as one MySQL file, on the same page.
    await page.getByRole('tab', { name: 'Export · MongoDB → SQL' }).click()
    await expect(page).toHaveURL(new RegExp(`/sql/export/${id}/sqle2e$`))
    const exporting = page.locator('[data-sql-export]')
    await exporting.locator('[data-export-all]').uncheck()
    await exporting.locator('[data-export-collection="orders"] input').check()
    await exporting.locator('[data-export-collection="audit_orders"] input').check()
    await exporting.locator('[data-step-next]').click()
    await exporting.getByRole('radio', { name: 'MySQL' }).click()
    await exporting.locator('[data-export-start]').click()
    await expect(exporting.locator('[data-sql-export-job]')).toContainText('Ready:', { timeout: 20_000 })
    const downloading = page.waitForEvent('download')
    await exporting.locator('[data-export-download]').click()
    const download = await downloading
    expect(download.suggestedFilename()).toMatch(/^sqle2e-\d{8}-\d{6}\.sql$/)
    const sql = readFileSync((await download.path())!, 'utf8')
    expect(sql).toContain('CREATE TABLE `orders` (')
    expect(sql).toContain('INSERT INTO `orders`')
    expect(sql).toContain('İlk sipariş')
    // User request 2026-10-12: amounts keep their own decimals, never 30 zeros each.
    expect(sql).toContain('`total` DECIMAL(65,2)')
    expect(sql).not.toContain('DECIMAL(65,30)')
    expect(sql).toContain('CREATE TABLE `audit_orders` (')
    expect(sql).not.toContain('CREATE TABLE `seed`')

    // The file loads into the database one chooses: it creates none of its own.
    expect(sql).not.toMatch(/CREATE DATABASE|^USE /m)

    // User request 2026-10-12: one database at a time — every database is never offered.
    const choices = await page
      .locator('[data-sql-database] select option')
      .evaluateAll((options) => options.map((o) => (o as unknown as { value: string }).value))
    expect(choices).toContain('sqle2e')
    expect(choices).not.toContain('*')
  } finally {
    await api(page, 'plugins/sql-to-mongodb/disable', {})
  }
})
