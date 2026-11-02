import { expect, test } from '../fixtures'

// Every test fails if the page reaches any origin but the app's (spec §3.6, Review Focus 4).
// This one proves the guard sees such a request; the request is answered locally, never sent.
test('the offline guard records a request to another origin', async ({ page, foreignRequests }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: /Welcome to Mongo Manager|Sign in/ })).toBeVisible()
  expect(foreignRequests).toEqual([])

  await page.route('http://example.test/**', (route) => route.fulfill({ body: 'stub' }))
  await page.goto('http://example.test/tracker')
  expect(foreignRequests).toEqual(['GET http://example.test/tracker'])
  foreignRequests.length = 0
})

test('the guard also sees popups the page opens (final review Minor 5)', async ({
  page,
  context,
  foreignRequests,
}) => {
  await context.route('http://example.test/**', (route) => route.fulfill({ body: 'stub' }))
  await page.goto('/')
  const popup = page.waitForEvent('popup')
  await page.evaluate("window.open('http://example.test/popup')")
  await (await popup).waitForLoadState()
  expect(foreignRequests).toContain('GET http://example.test/popup')
  foreignRequests.length = 0
})
