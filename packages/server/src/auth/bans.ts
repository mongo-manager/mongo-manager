import type { DatabaseSync, StatementSync } from 'node:sqlite'
import { BlockList, isIP } from 'node:net'
import type { SignInBan, SignInBanReason } from '@mongo-manager/shared'
import { ipThrottleKey } from './throttle'

const MIN = 60_000
const HOUR = 60 * MIN

/** Failed or refused sign-in attempts from one address within the window that ban it. */
export const BAN_FAILURES = 30
export const BAN_WINDOW_MS = 15 * MIN
/**
 * Review of the bans (I4): an IPv6 /48 (65,536 /64s, cheap to rent) is banned as a whole after ten
 * times as many, so rotating through its /64s gets an attacker nowhere.
 */
export const BAN_FAILURES_48 = 10 * BAN_FAILURES
/** How long each strike bans an address: 15 minutes, an hour, 6 hours, then a day each time. */
export const BAN_STEPS_MS = [15 * MIN, HOUR, 6 * HOUR, 24 * HOUR] as const
/** A ban's strikes are forgotten a week after it ended. */
export const STRIKE_MEMORY_MS = 7 * 24 * HOUR
/** The most bans a list shows (the total is said beside them). */
export const BAN_LIST_MAX = 500

interface Row {
  address: string
  reason: SignInBanReason
  strikes: number
  banned_at: number
  until: number
  by_user: string | null
}

const toBan = (r: Row): SignInBan => ({
  address: r.address,
  reason: r.reason,
  strikes: r.strikes,
  bannedAt: r.banned_at,
  until: r.until,
  by: r.by_user,
})

/** 127.0.0.0/8 and ::1 (IPv4-mapped forms included). */
const LOOPBACK = new BlockList()
LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4')
LOOPBACK.addAddress('::1', 'ipv6')
/** Private, shared and link-local ranges: where a reverse proxy nobody named usually sits. */
const PRIVATE = new BlockList()
PRIVATE.addSubnet('10.0.0.0', 8, 'ipv4')
PRIVATE.addSubnet('172.16.0.0', 12, 'ipv4')
PRIVATE.addSubnet('192.168.0.0', 16, 'ipv4')
PRIVATE.addSubnet('100.64.0.0', 10, 'ipv4')
PRIVATE.addSubnet('169.254.0.0', 16, 'ipv4')
PRIVATE.addSubnet('fc00::', 7, 'ipv6')
PRIVATE.addSubnet('fe80::', 10, 'ipv6')

const inList = (list: BlockList, ip: string): boolean => {
  const family = isIP(ip)
  return family !== 0 && list.check(ip, family === 4 ? 'ipv4' : 'ipv6')
}

/** The address a ban holds: an IPv4 address as it is, an IPv6 address by its /64 (as the throttle). */
export const banAddress = (ip: string): string => ipThrottleKey(ip).slice(3)

/** An IPv6 address's /48 as a ban holds it; null for IPv4 (IPv4-mapped too). */
export function banNetwork(ip: string): string | null {
  const address = banAddress(ip)
  if (!address.endsWith('::/64')) return null
  return `${address.slice(0, -'::/64'.length).split(':').slice(0, 3).join(':')}::/48`
}

/**
 * This machine is never banned: a reverse proxy on it that is not named as trusted makes every
 * client look like it, and banning it would ban everyone (the throttle still holds it back).
 */
export const isLoopbackIp = (ip: string): boolean => inList(LOOPBACK, ip)

/** Why an address is never banned: this machine, or a private one while no proxy is trusted. */
export type BanExemption = 'loopback' | 'private'

/**
 * Sign-in bans (2026-10-30): an address with 30 failed or refused sign-in attempts in 15 minutes is
 * refused at the sign-in for 15 minutes, then an hour, 6 hours and a day each time it comes back
 * within a week (an IPv6 /48 after 300). On top of the throttle, which holds each guess back: a ban
 * refuses at once, before any password is checked, and outlives a restart. Bans are read from the
 * store on every check, so one lifted from the command line holds at once; the attempts counted
 * toward one live in memory.
 *
 * Review of the bans (I2): with no proxy named as trusted, a private address may be a reverse proxy
 * every client comes through (the Docker setup's gateway): banning it would ban the whole team, so it
 * is never banned — only held back by the throttle. A client on the internet cannot send from a
 * private address over TCP, so this is no way around a ban.
 */
