// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { expect, localHeaders, localLaunchPath, test, watchCsp, watchOrigins } from '../../fixtures'

/**
 * Security audit 2026-10-16 (important 2), in a real browser: local mode opens only from a one-time
 * launch link. A browser without it sees how to get one and never the data; the link leaves no token
 * in the address bar, and works once.
 */
test('local mode opens from its launch link only, once', async ({
  browser,
  baseURL,
  cspViolations,
  foreignRequests,
}) => {
  const origin = new URL(baseURL!).origin
  const fresh = async () => {
    const context = await browser.newContext({ locale: 'en-US', baseURL: baseURL! })
    const page = await context.newPage()
    watchCsp(page, cspViolations)
    watchOrigins(page, origin, foreignRequests)
    return { context, page }
  }

  const stranger = await fresh()
  try {
    await stranger.page.goto('/')
    await expect(
      stranger.page.getByRole('heading', { name: "This browser isn't allowed in yet" }),
    ).toBeVisible()
    await expect(stranger.page.getByText('Local mode', { exact: true })).toHaveCount(0)
    expect((await stranger.page.request.get('api/auth/me')).status()).toBe(401)
  } finally {
    await stranger.context.close()
  }

  const link = localLaunchPath()
  const owner = await fresh()
  try {
    await owner.page.goto(link)
    await expect(owner.page.getByText('Local mode', { exact: true })).toBeVisible()
    // No token left in the address bar.
    expect(new URL(owner.page.url()).pathname).toBe('/')
    expect(new URL(owner.page.url()).search).toBe('')
    // The page claimed its key; with it, the API answers.
    const headers = await localHeaders(owner.page)
    expect((await owner.page.request.get('api/auth/me', { headers })).status()).toBe(200)
    // Review of the audit fixes (important 1): what another port of this host gets — the cookie —
    // reads nothing without the key, which no other origin can read.
    expect((await owner.page.request.get('api/auth/me')).status()).toBe(401)
  } finally {
    await owner.context.close()
  }

  const late = await fresh()
  try {
    await late.page.goto(link)
    await expect(late.page.getByText('That link has expired or was already used.')).toBeVisible()
    expect((await late.page.request.get('api/auth/me')).status()).toBe(401)
  } finally {
    await late.context.close()
  }
})
