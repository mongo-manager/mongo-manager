interface Entry {
  failures: number
  lockedUntil: number
  /** When the last failure was counted. */
  last: number
}

export interface ThrottleOptions {
  freeAttempts?: number
  /** Free attempts for keys with this prefix instead (security review 2026-10-13, L1). */
  freeByPrefix?: Record<string, number>
  baseDelayMs?: number
  maxDelayMs?: number
  maxKeys?: number
  /** Failures older than this are forgotten (review of L1: old guesses held an account back for good). */
  decayMs?: number
}

/** Spec §5 S3: per-key exponential lockout. In-memory by design; restarts reset it. */
export class LoginThrottle {
  private readonly entries = new Map<string, Entry>()
  private readonly free: number
  private readonly freeByPrefix: Array<[string, number]>
  private readonly base: number
  private readonly max: number
  private readonly maxKeys: number
  private readonly decay: number

  constructor(
    private readonly now: () => number,
    opts: ThrottleOptions = {},
  ) {
    this.free = opts.freeAttempts ?? 5
    this.freeByPrefix = Object.entries(opts.freeByPrefix ?? {})
    this.base = opts.baseDelayMs ?? 1000
    this.max = opts.maxDelayMs ?? 15 * 60_000
    this.maxKeys = opts.maxKeys ?? 10_000
    this.decay = opts.decayMs ?? 24 * 3600_000
  }

  retryAfterMs(key: string): number {
    const entry = this.entries.get(key)
    return entry ? Math.max(0, entry.lockedUntil - this.now()) : 0
  }

  /** Counts a failure; returns when the key was locked until before it, for forgive(). */
  recordFailure(key: string): number {
    const t = this.now()
    const known = this.entries.get(key)
    const entry = known && t - known.last <= this.decay ? known : { failures: 0, lockedUntil: 0, last: t }
    const before = entry.lockedUntil
    entry.failures += 1
    entry.last = t
    const over = entry.failures - this.freeFor(key)
    if (over > 0) entry.lockedUntil = this.now() + Math.min(this.base * 2 ** Math.min(over - 1, 30), this.max)
    this.entries.delete(key)
    this.entries.set(key, entry)
    if (this.entries.size > this.maxKeys) this.evict(key)
    return before
  }

  /**
   * Undo one pessimistically recorded failure (the attempt turned out to be correct): the count goes
   * back, and so does the lock it set — a correct answer never holds the key back (review of L1).
   */
  forgive(key: string, lockedBefore = 0): void {
    const entry = this.entries.get(key)
    if (!entry) return
    entry.failures -= 1
    if (entry.failures <= 0) this.entries.delete(key)
    else entry.lockedUntil = entry.failures <= this.freeFor(key) ? 0 : lockedBefore
  }

  reset(key: string): void {
    this.entries.delete(key)
  }

  private freeFor(key: string): number {
    for (const [prefix, n] of this.freeByPrefix) if (key.startsWith(prefix)) return n
    return this.free
  }

  /**
   * Keeps memory bounded without letting an attacker flush a victim's lock by flooding other keys:
   * unlocked entries go first (oldest first), then locked ip keys, and locked user keys only last.
   */
  private evict(keep: string): void {
    const t = this.now()
    for (const [k, e] of this.entries) {
      if (this.entries.size <= this.maxKeys) return
      if (k !== keep && e.lockedUntil <= t) this.entries.delete(k)
    }
    for (const prefix of ['ip:', '']) {
      const locked = [...this.entries]
        .filter(([k]) => k !== keep && k.startsWith(prefix))
        .sort((a, b) => a[1].lockedUntil - b[1].lockedUntil)
      for (const [k] of locked) {
        if (this.entries.size <= this.maxKeys) return
        this.entries.delete(k)
      }
    }
  }
}

function expandIpv6(ip: string): string[] {
  const [head = '', tail] = ip.split('::')
  const left = head ? head.split(':') : []
  const right = tail ? tail.split(':') : []
  const fill = tail === undefined ? [] : Array<string>(8 - left.length - right.length).fill('0')
  return [...left, ...fill, ...right]
}

/**
 * Security review 2026-10-13 (L1): the addresses an account signed in from lately. Guesses from
 * many other addresses hold the account back there, never where its owner signs in. In memory, as
 * the throttle: a restart forgets them.
 */
export class KnownSignIns {
  /** Per account, its addresses and until when each is known (oldest first). */
  private readonly accounts = new Map<string, Map<string, number>>()

  constructor(
    private readonly now: () => number,
    private readonly ttlMs = 30 * 24 * 60 * 60_000,
    /** Accounts remembered; one signing in from many addresses never pushes another's out. */
    private readonly maxAccounts = 10_000,
    private readonly perAccount = 20,
  ) {}

  add(account: string, ipKey: string): void {
    const known = this.accounts.get(account) ?? new Map<string, number>()
    this.accounts.delete(account)
    this.accounts.set(account, known)
    known.delete(ipKey)
    known.set(ipKey, this.now() + this.ttlMs)
    if (known.size > this.perAccount) known.delete(known.keys().next().value!)
    if (this.accounts.size > this.maxAccounts) this.accounts.delete(this.accounts.keys().next().value!)
  }

  has(account: string, ipKey: string): boolean {
    return (this.accounts.get(account)?.get(ipKey) ?? 0) > this.now()
  }
}

/** IPv4 addresses are keyed as-is; IPv6 by /64, since one client usually controls a whole /64. */
export function ipThrottleKey(ip: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip)
  if (mapped) return `ip:${mapped[1]}`
  if (!ip.includes(':')) return `ip:${ip}`
  const groups = expandIpv6(ip.toLowerCase())
    .slice(0, 4)
    .map((g) => g.replace(/^0+(?=.)/, ''))
  return `ip:${groups.join(':')}::/64`
}
