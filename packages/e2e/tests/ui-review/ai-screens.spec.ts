// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { readFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { expect, signIn, test } from '../../fixtures'

/**
 * Phase 4a-1: every AI assistant screen — Settings empty, the provider editor, the providers after a
 * test, the Ask AI sheet with samples, a query answer with its diff, what was sent, a description, an
 * optimisation with index suggestions, and a refused provider — in light and dark, English and
 * Turkish, as PNGs for review.
 * Run: MM_UI_REVIEW=1 pnpm --filter @mongo-manager/e2e exec playwright test tests/01-first-run.spec.ts tests/ui-review/ai-screens.spec.ts --project=chrome
 */
test.skip(
  !process.env.MM_UI_REVIEW || !process.env.MM_E2E_AI_URL,
  'UI review runs on demand, with the fake provider',
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
async function clearProviders(page: Page) {
  for (const p of (await api(page, 'GET', 'ai/providers')) as Array<{ id: string }>)
    await api(page, 'DELETE', `ai/providers/${p.id}`)
}

test('AI assistant screens in both themes and languages (phase 4a-1)', async ({ page }) => {
  test.setTimeout(900_000)
  await signIn(page)
  await expect(page.getByRole('button', { name: /^Account menu/ })).toBeVisible()
  const list = (await api(page, 'GET', 'connections')) as Array<{ id: string; name: string }>
  const conn = list.find((c) => c.name === 'Local test')!.id
  await api(page, 'POST', `connections/${conn}/databases/review/collections/orders/documents`, {
    documents: Array.from({ length: 40 }, (_, i) => ({
      qty: i,
      status: i % 3 ? 'paid' : 'new',
      email: `buyer${i}@example.com`,
      at: { $date: new Date(Date.UTC(2026, 9, 1 + (i % 5))).toISOString() },
    })),
  })

  for (const theme of ['light', 'dark'] as const)
    for (const lang of ['en', 'tr'] as const) {
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
      await page.evaluate(
        ([th, l]) => localStorage.setItem('mm:preferences', JSON.stringify({ theme: th, locale: l })),
        [theme, lang] as const,
      )
      const dir = `test-results/ui-review/ai-${theme}-${lang}`
      const shot = async (name: string) => {
        await page.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))')
        await page.screenshot({ path: `${dir}-${name}.png` })
      }
      const t = (key: string) => value(lang, key)
      await clearProviders(page)

      // 1. Settings, no provider yet.
      await page.goto('ai-assistant')
      await expect(page.getByText(t('ai.settings.emptyTitle'))).toBeVisible()
      await shot('01-settings-empty')

      // 2. The editor, filled in.
      await page.getByRole('button', { name: t('ai.settings.add') }).click()
      const editor = page.getByRole('dialog')
      await editor.getByLabel(t('ai.settings.name'), { exact: true }).fill('Fake (OpenAI-compatible)')
      await editor.getByLabel(t('ai.settings.kind'), { exact: true }).selectOption('openai')
      await editor
        .getByLabel(t('ai.settings.address'), { exact: true })
        .fill(`${process.env.MM_E2E_AI_URL}/v1`)
      await editor.getByLabel(t('ai.settings.model'), { exact: true }).fill('fake-model')
      await editor.getByLabel(t('ai.settings.samplesLabel')).check()
      await shot('02-editor')
      await editor.getByRole('button', { name: t('common.save') }).click()
      await expect(editor).toBeHidden()

      // 3. Two providers after a test (one disabled, never tested).
      await api(page, 'POST', 'ai/providers', {
        name: 'Claude',
        kind: 'anthropic',
        apiKey: 'sk-ant-review-only',
        enabled: false,
      })
      await page.reload()
      await page
        .getByRole('button', { name: t('ai.settings.test'), exact: true })
        .first()
        .click()
      await expect(page.getByText(t('ai.settings.testOk').split(' (')[0]!).first()).toBeVisible()
      await shot('03-settings')

      // 4. The sheet on Documents, with samples and fields to hide.
      await page.goto(`c/${conn}/db/review/coll/orders`)
      await page.getByRole('button', { name: t('ai.ask') }).click()
      const sheet = page.getByRole('dialog')
      await sheet
        .getByLabel(t('ai.sheet.prompt'))
        .fill(lang === 'tr' ? '5ten büyük siparişler' : 'orders over five')
      await sheet.getByLabel(t('ai.sheet.samples')).check()
      await sheet.getByLabel(t('ai.sheet.hide')).fill('email')
      await shot('04-sheet')

      // 5. The answer and its diff.
      await sheet.getByRole('button', { name: t('ai.sheet.send') }).click()
      await expect(sheet.getByRole('button', { name: t('ai.sheet.stop') })).toBeHidden({ timeout: 30_000 })
      await expect(sheet.getByText(t('ai.sheet.suggested'))).toBeVisible()
      await shot('05-answer')

      // 6. What was sent.
      await sheet.getByText(t('ai.sheet.sent')).click()
      await shot('06-sent')
      await page.keyboard.press('Escape')
      await expect(sheet).toBeHidden()

      // 7. Schema: describe the collection.
      await page.getByRole('tab', { name: value(lang, 'documents.sections.schema') }).click()
      await page.keyboard.press('Control+i')
      await sheet.getByRole('button', { name: t('ai.sheet.send') }).click()
      await expect(sheet.getByRole('button', { name: t('ai.sheet.stop') })).toBeHidden({ timeout: 30_000 })
      await expect(sheet.locator('[data-ai-answer]')).toContainText('Orders')
      await shot('07-describe')
      await page.keyboard.press('Escape')

      // 8. Explain: make it faster, with an index suggestion.
      // A query to speed up (nothing is sent without one).
      await page.getByRole('tab', { name: value(lang, 'documents.sections.documents') }).click()
      await page.getByRole('textbox', { name: value(lang, 'query.filter') }).fill('{ qty: { $gt: 5 } }')
      await page.getByRole('tab', { name: value(lang, 'documents.sections.explain') }).click()
      await page.keyboard.press('Control+i')
      await sheet.getByRole('button', { name: t('ai.sheet.send') }).click()
      await expect(sheet.getByRole('button', { name: t('ai.sheet.stop') })).toBeHidden({ timeout: 30_000 })
      await expect(sheet.getByRole('button', { name: t('ai.sheet.createIndex') })).toBeVisible()
      await shot('08-optimise')
      await page.keyboard.press('Escape')

      // 9. A provider whose address is refused: the error in words.
      await api(page, 'POST', 'ai/providers', {
        name: 'Refused',
        kind: 'anthropic',
        baseUrl: 'https://127.0.0.2',
        apiKey: 'sk-ant-review-only',
      })
      await page.reload()
      await page.getByRole('tab', { name: value(lang, 'documents.sections.documents') }).click()
      await page.getByRole('button', { name: t('ai.ask') }).click()
      const refused = (await api(page, 'GET', 'ai/status')) as {
        providers: Array<{ id: string; name: string }>
      }
      await sheet
        .getByLabel(t('ai.sheet.provider'))
        .selectOption(refused.providers.find((p) => p.name === 'Refused')!.id)
      await sheet.getByLabel(t('ai.sheet.prompt')).fill('x')
      await sheet.getByRole('button', { name: t('ai.sheet.send') }).click()
      await expect(sheet.getByRole('button', { name: t('ai.sheet.stop') })).toBeHidden({ timeout: 30_000 })
      await expect(sheet.getByRole('alert')).toContainText(t('ai.reason.address_refused'))
      await shot('09-error')
      await page.keyboard.press('Escape')
    }
  await clearProviders(page)
})