export class SignInBans {
  /** Per address (and IPv6 /48), the times of its latest failures, oldest first. */
  private readonly failures = new Map<string, number[]>()
  private readonly trustsProxies: boolean
  private readonly maxAddresses: number
  private readonly sql: Record<
    'inForce' | 'one' | 'strikes' | 'remove' | 'prune' | 'upsert' | 'list' | 'count',
    StatementSync
  >

  constructor(
    db: DatabaseSync,
    private readonly now: () => number,
    opts: { trustsProxies?: boolean; maxAddresses?: number } = {},
  ) {
    this.trustsProxies = opts.trustsProxies ?? false
    this.maxAddresses = opts.maxAddresses ?? 10_000
    // Prepared once: a check runs on every sign-in step (review of the bans, I3).
    this.sql = {
      inForce: db.prepare(
        `SELECT reason, until FROM address_bans WHERE address IN (?, ?) AND until > ?
         ORDER BY until DESC LIMIT 1`,
      ),
      one: db.prepare('SELECT * FROM address_bans WHERE address = ?'),
      strikes: db.prepare('SELECT strikes, until FROM address_bans WHERE address = ?'),
      remove: db.prepare('DELETE FROM address_bans WHERE address = ?'),
      prune: db.prepare('DELETE FROM address_bans WHERE until < ?'),
      upsert: db.prepare(
        `INSERT INTO address_bans (address, reason, strikes, banned_at, until, by_user)
         VALUES (:address, :reason, :strikes, :banned_at, :until, :by_user)
         ON CONFLICT(address) DO UPDATE SET reason = excluded.reason, strikes = excluded.strikes,
           banned_at = excluded.banned_at, until = excluded.until, by_user = excluded.by_user`,
      ),
      list: db.prepare('SELECT * FROM address_bans WHERE until > ? ORDER BY until DESC, address LIMIT ?'),
      count: db.prepare('SELECT COUNT(*) AS n FROM address_bans WHERE until > ?'),
    }
  }

  /** Why the address is never banned, if it is not. */
  exemption(ip: string): BanExemption | null {
    if (inList(LOOPBACK, ip)) return 'loopback'
    if (!this.trustsProxies && inList(PRIVATE, ip)) return 'private'
    return null
  }

  /** The ban the address is refused by now (its own, or its /48's), or null. */
  current(ip: string): { reason: SignInBanReason; until: number } | null {
    if (this.exemption(ip)) return null
    const address = banAddress(ip)
    const row = this.sql.inForce.get(address, banNetwork(ip) ?? address, this.now()) as
      { reason: SignInBanReason; until: number } | undefined
    return row ? { reason: row.reason, until: row.until } : null
  }

  /** Until when the address is refused (0: it is not). */
  bannedUntil(ip: string): number {
    return this.current(ip)?.until ?? 0
  }

  /**
   * Counts a failed or refused attempt from the address; returns the ban it started, if it did. An
   * address already refused counts nothing: its refusals cost nothing, and its ban does not grow.
   */
  note(ip: string): SignInBan | null {
    if (this.exemption(ip) || this.current(ip)) return null
    const address = banAddress(ip)
    const network = banNetwork(ip)
    if (this.count(address) >= BAN_FAILURES) return this.ban(address, 'sign_in', null)
    if (network && this.count(network) >= BAN_FAILURES_48) return this.ban(network, 'sign_in', null)
    return null
  }

  /**
   * An administrator's block of an address for a while; strikes are kept as they were. It never
   * shortens a ban in force (that is a lift, which asks for more).
   */
  block(ip: string, ms: number, by: string): SignInBan {
    const address = banAddress(ip)
    const known = this.sql.strikes.get(address) as { strikes: number; until: number } | undefined
    const t = this.now()
    return this.ban(address, 'manual', by, Math.max(ms, (known?.until ?? 0) - t))
  }

  /**
   * Lifts the address's ban and forgets its strikes and failures: `lifted` when one was in force,
   * `forgotten` when only its record of past bans was, `none` when nothing was known.
   */
  lift(address: string): 'lifted' | 'forgotten' | 'none' {
    this.failures.delete(address)
    const row = this.sql.one.get(address) as unknown as Row | undefined
    this.sql.remove.run(address)
    return !row ? 'none' : row.until > this.now() ? 'lifted' : 'forgotten'
  }

