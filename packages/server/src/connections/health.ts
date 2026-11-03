import type { ConnectionHealth } from '@mongo-manager/shared'
import { topologyOf, type ConnectionManager } from './manager'
import { ConnectionError, OIDC_PER_PERSON } from './errors'

export type HealthValue = Omit<ConnectionHealth, 'connectionId' | 'alertsFiring'>

const TTL_MS = 30_000
const PING_MS = 3_000
const OPEN_MS = 5_000
const MAX_CACHED = 1000

const IDLE: HealthValue = { state: 'idle', latencyMs: null, version: null, topology: null, checkedAt: null }

/** `work`, or a rejection once `ms` have passed. */
function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timed out')), ms)
      timer.unref()
    }),
  ]).finally(() => clearTimeout(timer))
}

/**
 * W3.4: a connection's live health — one hello timed as its ping, the version read when the client
 * opened, the topology — cached for 30 s and asked once at a time. The list asks only connections
 * whose client is already open (a page never makes the server dial every saved connection); a
 * connection's own page may open it, as listing its databases would. A failure says only "down".
 */
export class HealthCache {
  private readonly cache = new Map<string, HealthValue & { at: number }>()
  private readonly inflight = new Map<string, Promise<HealthValue>>()

  constructor(private readonly d: { manager: ConnectionManager; now: () => number; ttlMs?: number }) {}

  async get(id: string, connect: boolean): Promise<HealthValue> {
    const hit = this.cache.get(id)
    if (hit && this.d.now() - hit.at < (this.d.ttlMs ?? TTL_MS)) {
      const { at: _at, ...value } = hit
      void _at
      return value
    }
    if (!connect && !this.d.manager.isOpen(id)) return IDLE
    let pending = this.inflight.get(id)
    if (!pending) {
      pending = this.check(id).finally(() => this.inflight.delete(id))
      this.inflight.set(id, pending)
    }
    return pending
  }

  forget(id: string): void {
    this.cache.delete(id)
  }

  private async check(id: string): Promise<HealthValue> {
    const release = this.d.manager.hold(id)
    let value: HealthValue
    // Review of the open's stop (minor 9): an open stopped meanwhile says nothing of the server.
    let stopped = false
    try {
      const client = await within(this.d.manager.getClient(id), OPEN_MS)
      const started = performance.now()
      const hello = await client.db('admin').command({ hello: 1 }, { timeoutMS: PING_MS })
      value = {
        state: 'ok',
        latencyMs: Math.round(performance.now() - started),
        version: await this.d.manager.version(id),
        topology: topologyOf(hello),
        checkedAt: new Date(this.d.now()).toISOString(),
      }
    } catch (e) {
      stopped = e instanceof ConnectionError && e.kind === 'closed'
      value = {
        // W7, security review Minor 4: a per-person OIDC connection in team mode has no client of
        // the server's own — not down: each person signs in.
        state: e instanceof ConnectionError && e.message === OIDC_PER_PERSON ? 'per_person' : 'down',
        latencyMs: null,
        version: null,
        topology: null,
        checkedAt: new Date(this.d.now()).toISOString(),
      }
    } finally {
      release()
    }
    if (stopped) return IDLE
    if (this.cache.size >= MAX_CACHED) this.cache.clear()
    this.cache.set(id, { ...value, at: this.d.now() })
    return value
  }
}
