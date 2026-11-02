import {
  APP_EVENT_KINDS,
  type AppEvent,
  type AppEventDetails,
  type AppEventInput,
  type AppEventKind,
} from '@mongo-manager/shared'

/**
 * The app-event hook (completion design §2 W4.7; contract in docs/app-events.md), one per server
 * context (`ctx.events`): emitters call `ctx.events.emit(kind, input)`; subscribers — the alerts of
 * W3, wired in http/app.ts — call `ctx.events.on(listener)`.
 *
 * - Emitting never blocks or fails the emitter: listeners run on a later tick, each on its own, and a
 *   listener that throws (or rejects) is ignored.
 * - An event is bounded and flat: the summary at most 300 characters, at most 20 details of strings
 *   (cut at 200), finite numbers, booleans or null; anything else is dropped. Emitters pass ids,
 *   names and counts — never a document value (a summary or detail may reach e-mail or a webhook).
 * - An unknown kind is dropped, so a typo never reaches an alert rule.
 * - W4 review I4: the listeners belong to the context (no module-level state shared between two
 *   servers in one process, or between tests), and the time is the context's clock.
 */
type Listener = (event: AppEvent) => void | Promise<void>

const KINDS: ReadonlySet<string> = new Set(APP_EVENT_KINDS)
const MAX_SUMMARY = 300
const MAX_TEXT = 200
const MAX_DETAILS = 20

function bounded(details: AppEventDetails | undefined): AppEventDetails {
  const out = Object.create(null) as AppEventDetails
  let n = 0
  for (const [k, v] of Object.entries(details ?? {})) {
    if (n >= MAX_DETAILS) break
    let value: string | number | boolean | null
    if (typeof v === 'string') value = v.slice(0, MAX_TEXT)
    else if (typeof v === 'number' && Number.isFinite(v)) value = v
    else if (typeof v === 'boolean' || v === null) value = v
    else continue
    // Defined, never assigned: a key named "__proto__" stays data.
    Object.defineProperty(out, k.slice(0, 64), {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    })
    n++
  }
  return out
}

export class AppEvents {
  private readonly listeners = new Set<Listener>()

  constructor(private readonly now: () => number = Date.now) {}

  emit(kind: AppEventKind, input: AppEventInput): void {
    if (!KINDS.has(kind) || this.listeners.size === 0) return
    const event: AppEvent = {
      kind,
      at: this.now(),
      severity: input.severity,
      connectionId: input.connectionId ?? null,
      namespace: input.namespace ?? null,
      ownerId: input.ownerId ?? null,
      summary: String(input.summary).slice(0, MAX_SUMMARY),
      details: bounded(input.details),
    }
    for (const listener of [...this.listeners])
      setImmediate(() => {
        try {
          void Promise.resolve(listener(event)).catch(() => undefined)
        } catch {
          // A listener's bug never reaches the emitter or the other listeners.
        }
      })
  }

  /** Subscribes to every app event; returns the unsubscribe. */
  on(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }
}
