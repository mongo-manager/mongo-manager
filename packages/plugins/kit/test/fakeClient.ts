import { AskError, type Accent, type PluginClient, type PluginContext } from '../src/client'

/**
 * Plugins wave 3: a plugin client for view tests, answering from `handlers` as the app would — its
 * context a copy (what the page keeps never changes under it), one pipeline at a time. `greet`
 * plays the app's greeting; `contexts` are the page's listeners for a language or theme change.
 */
export function fakeClient(
  opts: {
    place: PluginContext['place']
    kind?: string
    id?: string
    settings?: PluginContext['settings']
    locale?: string
  },
  handlers: Record<string, (params: Record<string, unknown>) => unknown>,
) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  let ready: (() => void) | null = null
  let aggregating = false
  const contexts: Array<(l: string, t: 'light' | 'dark', a: Accent) => void> = []
  const contribution = { kind: opts.kind ?? 'collectionTab', id: opts.id ?? 'tab' }
  const client: PluginClient = {
    contribution,
    ask: async <T>(method: string, params?: unknown) => {
      const p = (params ?? {}) as Record<string, unknown>
      calls.push({ method, params: p })
      if (method === 'context.get')
        return {
          plugin: { id: 'test', version: '1' },
          contribution,
          locale: opts.locale ?? 'en',
          theme: 'light',
          accent: 'emerald',
          place: structuredClone(opts.place),
          settings: opts.settings ?? {},
        } as T
      const handler = handlers[method]
      if (!handler) throw new AskError('unavailable', `No ${method} here`)
      if (method === 'documents.aggregate') {
        if (aggregating) throw new AskError('busy', 'Its last pipeline is still running')
        aggregating = true
        try {
          return (await handler(p)) as T
        } finally {
          aggregating = false
        }
      }
      return (await handler(p)) as T
    },
    onReady: (fn) => {
      ready = fn
    },
    onContext: (fn) => {
      contexts.push(fn)
    },
    onCells: () => {},
  }
  return { client, calls, greet: () => ready!(), contexts }
}

/** A few turns of the event loop. */
export const flush = async (times = 4) => {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0))
}
