import type { Page } from '@playwright/test'
import { MongoClient } from 'mongodb'
import { expect, signIn, test } from '../fixtures'

/**
 * User report 2026-10-30: a collection holding a few documents showed a scrollbar at the bottom of
 * its page. A section whose content fits scrolls nowhere — not the window, not a box inside it.
 */
const DB = 'scrollfit'

test.beforeAll(async () => {
  const client = new MongoClient(process.env.MM_E2E_MONGO_URI!)
  try {
    const db = client.db(DB)
    await db.dropDatabase()
    await db.collection('few').insertMany([
      { name: 'a', total: 1 },
      { name: 'b', total: 2 },
      { name: 'c', total: 3 },
    ])
  } finally {
    await client.close()
  }
})

async function connectionId(page: Page): Promise<string> {
  const list = (await (await page.request.get('api/connections')).json()) as Array<{
    id: string
    name: string
  }>
  return list.find((c) => c.name === 'Local test')!.id
}

/** Every box that shows a scrollbar (auto or scroll) while its content would fit, with its overflow. */
// As text: this package is typed without the DOM.
const overflowing = (page: Page) =>
  page.evaluate<string[]>(`(() => {
    const found = []
    const doc = document.documentElement
    if (doc.scrollHeight > doc.clientHeight || doc.scrollWidth > doc.clientWidth)
      found.push('window ' + (doc.scrollWidth - doc.clientWidth) + 'x' + (doc.scrollHeight - doc.clientHeight))
    for (const el of document.querySelectorAll('body *')) {
      const s = getComputedStyle(el)
      const x = /(auto|scroll)/.test(s.overflowX) && el.scrollWidth > el.clientWidth
      const y = /(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight
      if (!x && !y) continue
      if (el.closest('[data-region="sidebar"], nav, [role="tablist"], [data-region="tabs"]')) continue
      const name = el.tagName.toLowerCase() + '.' + [...el.classList].slice(0, 6).join('.')
      found.push(
        name + (x ? ' x+' + (el.scrollWidth - el.clientWidth) : '') + (y ? ' y+' + (el.scrollHeight - el.clientHeight) : ''),
      )
    }
    return found
  })()`)

test('a small collection’s sections scroll nowhere', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await signIn(page)
  await expect(page.getByRole('button', { name: /^Account menu/ })).toBeVisible()
  const id = await connectionId(page)
  await page.goto(`c/${id}/db/${DB}/coll/few`)
  const sections = page.getByRole('tablist', { name: 'Collection sections' })
  await expect(sections).toBeVisible()
  await expect(page.getByRole('row', { name: /^Select document / })).toHaveCount(3)
  const names = await sections
    .getByRole('tab')
    .evaluateAll((els) => els.map((e) => e.textContent?.trim() ?? ''))
  const report: Record<string, string[]> = {}
  for (const name of names) {
    await sections.getByRole('tab', { name, exact: true }).click()
    await page.waitForTimeout(800)
    report[name] = await overflowing(page)
  }
  expect(report).toEqual(Object.fromEntries(names.map((n) => [n, []])))
})
