// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, vi } from 'vitest'
import { enableAutoUnmount, mount } from '@vue/test-utils'

import { createPinia, getActivePinia, setActivePinia } from 'pinia'
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query'
import type { Component } from 'vue'
import { i18n } from '../../src/i18n'

// Unmount every test app so none renders into a document another test has emptied.
enableAutoUnmount(afterEach)

/** An answer as [status, JSON body], or a Response of its own (bytes, headers: a file's preview). */
export type Handler = (
  body: unknown,
  url: URL,
) => [number, unknown?] | Response | Promise<[number, unknown?] | Response>

export interface ApiCall {
  method: string
  path: string
  body: unknown
  headers: Record<string, string>
}

/** Stubs fetch: handlers are keyed "METHOD path" with the path relative to /api/. */
export function mockApi(handlers: Record<string, Handler>) {
  const calls: ApiCall[] = []
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input))
    const method = (init.method ?? 'GET').toUpperCase()
    const path = decodeURI(url.pathname.replace(/^\/api\//, ''))
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined
    calls.push({ method, path, body, headers: (init.headers ?? {}) as Record<string, string> })
    const handler = handlers[`${method} ${path}`]
    if (!handler)
      return new Response(JSON.stringify({ code: 'NOT_FOUND', message: `no mock for ${method} ${path}` }), {
        status: 404,
      })
    // As fetch does: an aborted request rejects, whatever its handler is still doing.
    const signal = init.signal ?? undefined
    if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError')
    const answer = await (signal
      ? Promise.race([
          handler(body, url),
          new Promise<never>((_, reject) =>
            signal.addEventListener('abort', () =>
              reject(new DOMException('The operation was aborted.', 'AbortError')),
            ),
          ),
        ])
      : handler(body, url))
    if (answer instanceof Response) return answer
    const [status, data] = answer
    return new Response(data === undefined ? null : JSON.stringify(data), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  })
  vi.stubGlobal('fetch', fetchMock)
  return { calls, fetchMock }
}

export function mountApp(
  component: Component,
  options: { props?: Record<string, unknown>; slots?: Record<string, unknown>; plugins?: unknown[] } = {},
) {
  // Reuse the test's active Pinia so router guards and components share one session store.
  const pinia = getActivePinia() ?? createPinia()
  setActivePinia(pinia)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = mount(component, {
    attachTo: document.body,
    props: options.props,
    ...(options.slots ? { slots: options.slots as never } : {}),
    global: { plugins: [pinia, i18n, [VueQueryPlugin, { queryClient }], ...((options.plugins ?? []) as [])] },
  })
  return { wrapper, pinia, queryClient }
}
