// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { expect, pickRulePart, test } from '../../fixtures'

/**
 * User request 2026-10-13: "kişisel veri adına bir bilgiyi gizleme tespit edilemedi, yerel mod bile
 * olsa bu özellik aktif olmalı". In local mode a personal-data rule hides its values from the local
 * user too. User request 2026-10-24: one person, so no switch; removing the rule shows them again.
 */
test('a personal-data rule hides its values in local mode, until removed', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Add connection' }).click()
  // User report 2026-10-16: the connection string is the form's first field and fills it by itself.
  await page.getByLabel('Connection string').fill(process.env.MM_E2E_MONGO_URI!)
  await page.getByLabel('Connection string').press('Enter')
  await expect(page.locator('[data-uri-status]')).toContainText('Read:')
  await page.getByLabel('Name', { exact: true }).fill('Masking')
  await page.getByLabel('Name', { exact: true }).press('Enter')
  await expect(page.getByText('Connection saved.')).toBeVisible()
  const connection = page.url()
  await page.getByRole('button', { name: 'New database' }).click()
  await page.getByLabel('Database name').fill('masked')
  await page.getByLabel('First collection').fill('people')
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await page.getByRole('button', { name: 'people', exact: true }).click()
  await page.getByRole('button', { name: 'Add documents' }).first().click()
  await page
    .getByRole('textbox', { name: 'Document', exact: true })
    .fill("{ name: 'Ada', email: 'ada@secret.example', address: { city: 'Izmir' } }")
  await page.getByRole('button', { name: 'Insert', exact: true }).click()
  await expect(page.locator('td[data-field="email"]')).toContainText('ada@secret.example')
  const people = page.url()

  // A rule in the connection's Personal data tab: email, and the address with all that is inside it.
  await page.goto(connection)
  await page
    .getByRole('tablist', { name: 'Connection sections' })
    .getByRole('tab', { name: 'Personal data', exact: true })
    .click()
  const card = page.locator('[data-personal-data]')
  // Picked from what the server holds — the database, its collection, the fields of its documents.
  await pickRulePart(page, card, 'data-rule-db', 'masked')
  await pickRulePart(page, card, 'data-rule-coll', 'people')
  for (const field of ['email', 'address']) {
    await pickRulePart(page, card, 'data-rule-field', field)
    await expect(card.locator('[data-rule-row]', { hasText: new RegExp(`^${field}$`) })).toBeVisible()
    await expect(card.locator('[data-rules-status]')).toHaveText('Saved.')
  }
  // One person in local mode: nothing to hide from anyone else, no switch.
  await expect(card.locator('[data-hide-from-me]')).toHaveCount(0)

  await page.goto(people)
  await expect(page.locator('td[data-field="email"] [data-masked]')).toBeVisible()
  await expect(page.locator('tbody')).not.toContainText('ada@secret.example')
  await expect(page.locator('[data-region="topbar"]')).toContainText('Personal data hidden')
  // User report 2026-10-27: the rules reach the masked database only — not another one.
  await page.goto(people.replace(/\/db\/masked\/coll\/people.*$/, '/db/admin'))
  await expect(page.getByRole('tablist', { name: /sections/i }).first()).toBeVisible()
  await expect(page.locator('[data-region="topbar"]')).not.toContainText('Personal data hidden')
  await page.goto(people.replace(/\/coll\/people.*$/, ''))
  await expect(page.locator('[data-region="topbar"]')).toContainText('Personal data hidden')

  // Shown again once the rules are removed, each saved at once.
  await page.goto(connection)
  await page
    .getByRole('tablist', { name: 'Connection sections' })
    .getByRole('tab', { name: 'Personal data', exact: true })
    .click()
  for (const rule of ['masked.people.email', 'masked.people.address']) {
    await card.getByRole('button', { name: `Remove ${rule}` }).click()
    await expect(card.getByRole('button', { name: `Remove ${rule}` })).toHaveCount(0)
  }
  await expect(card.locator('[data-rules-status]')).toHaveText('Saved.')
  await page.goto(people)
  await expect(page.locator('td[data-field="email"]')).toContainText('ada@secret.example')
  await expect(page.locator('[data-region="topbar"]')).not.toContainText('Personal data hidden')
})
