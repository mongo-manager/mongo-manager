import { readFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { expect, signIn, test } from '../../fixtures'

/**
 * Phase 4a-2: the assistant's chat panel — empty with suggestions, an answer with its block's action,
 * a query put in the query bar, a second collection with its divider, the History menu, a general chat,
 * a refused provider, a narrow window, and Gemini in the provider editor — in light and dark, English
 * and Turkish, as PNGs for review.
 * Run: MM_UI_REVIEW=1 pnpm --filter @mongo-manager/e2e exec playwright test tests/01-first-run.spec.ts tests/ui-review/ai-chat-screens.spec.ts --project=chrome
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
  return res.status() === 204
    ? null
    : res.headers()['content-type']?.includes('application/json')
      ? res.json()
      : res.text()
}
async function clearAll(page: Page) {
  for (const p of (await api(page, 'GET', 'ai/providers')) as Array<{ id: string }>)
    await api(page, 'DELETE', `ai/providers/${p.id}`)
  await api(page, 'DELETE', 'ai/chats')
}

test('AI chat screens in both themes and languages (phase 4a-2)', async ({ page }) => {
  test.setTimeout(900_000)
  await signIn(page)
  await expect(page.getByRole('button', { name: /^Account menu/ })).toBeVisible()
  const list = (await api(page, 'GET', 'connections')) as Array<{ id: string; name: string }>
  const conn = list.find((c) => c.name === 'Local test')!.id
  for (const coll of ['orders', 'customers'])
    await api(page, 'POST', `connections/${conn}/databases/review/collections/${coll}/documents`, {
      documents: Array.from({ length: 40 }, (_, i) => ({
        qty: i,
        status: i % 3 ? 'paid' : 'new',
        email: `buyer${i}@example.com`,
      })),
    })
  const size = page.viewportSize()!

  for (const theme of ['light', 'dark'] as const)
    for (const lang of ['en', 'tr'] as const) {
      await page.setViewportSize(size)
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
      await page.evaluate(
        ([th, l]) => localStorage.setItem('mm:preferences', JSON.stringify({ theme: th, locale: l })),
        [theme, lang] as const,
      )
      const dir = `test-results/ui-review/ai-chat-${theme}-${lang}`
      const shot = async (name: string) => {
        await page.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))')
        await page.screenshot({ path: `${dir}-${name}.png` })
      }
      const t = (key: string) => value(lang, key)
      await clearAll(page)
      await api(page, 'POST', 'ai/providers', {
        name: 'Fake',
        kind: 'openai',
        baseUrl: `${process.env.MM_E2E_AI_URL}/v1`,
        model: 'fake-model',
        samples: true,
      })
      // Two collection tabs, so switching keeps the page (and the chat in memory).
      await page.goto(`c/${conn}/db/review/coll/customers`)
      await expect(page.getByRole('tab', { name: 'review.customers' })).toBeVisible()
      await page.goto(`c/${conn}/db/review/coll/orders`)
      await expect(page.getByRole('tab', { name: 'review.orders' })).toBeVisible()
      const panel = page.getByRole('complementary', { name: t('ai.chat.title') })
      // The panel's state comes back as the page loads: its toggle says whether it is open.
      const toggle = page.locator('#assistant-toggle')
      await expect(toggle).toBeVisible()
      if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
      await expect(panel).toBeVisible()
      const box = panel.getByLabel(t('ai.chat.composer.label'))
      const answered = () =>
        expect(panel.getByRole('button', { name: t('ai.chat.composer.send'), exact: true })).toBeVisible({
          timeout: 30_000,
        })

      // 1. Empty, with suggestions for the Documents section.
      await panel.getByRole('button', { name: t('ai.chat.newChat') }).click()
      await expect(panel.getByText(t('ai.chat.empty.hint'))).toBeVisible()
      await shot('01-empty')

      // 2. An answer with its query block and the block's action.
      await box.fill('orders over five, biggest first')
      await box.press('Enter')
      await expect(panel.getByRole('button', { name: t('ai.chat.block.run'), exact: true })).toBeVisible({
        timeout: 30_000,
      })
      await answered()
      await shot('02-answer')

      // 3. The query run in its collection (one action under a block: user report 2026-10-13).
      await panel.getByRole('button', { name: t('ai.chat.block.run'), exact: true }).click()
      await expect(page.getByRole('button', { name: t('query.find'), exact: true })).toBeVisible()
      await shot('03-ran')

      // 4. Another collection: the divider, and the Validator chip on.
      await page.getByRole('tab', { name: 'review.customers' }).click()
      await panel.getByRole('button', { name: t('ai.chat.context.validator') }).click()
      await box.fill('and here?')
      await box.press('Enter')
      await expect(
        panel.getByText(t('ai.chat.divider.about').replace('{ns}', 'review.customers')),
      ).toBeVisible()
      await answered()
      await shot('04-divider')

      // 5. History with three chats and the retention.
      await api(page, 'POST', 'ai/chat', { message: 'How do I choose a shard key?' })
      await api(page, 'POST', 'ai/chat', { message: 'Explain read and write concerns' })
      await panel.getByRole('button', { name: t('ai.chat.history.button') }).click()
      await expect(page.getByText('How do I choose a shard key?')).toBeVisible()
      await shot('05-history')
      await page.keyboard.press('Escape')

      // 6. A general chat (no collection tab active).
      await page.goto('ai-assistant')
      await expect(panel.getByText(t('ai.chat.context.general'))).toBeVisible()
      await box.fill(t('ai.chat.suggest.general1'))
      await box.press('Enter')
      await expect(panel.getByText('I can see 0 earlier messages.')).toBeVisible({ timeout: 30_000 })
      await answered()
      await shot('06-general')

      // 7. A provider whose address is refused: the alert, nothing sent, Try again.
      await api(page, 'POST', 'ai/providers', {
        name: 'Refused',
        kind: 'anthropic',
        baseUrl: 'https://10.255.255.1',
        apiKey: 'sk-ant-review-only',
      })
      await page.reload()
      const refused = (await api(page, 'GET', 'ai/status')) as {
        providers: Array<{ id: string; name: string }>
      }
      await panel
        .getByLabel(t('ai.chat.composer.provider'))
        .selectOption(refused.providers.find((p) => p.name === 'Refused')!.id)
      await box.fill('anything')
      await box.press('Enter')
      await expect(panel.getByRole('alert')).toBeVisible({ timeout: 30_000 })
      await shot('07-refused')

      // 8. A narrow window, and a phone's: the assistant over the page (user report 2026-10-25), on a
      // phone the whole screen.
      await page.setViewportSize({ width: 900, height: 800 })
      await shot('08-narrow')
      await page.setViewportSize({ width: 390, height: 800 })
      await shot('08-phone')
      await page.setViewportSize(size)
      // Closed with its floating button, which says what goes on inside.
      await toggle.click()
      await expect(panel).toBeHidden()
      await shot('08-closed')

      // 9. Gemini in the provider editor, with a model name refused.
      await page.getByRole('button', { name: value(lang, 'ai.settings.add') }).click()
      const editor = page.getByRole('dialog')
      await editor.getByLabel(t('ai.settings.name'), { exact: true }).fill('Gemini')
      await editor.getByLabel(t('ai.settings.kind'), { exact: true }).selectOption('gemini')
      await editor.getByLabel(t('ai.settings.model'), { exact: true }).fill('../files')
      await expect(editor.getByText(t('ai.settings.refusal.model_invalid')).first()).toBeVisible()
      await shot('09-gemini')
      await page.keyboard.press('Escape')
    }
  await clearAll(page)
})
