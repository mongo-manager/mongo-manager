import type { Page } from '@playwright/test'
import { expect, openDatabaseBackups, showDatabaseBackups, signIn, test } from '../../fixtures'

/**
 * Phase 3d-3a U15: every state of the backup UI, in light and dark, English and Turkish, as PNGs
 * for review against U1–U14. Run: MM_UI_REVIEW=1 pnpm --filter @mongo-manager/e2e ui-review
 * (after a build; the script runs the first-run spec first, which creates the administrator and
 * the "Local test" connection on the fresh test server).
 */
test.skip(!process.env.MM_UI_REVIEW, 'UI review runs on demand')

async function api(page: Page, path: string, data: object) {
  const me = await (await page.request.get('api/auth/me')).json()
  const res = await page.request.post(`api/${path}`, {
    data,
    headers: { 'x-csrf-token': me.csrfToken, origin: new URL(page.url()).origin },
  })
  expect(res.ok(), await res.text()).toBe(true)
  return res.json()
}

for (const theme of ['light', 'dark'] as const)
  for (const lang of ['en', 'tr'] as const)
    test(`backup screens — ${theme}, ${lang}`, async ({ page }) => {
      test.setTimeout(180_000)
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
      await page.setViewportSize({ width: 1440, height: 900 })
      await signIn(page)
      await expect(page.getByRole('button', { name: /^Account menu/ })).toBeVisible()
      await page.evaluate(
        ([th, l]) => localStorage.setItem('mm:preferences', JSON.stringify({ theme: th, locale: l })),
        [theme, lang] as const,
      )
      const list = (await (await page.request.get('api/connections')).json()) as Array<{
        id: string
        name: string
      }>
      const id = list.find((c) => c.name === 'Local test')!.id
      const db = `ui_${theme}_${lang}`
      await api(page, `connections/${id}/databases/${db}/collections/orders/documents`, {
        documents: Array.from({ length: 50 }, (_, i) => ({ i, email: `u${i}@x`, total: i * 3 })),
      })
      await api(page, `connections/${id}/databases/${db}/collections/customers/documents`, {
        documents: Array.from({ length: 20 }, (_, i) => ({ i, name: `c${i}` })),
      })
      const dir = `test-results/ui-review/${theme}-${lang}`
      const shot = (name: string) => page.screenshot({ path: `${dir}-${name}.png` })
      const card = await openDatabaseBackups(page, id, db)
      await card.scrollIntoViewIfNeeded()
      await expect(card).toBeVisible()
      await page.waitForTimeout(600)
      await shot('01-backups-empty')

      await card.getByRole('button').last().click()
      const sheet = page.getByRole('dialog')
      await expect(sheet).toBeVisible()
      await page.waitForTimeout(1200)
      await shot('02-dump-quick')
      await sheet.getByRole('radio').first().check()
      await page.waitForTimeout(600)
      await shot('03-dump-encrypted')
      await sheet.getByRole('button', { name: /Generate|Güçlü/ }).click()
      await page.keyboard.press('Tab')
      await page.waitForTimeout(600)
      await shot('03b-dump-password-generated')
      await sheet.getByRole('button', { name: /Customize|Özelleştir/ }).click()
      for (let i = 0; i < 5; i++) {
        await page.waitForTimeout(500)
        await shot(`04-dump-step-${i + 1}`)
        const next = sheet.getByRole('button', { name: /^(Next|İleri)$/ })
        if (!(await next.isVisible())) break
        await next.click()
      }
      await page.keyboard.press('Escape')
      await page.waitForTimeout(300)
      await shot('05-dump-dirty-close')
      await sheet.getByRole('button', { name: /^(Discard|Evet, vazgeç)$/ }).click()

      // A finished backup in the list, then the restore sheet.
      const plan = await api(page, `connections/${id}/backup/plan`, {
        scope: { kind: 'database', db },
        format: 'gzip',
      })
      await api(page, `connections/${id}/backup`, {
        scope: { kind: 'database', db },
        format: 'gzip',
        planHash: plan.planHash,
      })
      await page.waitForTimeout(3000)
      await page.reload()
      await showDatabaseBackups(page, id, db)
      await card.scrollIntoViewIfNeeded()
      await page.waitForTimeout(600)
      await shot('06-backups-list')
      await page.getByRole('button', { name: /^(Background jobs|Arka plan)/ }).click()
      await page.waitForTimeout(500)
      await shot('06b-jobs-panel')
      await page.keyboard.press('Escape')
      await card
        .getByRole('button', { name: /^(?:Actions for .+|.+ için işlemler)$/ })
        .first()
        .click()
      await page.getByRole('menuitem', { name: /Restore|Geri yükle/ }).click()
      await page.waitForTimeout(1500)
      for (let i = 0; i < 5; i++) {
        await shot(`07-restore-step-${i + 1}`)
        const next = page.getByRole('dialog').getByRole('button', { name: /^(Next|İleri)$/ })
        if (!(await next.isVisible()) || (await next.isDisabled())) break
        await next.click()
        await page.waitForTimeout(700)
      }
      await page.setViewportSize({ width: 1024, height: 768 })
      await page.waitForTimeout(400)
      await shot('08-restore-narrow')
    })
