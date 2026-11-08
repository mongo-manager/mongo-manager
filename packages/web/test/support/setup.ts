// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, vi } from 'vitest'
import type { IFetchInterceptor, Request as HappyRequest } from 'happy-dom'
import { setJobsSocketFactory } from '../../src/jobs/live'
import { confirmGuard } from '../../src/ds/confirmGuard'

// The test origin (localhost:4321) is where a developer's own server answers. Whatever happy-dom
// fetches itself over HTTP — a plugin frame's page, a style sheet, a fetch no test stubbed — is
// answered here as not found, never from the network (CI: frames reached for a server that was not
// there; on a developer's machine they reached the real one). A data: URL and an aborted request are
// left to happy-dom, which answers them without the network. An API call no test stubbed is answered
// as mockApi answers one (404 NOT_FOUND, "no mock for …"): one rule for every test, and recorded
// (review 2026-10-17, minor 3). Failing such tests instead was weighed: 49 tests render views whose
// side calls (schedules, live syncs, personal fields) they do not test, and passed before as well,
// on CI with a refused connection, on a developer's machine against the real server. test/no-network.test.ts.
const happy = window as unknown as {
  happyDOM: { settings: { fetch: { interceptor: IFetchInterceptor | null } } }
}
/** Every request answered here, this test (read by test/no-network.test.ts). */
const intercepted: string[] = []
;(globalThis as { __mmIntercepted?: string[] }).__mmIntercepted = intercepted
/** The answer, as mockApi gives an unmocked call; null for a request left to happy-dom. */
const notFound = (request: HappyRequest): string | null => {
  const url = new URL(request.url)
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || request.signal?.aborted) return null
  intercepted.push(request.url)
  const raw = url.pathname.replace(/^\/api\//, '')
  // A path that does not decode is named as it came: a throw here would leave happy-dom's task open,
  // and every later wait for happy-dom would never end (second review 2026-10-17, minor 2).
  let path = raw
  try {
    path = decodeURI(raw)
  } catch {
    // kept as it came
  }
  return JSON.stringify({ code: 'NOT_FOUND', message: `no mock for ${request.method} ${path}` })
}
happy.happyDOM.settings.fetch.interceptor = {
  beforeAsyncRequest: async ({ request, window: w }) => {
    const body = notFound(request)
    return body === null ? undefined : new w.Response(body, { status: 404, statusText: 'Not Found' })
  },
  beforeSyncRequest: ({ request, window: w }) => {
    const body = notFound(request)
    return body === null
      ? undefined
      : {
          status: 404,
          statusText: 'Not Found',
          ok: false,
          url: request.url,
          redirected: false,
          headers: new w.Headers(),
          body: Buffer.from(body),
        }
  },
} satisfies IFetchInterceptor
afterEach(() => {
  intercepted.length = 0
})

// CI 2026-10-18: with no devtools to take them, an app's devtools plugins wait in this global list
// (vue-i18n's, by @vue/devtools-api 6), and with them the app, its props and its state, for the rest
// of the file: 100 000 grid rows kept after their test ran a worker out of memory. A test app never
// meets devtools; every test file, whatever mounts its apps (test/test-support.test.ts).
afterEach(() => {
  ;(globalThis as { __VUE_DEVTOOLS_PLUGINS__?: unknown[] }).__VUE_DEVTOOLS_PLUGINS__?.splice(0)
})

// CI 2026-11-05: a view loaded on first use (the document page, a dialog) is transformed and imported
// the first time a file waits for it; with every package's tests at once that took more than
// vi.waitFor's default second. A wait gives it five unless it names its own time (test-support.test.ts).
const waitFor = vi.waitFor.bind(vi)
vi.waitFor = ((callback, options) =>
  waitFor(
    callback,
    typeof options === 'number' ? options : { timeout: 5_000, ...options },
  )) as typeof vi.waitFor

// Security audit 2026-10-16: the app's confirmation waits a moment before taking Confirm. Tests of
// other things answer at once; test/confirm-guard.test.ts checks the wait itself.
confirmGuard.armMs = 0

// Views that show the header open the jobs socket; in tests it goes nowhere and never closes,
// so no test depends on a server, a reconnect timer or the order tests run in. Tests of the
// socket itself set their own factory.
setJobsSocketFactory(() => ({
  send: () => undefined,
  close: () => undefined,
  onopen: null,
  onmessage: null,
  onclose: null,
  onerror: null,
}))

// happy-dom has no canvas: the ECharts component is replaced by one that shows its option, so tests
// check what would be drawn. The real renderer runs in the e2e suite (Chromium, production CSP).
vi.mock('@/charts/echarts', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    __esModule: true,
    default: defineComponent({
      props: { option: { type: Object, required: true } },
      setup: (props) => () => h('div', { 'data-echarts': '', 'data-option': JSON.stringify(props.option) }),
    }),
  }
})
