import { expect, rowNamed, test } from '../../fixtures'
import { tgz } from '../../../server/test/support/tar'

/**
 * Phase 4b §3, in a real browser: a plugin's own script runs in its sandboxed frame (its policy's
 * 'self' holds for an opaque origin), talks to the app only through the bridge, and reaches neither
 * the network, the app's cookies nor its page — opened in a tab of its own too.
 */
const SCRIPT = `
const out = document.getElementById('out')
const report = (k, v) => { out.dataset[k] = String(v) }
let token = null
window.addEventListener('message', (e) => {
  const m = e.data
  if (!m || m.mm !== 1) return
  if (m.type === 'hello') {
    // The host greets the page once it loaded: its requests carry the token from then on.
    token = m.token
    parent.postMessage({ mm: 1, id: 1, method: 'context.get', token }, '*')
    parent.postMessage({ mm: 1, id: 2, method: 'documents.find', params: { limit: 5 }, token }, '*')
    return
  }
  if (m.id === 1) report('coll', m.result.place && m.result.place.coll)
  if (m.id === 2) report('found', m.result.documents.length)
})
report('origin', self.origin)
report('hash', location.hash)
try { report('cookie', typeof document.cookie) } catch (e) { report('cookie', 'denied') }
try { report('parent', parent.document ? 'reached' : 'none') } catch (e) { report('parent', 'denied') }
try { localStorage.getItem('x'); report('storage', 'open') } catch (e) { report('storage', 'denied') }
fetch('/api/auth/me').then(() => report('fetch', 'open'), () => report('fetch', 'blocked'))
report('ran', 'yes')
`
const plugin = tgz([
  {
    name: 'mongo-manager-plugin.json',
    data: JSON.stringify({
      id: 'probe',
      name: { en: 'Probe' },
      version: '1.0.0',
      entry: 'index.html',
      permissions: ['documents:read'],
      contributes: { collectionTabs: [{ id: 'probe', title: { en: 'Probe' } }] },
    }),
  },
  {
    name: 'index.html',
    data: '<!doctype html><html><body><p id="out">probe</p><script src="app.js"></script></body></html>',
  },
  { name: 'app.js', data: SCRIPT },
  { name: 'other.html', data: '<!doctype html><p id="other">elsewhere</p>' },
])

test('a plugin runs sandboxed: its own script, the bridge, and nothing else', async ({
  page,
  context,
  cspViolations,
}) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Add connection' }).click()
  // User report 2026-10-16: the connection string is the form's first field and fills it by itself.
  await page.getByLabel('Connection string').fill(process.env.MM_E2E_MONGO_URI!)
  await page.getByLabel('Connection string').press('Enter')
  await expect(page.locator('[data-uri-status]')).toContainText('Read:')
  await page.getByLabel('Name', { exact: true }).fill('Plugins')
  await page.getByLabel('Name', { exact: true }).press('Enter')
  await expect(page.getByText('Connection saved.')).toBeVisible()
  await page.getByRole('button', { name: 'New database' }).click()
  await page.getByLabel('Database name').fill('probe')
  await page.getByLabel('First collection').fill('places')
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await page.getByRole('button', { name: 'places', exact: true }).click()
  await page.getByRole('button', { name: 'Add documents' }).first().click()
  await page.getByRole('textbox', { name: 'Document', exact: true }).fill("{ name: 'a' }")
  await page.getByRole('button', { name: 'Insert', exact: true }).click()
  // By its name cell: any row's ObjectId holds an "a" (independent review, nit).
  await expect(rowNamed(page, 'a')).toBeVisible()
  const collection = page.url()

  // An administrator uploads and approves it.
  await page.goto('/plugins')
  await page
    .locator('input[data-plugin-upload]')
    .setInputFiles({ name: 'probe.tgz', mimeType: 'application/gzip', buffer: plugin })
  await expect(page.locator('[data-plugin="probe"] [data-plugin-status]')).toHaveText('Waiting for approval')
  // Its scan found it reaching for the page around its frame (user request 2026-10-11): approving it
  // takes its id typed, never a bare yes.
  await expect(page.locator('[data-plugin="probe"] [data-plugin-scan]')).toHaveText(/high risk/)
  await page.locator('[data-plugin="probe"]').getByRole('button', { name: 'Approve and enable' }).click()
  await expect(page.getByRole('dialog')).toContainText('Reaches for the page around its frame')
  await expect(page.locator('[data-test="confirm"]')).toBeDisabled()
  await page.locator('[data-test="require-text"] input').fill('probe')
  await page.locator('[data-test="confirm"]').click()
  await expect(page.locator('[data-plugin="probe"] [data-plugin-status]')).toHaveText('Enabled')

  // Its tab on the collection.
  await page.goto(collection)
  await page.getByRole('tablist', { name: 'Collection sections' }).getByRole('tab', { name: 'Probe' }).click()
  const out = page.frameLocator('[data-plugin-frame] iframe').locator('#out')
  await expect(out).toHaveAttribute('data-ran', 'yes')
  await expect(out).toHaveAttribute('data-origin', 'null')
  await expect(out).toHaveAttribute('data-hash', '#collectionTab=probe')
  await expect(out).toHaveAttribute('data-coll', 'places')
  await expect(out).toHaveAttribute('data-found', '1')
  await expect(out).toHaveAttribute('data-cookie', 'denied')
  await expect(out).toHaveAttribute('data-parent', 'denied')
  await expect(out).toHaveAttribute('data-storage', 'denied')
  await expect(out).toHaveAttribute('data-fetch', 'blocked')

  // Opened in a tab of its own, its page is still sandboxed: never the app's origin.
  const src = await page.locator('[data-plugin-frame] iframe').getAttribute('src')
  const own = await context.newPage()
  await own.goto(src!)
  const alone = own.locator('#out')
  await expect(alone).toHaveAttribute('data-ran', 'yes')
  await expect(alone).toHaveAttribute('data-origin', 'null')
  await expect(alone).toHaveAttribute('data-cookie', 'denied')
  await expect(alone).toHaveAttribute('data-fetch', 'blocked')

  // A page the frame goes to (a link, a plugin handing itself over) is never answered: the app
  // closes the frame and says so.
  await page.bringToFront()
  const pluginFrame = page.frames().find((f) => f.url().includes('/plugin-frame/'))!
  await pluginFrame.evaluate(() => {
    ;(globalThis as unknown as { location: { href: string } }).location.href = 'other.html'
  })
  await expect(page.locator('[data-plugin-stopped]')).toBeVisible()
  await expect(page.locator('[data-plugin-frame] iframe')).toHaveCount(0)
  // The browser reports what it refused the plugin: its own network attempts, nothing else.
  expect(cspViolations.length).toBeGreaterThan(0)
  for (const v of cspViolations)
    expect(v, JSON.stringify(cspViolations)).toMatch(/Refused to connect|connect-src 'none'/)
  cspViolations.splice(0)
})
