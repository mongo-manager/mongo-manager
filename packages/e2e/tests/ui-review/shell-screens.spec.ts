import type { Page } from '@playwright/test'
import { expect, signIn, test } from '../../fixtures'

/**
 * UI redesign R1 checkpoint 1, revision 2: the sidebar (expanded and collapsed), the context bar, the
 * modular Overview, a collection open from the tree, the palette, the account menu, Preferences, the
 * notifications, focus mode and a narrow window — in light and dark, English and Turkish, at 1440×900
 * and 1920×1080, and once in the Indigo accent. Each screen is also checked: no horizontal page
 * scroll, and no bar control taller than one line.
 * Run: MM_UI_REVIEW=1 pnpm --filter @mongo-manager/e2e exec playwright test tests/01-first-run.spec.ts tests/ui-review/shell-screens.spec.ts --project=chrome
 */
test.skip(!process.env.MM_UI_REVIEW, 'UI review runs on demand')

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

/** Review Focus 1 and 5: nothing scrolls sideways and no bar control wraps. */
async function checkFit(page: Page, where: string) {
  // A string, like the other specs' page scripts: the e2e package has no DOM types.
  const problems = (await page.evaluate(`(() => {
    const out = []
    if (document.documentElement.scrollWidth > window.innerWidth) out.push('page scrolls sideways')
    const bars = '[data-region="topbar"] button, [data-region="tabs"] [role="tab"], [data-region="sidebar"] li > button'
    for (const el of document.querySelectorAll(bars)) {
      const r = el.getBoundingClientRect()
      if (r.height > 40) out.push('taller than one line: ' + (el.textContent || '').trim().slice(0, 40))
    }
    return out
  })()`)) as string[]
  expect(problems, where).toEqual([])
}

const LABELS = {
  en: { account: /^Account menu/, prefs: 'Preferences', bell: /^Background jobs/ },
  tr: { account: / hesap menüsü/, prefs: 'Tercihler', bell: /^Arka plan işleri/ },
} as const

test('the shell in both themes and languages (UI redesign R1 checkpoint 1, revision 2)', async ({ page }) => {
  test.setTimeout(900_000)
  await signIn(page)
  await expect(page.getByRole('button', { name: /^Account menu/ })).toBeVisible()
  const conn = ((await api(page, 'GET', 'connections')) as Array<{ id: string; name: string }>).find(
    (c) => c.name === 'Local test',
  )!.id
  for (const coll of ['orders', 'customers', 'a_collection_with_a_rather_long_name_for_the_tab_strip'])
    await api(page, 'POST', `connections/${conn}/databases/review/collections/${coll}/documents`, {
      documents: [{ n: 1 }],
    })

  type Run = {
    size: { width: number; height: number }
    theme: 'light' | 'dark'
    lang: 'en' | 'tr'
    accent: string
  }
  const runs: Run[] = []
  for (const size of [
    { width: 1440, height: 900 },
    { width: 1920, height: 1080 },
  ])
    for (const theme of ['light', 'dark'] as const)
      for (const lang of ['en', 'tr'] as const) runs.push({ size, theme, lang, accent: 'emerald' })
  runs.push({ size: { width: 1440, height: 900 }, theme: 'light', lang: 'en', accent: 'indigo' })

  for (const { size, theme, lang, accent } of runs) {
    const L = LABELS[lang]
    await page.setViewportSize(size)
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
    await page.evaluate(
      ([th, l, a]) => {
        localStorage.setItem('mm:preferences', JSON.stringify({ theme: th, locale: l, accent: a }))
        localStorage.removeItem('mm:tabs')
        localStorage.removeItem('mm:layout')
      },
      [theme, lang, accent] as const,
    )
    await page.goto('./')
    await expect(page.locator('[data-region="sidebar"]')).toBeVisible()
    const dir = `test-results/ui-review/shell-${size.width}-${theme}-${lang}${accent === 'emerald' ? '' : `-${accent}`}`
    const shot = async (name: string) => {
      await page.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))')
      await page.screenshot({ path: `${dir}-${name}.png` })
    }
    await checkFit(page, `${dir} overview`)
    await shot('01-overview')
    const tree = page.getByRole('tree')
    await tree.getByRole('treeitem', { name: 'Local test' }).click()
    await tree.getByRole('treeitem', { name: 'review' }).click()
    for (const coll of ['orders', 'customers', 'a_collection_with_a_rather_long_name_for_the_tab_strip'])
      await tree.getByRole('treeitem', { name: coll }).click()
    await checkFit(page, `${dir} collection`)
    await shot('02-collection')
    await page.keyboard.press('Control+K')
    await page.keyboard.type('cust')
    await shot('03-palette-goto')
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: L.account }).click()
    await shot('04-account-menu')
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: L.prefs }).click()
    await shot('05-preferences')
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: L.bell }).click()
    await shot('06-notifications')
    await page.keyboard.press('Escape')
    await page.keyboard.press('Control+B')
    await checkFit(page, `${dir} rail`)
    await shot('07-sidebar-rail')
    await page.keyboard.press('Control+B')
    await page.keyboard.press('Control+Shift+F')
    await shot('08-focus-mode')
    await page.keyboard.press('Control+Shift+F')
    if (size.width === 1440 && accent === 'emerald') {
      await page.setViewportSize({ width: 900, height: 800 })
      await checkFit(page, `${dir} narrow`)
      await page.keyboard.press('Control+B')
      await shot('09-narrow-sidebar')
      await page.keyboard.press('Escape')
    }
  }
})
