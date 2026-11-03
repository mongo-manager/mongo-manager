import type { CommandOperationOptions, Document, MongoClient } from 'mongodb'
import { rawFrom, sampleFrom, type RawStatus, type ServerSample } from './sampler'
import { LENIENT } from '../data/mongo-errors'

export type MonitorEvent = { sample: ServerSample } | { error: 'NOT_PERMITTED' | 'UNREACHABLE' }
type Listener = (event: MonitorEvent) => void

/**
 * serverStatus without the sections the charts never use (they are the heavy ones). Widgets wave 2:
 * `metrics` is read for the query executor, documents and cursors, without its per-command,
 * per-stage and per-operator counters (the bulk of it).
 */
export const STATUS = {
  serverStatus: 1,
  repl: 0,
  metrics: { commands: false, aggStageCounters: false, operatorCounters: false },
  locks: 0,
  tcmalloc: 0,
}
/** Today's charts' reading, for a server that does not take a section's parts left out. */
export const STATUS_WITHOUT_METRICS = { serverStatus: 1, repl: 0, metrics: 0, locks: 0, tcmalloc: 0 }
/** A malformed command (BadValue, FailedToParse, TypeMismatch): the server reads it differently. */
const MALFORMED = new Set([2, 9, 14])

/** Clients whose server refused the embedded exclusion: asked without the section from then on. */
const withoutMetrics = new WeakSet<MongoClient>()

/**
 * serverStatus as the charts read it; a server that refuses the embedded exclusion is asked again
 * without the metrics section (its wave 2 charts show gaps), never left unread — and, once it has
 * refused, asked that way only (review of wave 2, M6: not two questions a reading).
 */
export async function readStatus(client: MongoClient, options: CommandOperationOptions): Promise<Document> {
  const admin = client.db('admin')
  if (withoutMetrics.has(client)) return admin.command(STATUS_WITHOUT_METRICS, options)
  try {
    return await admin.command(STATUS, options)
  } catch (e) {
    if (!MALFORMED.has(Number((e as { code?: unknown }).code))) throw e
    withoutMetrics.add(client)
    return admin.command(STATUS_WITHOUT_METRICS, options)
  }
}
/** A previous reading older than this is not used for the status route's rates. */
const STATUS_BASELINE_MS = 30_000
/** After MongoDB refuses serverStatus, ask again only this rarely: each refusal is audited there. */
export const REFUSED_BACKOFF_MS = 30_000

interface Sampler {
  listeners: Set<Listener>
  timer: NodeJS.Timeout
  release: () => void
  prev: RawStatus | null
  busy: boolean
}

const refused = (e: unknown) => {
  const code = (e as { code?: unknown }).code
  return code === 13 || code === 18
}

/**
 * One serverStatus sampler per watched connection (phase 1i spec §3): started by the first
 * subscriber, stopped by the last, holding its connection while it runs. Nothing is stored.
 */
export class MonitorHub {
  private readonly samplers = new Map<string, Sampler>()
  /** The last reading per connection for the polling route, so it can give rates too. */
  private readonly baselines = new Map<string, RawStatus>()
  /** When each connection was last asked, across samplers: a dropped and retaken watch waits its turn. */
  private readonly lastAsked = new Map<string, number>()
  /** Connections whose serverStatus was refused, until when to leave them alone. */
  private readonly pausedUntil = new Map<string, number>()

  constructor(
    private readonly deps: {
      client: (connectionId: string) => Promise<MongoClient>
      hold: (connectionId: string) => () => void
      intervalMs?: number
      now?: () => number
    },
  ) {}

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  subscribe(connectionId: string, listener: Listener): () => void {
    let sampler = this.samplers.get(connectionId)
    if (!sampler) {
      const created: Sampler = {
        listeners: new Set(),
        release: this.deps.hold(connectionId),
        prev: null,
        busy: false,
        timer: setInterval(() => void this.tick(connectionId, created), this.deps.intervalMs ?? 2_000),
      }
      created.timer.unref()
      sampler = created
      this.samplers.set(connectionId, sampler)
      const last = this.lastAsked.get(connectionId)
      if (last === undefined || this.now() - last >= (this.deps.intervalMs ?? 2_000))
        void this.tick(connectionId, sampler)
    }
    sampler.listeners.add(listener)
    // Refused a moment ago: say so now rather than leave the new watcher waiting for the back-off.
    if ((this.pausedUntil.get(connectionId) ?? 0) > this.now())
      queueMicrotask(() => listener({ error: 'NOT_PERMITTED' }))
    const own = sampler
    return () => {
      own.listeners.delete(listener)
      if (own.listeners.size === 0 && this.samplers.get(connectionId) === own) this.stop(connectionId, own)
    }
  }

  /** Readings kept for the polling route (tests). */
  statusBaselines(): number {
    return this.baselines.size
  }

  count(connectionId: string): number {
    return this.samplers.get(connectionId)?.listeners.size ?? 0
  }

  /** One reading for the polling fallback; rates against the previous one when it is recent. */
  async status(connectionId: string): Promise<ServerSample> {
    const client = await this.deps.client(connectionId)
    const next = rawFrom(await readStatus(client, LENIENT), this.now())
    const prev = this.baselines.get(connectionId)
    // Readings too old to give a rate are forgotten, a deleted connection's included.
    for (const [id, reading] of this.baselines)
      if (next.at - reading.at > STATUS_BASELINE_MS) this.baselines.delete(id)
    this.baselines.set(connectionId, next)
    return sampleFrom(prev && next.at - prev.at <= STATUS_BASELINE_MS ? prev : null, next)
  }

  close(): void {
    for (const [id, sampler] of this.samplers) this.stop(id, sampler)
    this.baselines.clear()
  }

  private stop(connectionId: string, sampler: Sampler): void {
    clearInterval(sampler.timer)
    sampler.release()
    this.samplers.delete(connectionId)
  }

  private async tick(connectionId: string, sampler: Sampler): Promise<void> {
    // A slow server answers after the next tick: never pile the questions up.
    if (sampler.busy) return
    if ((this.pausedUntil.get(connectionId) ?? 0) > this.now()) return
    sampler.busy = true
    this.lastAsked.set(connectionId, this.now())
    let event: MonitorEvent
    try {
      const client = await this.deps.client(connectionId)
      const next = rawFrom(await readStatus(client, LENIENT), this.now())
      event = { sample: sampleFrom(sampler.prev, next) }
      sampler.prev = next
    } catch (e) {
      event = { error: refused(e) ? 'NOT_PERMITTED' : 'UNREACHABLE' }
      if (refused(e)) this.pausedUntil.set(connectionId, this.now() + REFUSED_BACKOFF_MS)
    } finally {
      sampler.busy = false
    }
    if (this.samplers.get(connectionId) !== sampler) return
    for (const listener of sampler.listeners) {
      try {
        listener(event)
      } catch {
        // One listener's failure must not stop the others.
      }
    }
  }
}
