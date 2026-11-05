// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { PluginPermission } from '@mongo-manager/shared/browser'

/**
 * Phase 4b §3: the host side of a plugin frame's `postMessage` bridge. Only messages from the
 * frame's own window, sent from its opaque origin ("null": sandboxed, never the app's), are read;
 * each is at most 1 MB, at most 8 wait at once, and a method runs only with the permission an
 * administrator approved. Messages: `{ mm: 1, id, method, params }`, answered `{ mm: 1, id, result }`
 * or `{ mm: 1, id, error: { code, message } }`. The host asks the frame the same way (cell renderers).
 */

export const MAX_MESSAGE_BYTES = 1024 * 1024
export const MAX_OUTSTANDING = 8

export const BRIDGE_METHODS = {
  'context.get': null,
  'ui.toast': null,
  'ui.openDocument': null,
  'ui.resize': null,
  // User report 2026-10-16: a collection tab's page asks to stay loaded while another section shows.
  'ui.keepOpen': null,
  'documents.find': 'documents:read',
  'documents.get': 'documents:read',
  'documents.update': 'documents:write',
  // Plugins wave 1: a query or stages handed to the user's own editors (nothing runs), and a
  // read-only pipeline on the plugin's collection.
  'ui.useQuery': null,
  // Research 2026-10-28 (reverse references): a query handed to another collection of its database.
  'ui.useQueryIn': 'database:read',
  'ui.copy': null,
  'ui.useAggregation': null,
  // User request 2026-10-10: the app's own SQL import and export, opened on the user's click; the
  // dialogs and the server decide everything else, with the user's rights.
  'ui.importSql': null,
  'ui.exportSql': null,
  'documents.aggregate': 'documents:read',
  // Plugins wave 2: read-only — the collection's indexes; the other collections of its database.
  'indexes.list': 'collection:read',
  'collections.list': 'database:read',
  'documents.findIn': 'database:read',
  // Plugins wave 3: a file saved on the user's click; documents handed to the Import wizard, where
  // the user decides; a collection's validation rules; the database's model (the Database tab's).
  'ui.download': null,
  'ui.importDocuments': null,
  'validation.get': 'collection:read',
  'database.model': 'database:read',
  // Plugins wave 4: the database's storage; compact's estimate, and compact in the app's own dialog
  // (the name typed); a shard key's analysis (its values are data); the collection's search indexes.
  'storage.stats': 'database:read',
  'storage.compactEstimate': 'collection:read',
  'ui.compact': 'collection:read',
  'shardKey.analyze': 'documents:read',
  'searchIndexes.list': 'collection:read',
  // Research 2026-10-28 (the personal data finder): fields of its collection suggested as personal
  // data — listed in the collection's Personal data section, where an administrator adds each.
  'ui.suggestPersonalData': 'documents:read',
} as const satisfies Record<string, PluginPermission | null>
export type BridgeMethod = keyof typeof BRIDGE_METHODS

export type BridgeHandlers = Partial<Record<BridgeMethod, (params: unknown) => unknown>>

/** A failure a plugin may be told about: its code and a message of the app's own words. */
export class BridgeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

type Id = string | number
const isId = (v: unknown): v is Id =>
  (typeof v === 'string' && v.length > 0 && v.length <= 64) || (typeof v === 'number' && Number.isFinite(v))
/** A message's size: its JSON's UTF-8 bytes. */
const encoder = new TextEncoder()
const bytesOf = (text: string) => encoder.encode(text).length
const sizeOf = (data: unknown): number => {
  try {
    return bytesOf(JSON.stringify(data) ?? '')
  } catch {
    return Infinity
  }
}

export interface Bridge {
  /**
   * Greets the page once it loaded, with a token of its own: only messages carrying it are read
   * (4b review I1 — a page the frame navigated to is not greeted, so it is never answered).
   */
  hello(): void
  /** Tells the greeted page something changed (`{ mm: 1, type, ...data }`), never before the greeting. */
  notify(type: string, data: Record<string, unknown>): void
  /** Asks the frame (host → plugin); the answer, or a failure after `timeoutMs`. */
  ask(method: string, params: unknown, timeoutMs: number): Promise<unknown>
  dispose(): void
}