  /** Lifts every ban and forgets every strike; how many bans were in force. */
  liftAll(): number {
    this.failures.clear()
    const inForce = (this.sql.count.get(this.now()) as { n: number }).n
    this.sql.prune.run(Number.MAX_SAFE_INTEGER)
    return inForce
  }

  /** The bans in force, the one ending last first (at most BAN_LIST_MAX), and how many there are. */
  list(): { bans: SignInBan[]; total: number } {
    const t = this.now()
    this.sql.prune.run(t - STRIKE_MEMORY_MS)
    const rows = this.sql.list.all(t, BAN_LIST_MAX) as unknown as Row[]
    return { bans: rows.map(toBan), total: (this.sql.count.get(t) as { n: number }).n }
  }

  /** Adds a failure at the key now; how many it has in the window. */
  private count(key: string): number {
    const t = this.now()
    const times = (this.failures.get(key) ?? []).filter((at) => t - at < BAN_WINDOW_MS)
    times.push(t)
    this.failures.delete(key)
    this.failures.set(key, times)
    // The oldest address goes first: a flood from many addresses never grows memory without end.
    if (this.failures.size > this.maxAddresses) this.failures.delete(this.failures.keys().next().value!)
    return times.length
  }

  private ban(address: string, reason: SignInBanReason, by: string | null, manualMs?: number): SignInBan {
    const t = this.now()
    this.failures.delete(address)
    this.sql.prune.run(t - STRIKE_MEMORY_MS)
    const known = this.sql.strikes.get(address) as { strikes: number } | undefined
    const strikes = reason === 'manual' ? (known?.strikes ?? 0) : (known?.strikes ?? 0) + 1
    const ms = manualMs ?? BAN_STEPS_MS[Math.min(strikes, BAN_STEPS_MS.length) - 1]!
    const row: Row = { address, reason, strikes, banned_at: t, until: t + ms, by_user: by }
    this.sql.upsert.run({ ...row })
    return toBan(row)
  }
}

/**
 * Sign-in bans (2026-10-30): the sign-in steps an address may take a minute, all steps together (a
 * person takes a few). Counted by the app's clock, per address as a ban holds it, bounded in memory.
 */
export class SignInBudget {
  private readonly windows = new Map<string, { start: number; spent: number }>()

  constructor(
    private readonly now: () => number,
    private readonly perMinute: number,
    private readonly maxAddresses = 10_000,
  ) {}

  /** Spends one step; how long until the address may take another (0: it may now). */
  spend(ip: string): number {
    const address = banAddress(ip)
    const t = this.now()
    const known = this.windows.get(address)
    const window = known && t - known.start < MIN ? known : { start: t, spent: 0 }
    window.spent += 1
    this.windows.delete(address)
    this.windows.set(address, window)
    if (this.windows.size > this.maxAddresses) this.windows.delete(this.windows.keys().next().value!)
    return window.spent > this.perMinute ? window.start + MIN - t : 0
  }
}

/**
 * An address as an administrator types it: a plain IPv4 or IPv6 address (IPv4-mapped only dotted, no
 * zone, not the unspecified one); null for anything else.
 */
export function plainIp(input: string): string | null {
  const text = input.trim()
  if (!isIP(text) || text.includes('%')) return null
  if (/^::ffff:/i.test(text) && isIP(text.slice(7)) !== 4) return null
  // The unspecified address (0.0.0.0, ::) is nobody's.
  return /^[0:.]*$/.test(text) ? null : text
}

/**
 * The address a ban is lifted by: an IP address (an IPv6 one by its /64), or an IPv6 /64 or /48 as a
 * ban shows it; null for anything else.
 */
export function banTarget(input: string): string | null {
  const text = input.trim()
  const ip = plainIp(text)
  if (ip) return banAddress(ip)
  const v6 = /^([0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,3})::\/(64|48)$/i.exec(text)
  if (!v6 || isIP(`${v6[1]}::`) !== 6) return null
  return v6[2] === '64' ? banAddress(`${v6[1]}::`) : banNetwork(`${v6[1]}::`)
}
