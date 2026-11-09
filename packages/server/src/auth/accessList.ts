// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { DatabaseSync } from 'node:sqlite'
import { BlockList, isIP } from 'node:net'
import { z } from 'zod'
import type { AccessEntry } from '@mongo-manager/shared'
import { SettingsRepo } from '../store/settings'

const KEY = 'access.allowlist'
/**
 * Review of panel access (minor 2): the stored list is read leniently, so a later release that reads
 * entries more strictly never turns a list that worked into one that locks everyone out.
 */
const StoredSchema = z.object({
  entries: z.array(z.object({ range: z.string(), label: z.string().catch('') })),
})
/** How long a read of the list is used before the store is read again (a command line change). */
export const ACCESS_RELOAD_MS = 5_000

/** An IPv4 or IPv6 address as 32 or 128 bits; an IPv4-mapped one as IPv4. */
function bitsOf(ip: string): { v4: boolean; value: bigint } | null {
  const family = isIP(ip)
  if (family === 4)
    return { v4: true, value: ip.split('.').reduce((n, o) => (n << 8n) | BigInt(Number(o)), 0n) }
  if (family !== 6) return null
  let text = ip
  const dotted = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text)?.[1]
  if (dotted) {
    const v4 = bitsOf(dotted)!.value
    text = `${text.slice(0, -dotted.length)}${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`
  }
  const [head = '', tail] = text.split('::')
  const left = head ? head.split(':') : []
  const right = tail ? tail.split(':') : []
  const groups =
    tail === undefined
      ? left
      : [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right]
  const value = groups.reduce((n, g) => (n << 16n) | BigInt(parseInt(g, 16)), 0n)
  // ::ffff:a.b.c.d (in any spelling) is an IPv4 address.
  if (value >> 32n === 0xffffn) return { v4: true, value: value & 0xffffffffn }
  return { v4: false, value }
}

function textOf(v4: boolean, value: bigint): string {
  if (v4) return [24n, 16n, 8n, 0n].map((s) => String((value >> s) & 0xffn)).join('.')
  const groups = [112n, 96n, 80n, 64n, 48n, 32n, 16n, 0n].map((s) => ((value >> s) & 0xffffn).toString(16))
  // The longest run of two or more zero groups is written ::, as addresses are usually shown.
  let best = { at: -1, len: 1 }
  for (let i = 0; i < 8;) {
    let j = i
    while (j < 8 && groups[j] === '0') j++
    if (j - i > best.len) best = { at: i, len: j - i }
    i = j === i ? i + 1 : j
  }
  if (best.at < 0) return groups.join(':')
  return `${groups.slice(0, best.at).join(':')}::${groups.slice(best.at + best.len).join(':')}`
}

/**
 * An address or a CIDR range as an administrator types it, in the one form it is kept in (the
 * address written the usual way, the bits past the mask cleared, IPv4-mapped as IPv4); null for
 * anything else: a host name, a zone, a mask of 0 that would let every address in.
 */
export function accessRange(input: string): string | null {
  const text = input.trim().toLowerCase()
  const [ip = '', prefix, extra] = text.split('/')
  if (extra !== undefined || ip.includes('%')) return null
  const parsed = bitsOf(ip)
  if (!parsed) return null
  const mappedInput = isIP(ip) === 6 && parsed.v4
  const width = parsed.v4 ? 32 : 128
  if (prefix === undefined) return textOf(parsed.v4, parsed.value)
  if (!/^\d{1,3}$/.test(prefix)) return null
  // A mapped range's mask counts the 96 bits before the IPv4 part.
  const bits = Number(prefix) - (mappedInput ? 96 : 0)
  if (bits < 1 || bits > width) return null
  const mask = ((1n << BigInt(bits)) - 1n) << BigInt(width - bits)
  return `${textOf(parsed.v4, parsed.value & mask)}/${bits}`
}

/** The range "my address" stands for: an IPv4 address itself, an IPv6 one's /64 (it rotates). */
export function ownRange(ip: string): string | null {
  const parsed = bitsOf(ip.split('%')[0]!)
  if (!parsed) return null
  return parsed.v4 ? textOf(true, parsed.value) : accessRange(`${textOf(false, parsed.value)}/64`)
}

function blockListOf(ranges: string[]): BlockList {
  const list = new BlockList()
  for (const range of ranges) {
    const [address, bits] = range.split('/')
    const family = isIP(address!) === 4 ? 'ipv4' : 'ipv6'
    if (bits === undefined) list.addAddress(address!, family)
    else list.addSubnet(address!, Number(bits), family)
  }
  return list
}

/** Whether a list of ranges lets an address in (an empty list lets every one in; no address, none). */
export function rangesAllowing(ranges: string[]): (ip: string | null) => boolean {
  if (ranges.length === 0) return () => true
  const list = blockListOf(ranges)
  return (ip) => {
    const family = ip ? isIP(ip) : 0
    return family !== 0 && list.check(ip!, family === 4 ? 'ipv4' : 'ipv6')
  }
}

/**
 * Panel access (2026-10-30): the addresses the team-mode panel answers, kept in the app's settings.
 * Read again every few seconds, so a list cleared from the command line holds beside a running
 * server. A stored list that no longer reads lets no address in (it fails closed, and says so).
 */
export class AccessList {
  private entries: AccessEntry[] = []
  private ranges: string[] = []
  private list = new BlockList()
  private unreadable = false
  private loadedAt = Number.NEGATIVE_INFINITY

  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number,
    private readonly warn: (message: string) => void = () => {},
  ) {}

  /** The entries in force. */
  current(): AccessEntry[] {
    this.load()
    return this.entries.map((e) => ({ ...e }))
  }

  /** Whether the panel answers the address. */
  allows(ip: string): boolean {
    this.load()
    if (this.unreadable) return false
    if (this.ranges.length === 0) return true
    const family = isIP(ip)
    return family !== 0 && this.list.check(ip, family === 4 ? 'ipv4' : 'ipv6')
  }

  /** Stores a list whose ranges were read with accessRange (the caller's check). */
  set(entries: AccessEntry[]): void {
    new SettingsRepo(this.db, this.now).set(KEY, { entries })
    this.loadedAt = Number.NEGATIVE_INFINITY
    this.load()
  }

  private load(): void {
    const t = this.now()
    if (t - this.loadedAt < ACCESS_RELOAD_MS) return
    this.loadedAt = t
    const settings = new SettingsRepo(this.db, this.now)
    const stored = settings.get(KEY, StoredSchema, null)
    const read = (stored?.entries ?? []).flatMap((e) => {
      const range = accessRange(e.range)
      return range ? [{ range, label: e.label }] : []
    })
    // Nothing of a stored list reads: no address is let in — never every one (it fails closed).
    const broken = settings.has(KEY) && (!stored || (stored.entries.length > 0 && read.length === 0))
    if (broken) {
      if (!this.unreadable)
        this.warn('the panel access list does not read: no address is let in; run mongo-manager access clear')
      this.unreadable = true
      this.entries = []
      this.ranges = []
      return
    }
    if (stored && read.length < stored.entries.length)
      this.warn('entries of the panel access list that do not read are left out')
    this.unreadable = false
    this.entries = read
    this.ranges = read.map((e) => e.range)
    this.list = blockListOf(this.ranges)
  }

  /** Whether the stored list does not read (no address is let in until it is cleared). */
  broken(): boolean {
    this.load()
    return this.unreadable
  }
}