export function createBridge(opts: {
  frame: () => Window | null | undefined
  /** What an administrator approved, read at each request (security audit 2026-10-16, M3). */
  permissions: () => readonly PluginPermission[]
  handlers: BridgeHandlers
}): Bridge {
  let outstanding = 0
  let counter = 0
  let token: string | null = null
  const asked = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  const post = (message: object) => {
    const { id } = message as { id: Id }
    let text: string
    try {
      text = JSON.stringify(message)
    } catch {
      text = JSON.stringify({ mm: 1, id, error: { code: 'failed', message: 'The request failed' } })
    }
    if (bytesOf(text) > MAX_MESSAGE_BYTES)
      text = JSON.stringify({ mm: 1, id, error: { code: 'too_large', message: 'The answer is over 1 MB' } })
    // Plain JSON only crosses (never the app's reactive state, never an object of its own); an opaque
    // origin cannot be named, so the message goes to this frame's window only.
    opts.frame()?.postMessage(JSON.parse(text), '*')
  }
  const fail = (id: Id, code: string, message: string) => post({ mm: 1, id, error: { code, message } })

  const onMessage = (event: MessageEvent) => {
    const own = opts.frame()
    if (!own || event.source !== own || event.origin !== 'null') return
    const data = event.data as { mm?: unknown; id?: unknown; method?: unknown; params?: unknown } | null
    if (!data || typeof data !== 'object' || Array.isArray(data) || data.mm !== 1 || !isId(data.id)) return
    if (token === null || (data as { token?: unknown }).token !== token) return
    const id = data.id
    if (sizeOf(data) > MAX_MESSAGE_BYTES) return fail(id, 'too_large', 'A message is at most 1 MB')
    // An answer to what the host asked.
    if (data.method === undefined) {
      const waiting = typeof id === 'string' ? asked.get(id) : undefined
      if (waiting) {
        asked.delete(id as string)
        waiting.resolve((data as { result?: unknown }).result)
      }
      return
    }
    const method = data.method
    if (typeof method !== 'string' || !Object.hasOwn(BRIDGE_METHODS, method))
      return fail(id, 'unknown_method', 'No such method')
    const needs = BRIDGE_METHODS[method as BridgeMethod]
    if (needs && !opts.permissions().includes(needs))
      return fail(id, 'not_permitted', `This plugin was not approved for ${needs}`)
    const handler = opts.handlers[method as BridgeMethod]
    if (!handler) return fail(id, 'unavailable', 'Not available here')
    if (outstanding >= MAX_OUTSTANDING) return fail(id, 'too_many', 'At most 8 requests at once')
    outstanding++
    void (async () => {
      try {
        post({ mm: 1, id, result: await handler(data.params) })
      } catch (e) {
        // The app's own words only: an internal error never reaches a plugin.
        if (e instanceof BridgeError) fail(id, e.code, e.message)
        else fail(id, 'failed', 'The request failed')
      } finally {
        outstanding--
      }
    })()
  }
  window.addEventListener('message', onMessage)

  return {
    hello() {
      token = crypto.randomUUID()
      post({ mm: 1, type: 'hello', token })
    },
    notify(type, data) {
      if (token !== null) post({ ...data, mm: 1, type })
    },
    ask(method, params, timeoutMs) {
      const id = `h${++counter}`
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          asked.delete(id)
          reject(new Error('The plugin did not answer in time'))
        }, timeoutMs)
        asked.set(id, {
          resolve: (v) => {
            clearTimeout(timer)
            resolve(v)
          },
          reject,
        })
        post({ mm: 1, id, method, params })
      })
    },
    dispose() {
      token = null
      window.removeEventListener('message', onMessage)
      for (const w of asked.values()) w.reject(new Error('The plugin was closed'))
      asked.clear()
    },
  }
}
