// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { parseLine } from './parse'

/**
 * Plugins wave 3 (spec §7): a log's lines counted as they are read — slow operations by shape, errors
 * and warnings by message, connections by client, and a timeline — in bounded memory: at most so
 * many shapes, messages, clients, severities, components and time slots, the lines past each cap
 * counted apart (`otherSlow`, `otherMessages`, `otherClients`, `otherSeverities`, `otherComponents`;
 * the time slots made coarser instead); every text kept cut short (the parser bounds each name, so
 * every key is bounded too), a sample of each shape's durations.
 */
export interface SlowGroup {
  ns: string
  op: string
  shape: string
  count: number
  totalMs: number
  meanMs: number
  p95Ms: number
  maxMs: number
  plans: Record<string, number>
  /** Some ran without an index. */
  collscan: boolean
  keysExamined: number
  docsExamined: number
  returned: number
  /** Its first line as written: shown only when the user asks, never sent anywhere. */
  example: string
}
export interface MessageGroup {
  severity: string
  component: string
  id: number | null
  msg: string
  count: number
  first: number | null
  last: number | null
}
export interface Analysis {
  lines: number
  unreadable: number
  /** Lines whose time is before MongoDB or after now: left out of the range and the timeline. */
  outOfRange: number
  first: number | null
  last: number | null
  severities: Record<string, number>
  /** Lines of a severity past the cap (an error, warning or fatal one is never past it). */
  otherSeverities: number
  components: Record<string, number>
  /** Lines of a component past the cap. */
  otherComponents: number
  version?: string
  host?: string
  slow: SlowGroup[]
  /** Every slow line, of the shapes listed and the others. */
  slowLines: number
  /** Slow lines of shapes past the cap: counted, not listed. */
  otherSlow: number
  messages: MessageGroup[]
  otherMessages: number
  connections: {
    opened: number
    ended: number
    peak: number
    clients: Array<{ client: string; opened: number; ended: number; apps: string[] }>
    /** Connection lines of clients past the cap: counted in all, not listed. */
    otherClients: number
  }
  timeline: { bucketMs: number; buckets: Array<{ at: number; lines: number; slow: number }> }
}

const MINUTE = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000
const WEEK = 7 * DAY
const FOUR_WEEKS = 28 * DAY
/**
 * The most bars a timeline draws: a longer log is drawn by the hour, the day, the week, then four
 * weeks (wave 3 second review: past about four years the last bars were lost).
 */
const MAX_BUCKETS = 720
const BUCKETS = [MINUTE, HOUR, DAY, WEEK, FOUR_WEEKS]
/** Durations kept per shape for its p95. */
const SAMPLE = 1000
const EXAMPLE_CHARS = 2000
/** No MongoDB wrote a log before 2009: an earlier time is a broken clock or a broken line. */
const EARLIEST = Date.UTC(2009, 0, 1)
/** How long each kept text may be. */
const CHARS = { ns: 256, op: 64, plan: 200, component: 64, severity: 2, version: 64, host: 256, client: 128 }
const MAX_PLANS = 20

/**
 * A text kept apart from the line it was cut from (wave 3 review): a slice of a line can hold the
 * whole piece of the file it came from in memory.
 */
const own = (s: string, max: number) => (' ' + s.slice(0, max)).slice(1)

/** A small seeded random source (mulberry32): the same log gives the same sample. */
function random(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Group {
  ns: string
  op: string
  shape: string
  count: number
  totalMs: number
  maxMs: number
  durations: number[]
  plans: Map<string, number>
  keysExamined: number
  docsExamined: number
  returned: number
  example: string
}

export interface Limits {
  shapes?: number
  messages?: number
  clients?: number
  severities?: number
  components?: number
  /** Time slots kept before the timeline is counted by the hour, then the day. */
  slots?: number
  /** "Now", for what is after it (tests). */
  now?: number
}

/**
 * Adds one to a count kept in a bounded map; a new key past `max` is not kept, and is told (false).
 * A key of `always` is kept whatever the cap: errors and warnings are never left out by others.
 */
function count(map: Map<string, number>, key: string, max: number, always?: ReadonlySet<string>): boolean {
  const n = map.get(key)
  if (n !== undefined) map.set(key, n + 1)
  else if (map.size < max || always?.has(key)) map.set(key, 1)
  else return false
  return true
}
/** The severities MongoDB writes: always counted. */
const SEVERITIES = new Set(['F', 'E', 'W', 'I', 'D'])

export class Analyzer {
  private lines = 0
  private unreadable = 0
  private outOfRange = 0
  private first: number | null = null
  private last: number | null = null
  private severities = new Map<string, number>()
  private otherSeverities = 0
  private components = new Map<string, number>()
  private otherComponents = 0
  private version?: string
  private host?: string
  private groups = new Map<string, Group>()
  private slowLines = 0
  private otherSlow = 0
  private messages = new Map<string, MessageGroup>()
  private otherMessages = 0
  private opened = 0
  private ended = 0
  private peak = 0
  private clients = new Map<string, { opened: number; ended: number; apps: Set<string> }>()
  private otherClients = 0
  /** Lines by time slot: by the minute until there are too many, then the hour, then the day. */
  private slots = new Map<number, { lines: number; slow: number }>()
  private grain = MINUTE
  private readonly random = random(0x5eed)
  private readonly latest: number

  constructor(private readonly limits: Limits = {}) {
    this.latest = (limits.now ?? Date.now()) + DAY
  }

  /** A line over the reader's cap: counted as one not read. */
  addTooLong(): void {
    this.lines++
    this.unreadable++
  }

  add(raw: string): void {
    this.lines++
    const line = parseLine(raw)
    if (line.kind === 'unreadable') {
      this.unreadable++
      return
    }
    // A time before MongoDB or after now is a broken clock: it would stretch the timeline over years.
    let at = line.at
    if (at !== null && (at < EARLIEST || at > this.latest)) {
      this.outOfRange++
      at = null
    }
    if (at !== null) {
      if (this.first === null || at < this.first) this.first = at
      if (this.last === null || at > this.last) this.last = at
      this.slot(at, line.kind === 'slow')
    }
    if (!count(this.severities, own(line.severity, CHARS.severity), this.limits.severities ?? 16, SEVERITIES))
      this.otherSeverities++
    if (!count(this.components, own(line.component, CHARS.component), this.limits.components ?? 200))
      this.otherComponents++
    switch (line.kind) {
      case 'slow': {
        this.slowLines++
        const key = `${line.ns}\u0000${line.op}\u0000${line.shape}`
        let g = this.groups.get(key)
        if (!g) {
          if (this.groups.size >= (this.limits.shapes ?? 5000)) {
            this.otherSlow++
            return
          }
          g = {
            ns: own(line.ns, CHARS.ns),
            op: own(line.op, CHARS.op),
            shape: own(line.shape, line.shape.length),
            count: 0,
            totalMs: 0,
            maxMs: 0,
            durations: [],
            plans: new Map(),
            keysExamined: 0,
            docsExamined: 0,
            returned: 0,
            example: own(raw, EXAMPLE_CHARS),
          }
          this.groups.set(own(key, key.length), g)
        }
        g.count++
        g.totalMs += line.ms
        g.maxMs = Math.max(g.maxMs, line.ms)
        // A sample of all its durations (reservoir sampling): each line as likely to be in it.
        if (g.durations.length < SAMPLE) g.durations.push(line.ms)
        else {
          const i = Math.floor(this.random() * g.count)
          if (i < SAMPLE) g.durations[i] = line.ms
        }
        if (line.plan) count(g.plans, own(line.plan, CHARS.plan), MAX_PLANS)
        g.keysExamined += line.keysExamined ?? 0
        g.docsExamined += line.docsExamined ?? 0
        g.returned += line.returned ?? 0
        return
      }
      case 'message': {
        const key = `${line.severity}\u0000${line.id ?? line.msg}`
        let m = this.messages.get(key)
        if (!m) {
          if (this.messages.size >= (this.limits.messages ?? 2000)) {
            this.otherMessages++
            return
          }
          m = {
            severity: own(line.severity, CHARS.severity),
            component: own(line.component, CHARS.component),
            id: line.id,
            msg: own(line.msg, line.msg.length),
            count: 0,
            first: at,
            last: at,
          }
          this.messages.set(own(key, key.length), m)
        }
        m.count++
        if (at !== null) {
          if (m.first === null || at < m.first) m.first = at
          if (m.last === null || at > m.last) m.last = at
        }
        return
      }
      case 'connection': {
        const name = own(line.client, CHARS.client)
        let c = this.clients.get(name)
        if (!c && this.clients.size < (this.limits.clients ?? 1000)) {
          c = { opened: 0, ended: 0, apps: new Set() }
          this.clients.set(name, c)
        }
        if (!c) this.otherClients++
        if (line.event === 'opened') {
          this.opened++
          if (c) c.opened++
          if (line.count !== undefined) this.peak = Math.max(this.peak, line.count)
        } else if (line.event === 'ended') {
          this.ended++
          if (c) c.ended++
        } else if (line.app && c && c.apps.size < 20) c.apps.add(own(line.app, 120))
        return
      }
      case 'server':
        if (line.version) this.version = own(line.version, CHARS.version)
        if (line.host) this.host = own(line.host, CHARS.host)
        return
      default:
        return
    }
  }

  /** Counts a line in its time slot; past the cap, the slots are made coarser (a minute, an hour, a day). */
  private slot(at: number, slow: boolean): void {
    const key = Math.floor(at / this.grain) * this.grain
    let s = this.slots.get(key)
    if (!s) {
      s = { lines: 0, slow: 0 }
      this.slots.set(key, s)
    }
    s.lines++
    if (slow) s.slow++
    if (this.slots.size > (this.limits.slots ?? 50_000) && this.grain !== DAY) {
      this.grain = this.grain === MINUTE ? HOUR : DAY
      const old = this.slots
      this.slots = new Map()
      for (const [t, v] of old) {
        const k = Math.floor(t / this.grain) * this.grain
        const into = this.slots.get(k) ?? { lines: 0, slow: 0 }
        into.lines += v.lines
        into.slow += v.slow
        this.slots.set(k, into)
      }
    }
  }

  result(): Analysis {
    const slow = [...this.groups.values()]
      .map((g): SlowGroup => {
        const sorted = [...g.durations].sort((a, b) => a - b)
        const p95 = sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)]! : 0
        return {
          ns: g.ns,
          op: g.op,
          shape: g.shape,
          count: g.count,
          totalMs: g.totalMs,
          meanMs: Math.round(g.totalMs / g.count),
          p95Ms: p95,
          maxMs: g.maxMs,
          plans: Object.fromEntries(g.plans),
          collscan: [...g.plans.keys()].some((p) => p.startsWith('COLLSCAN')),
          keysExamined: g.keysExamined,
          docsExamined: g.docsExamined,
          returned: g.returned,
          example: g.example,
        }
      })
      .sort((a, b) => b.totalMs - a.totalMs)
    const messages = [...this.messages.values()].sort(
      (a, b) => 'FEW'.indexOf(a.severity) - 'FEW'.indexOf(b.severity) || b.count - a.count,
    )
    const clients = [...this.clients.entries()]
      .map(([client, c]) => ({ client, opened: c.opened, ended: c.ended, apps: [...c.apps] }))
      .sort((a, b) => b.opened - a.opened || a.client.localeCompare(b.client))
    return {
      lines: this.lines,
      unreadable: this.unreadable,
      outOfRange: this.outOfRange,
      first: this.first,
      last: this.last,
      severities: Object.fromEntries(this.severities),
      otherSeverities: this.otherSeverities,
      components: Object.fromEntries(this.components),
      otherComponents: this.otherComponents,
      ...(this.version ? { version: this.version } : {}),
      ...(this.host ? { host: this.host } : {}),
      slow,
      slowLines: this.slowLines,
      otherSlow: this.otherSlow,
      messages,
      otherMessages: this.otherMessages,
      connections: {
        opened: this.opened,
        ended: this.ended,
        peak: this.peak,
        clients,
        otherClients: this.otherClients,
      },
      timeline: this.timeline(),
    }
  }

  private timeline(): Analysis['timeline'] {
    if (this.first === null || this.last === null) return { bucketMs: MINUTE, buckets: [] }
    const span = this.last - this.first
    // The finest bar that draws the whole log in so many; past four weeks, as many four weeks as it
    // takes (a log's times are bounded, so this is a guard).
    const chosen =
      BUCKETS.find((b) => span / b <= MAX_BUCKETS) ?? Math.ceil(span / MAX_BUCKETS / FOUR_WEEKS) * FOUR_WEEKS
    // Never finer than the slots were kept in.
    const bucketMs = Math.max(chosen, this.grain)
    const start = Math.floor(this.first / bucketMs) * bucketMs
    const end = Math.floor(this.last / bucketMs) * bucketMs
    const buckets: Array<{ at: number; lines: number; slow: number }> = []
    for (let at = start; at <= end && buckets.length <= MAX_BUCKETS + 1; at += bucketMs)
      buckets.push({ at, lines: 0, slow: 0 })
    for (const [slot, b] of this.slots) {
      const i = Math.floor((Math.floor(slot / bucketMs) * bucketMs - start) / bucketMs)
      const bucket = buckets[i]
      if (!bucket) continue
      bucket.lines += b.lines
      bucket.slow += b.slow
    }
    return { bucketMs, buckets }
  }
}

/** A CSV cell: quoted where it holds a comma, a quote or a line break; a formula never starts it. */
const cell = (v: string | number) => {
  let s = String(v)
  if (/^[=+\-@\t\r]/.test(s) && typeof v === 'string') s = `'${s}`
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** The slow shapes as CSV rows, the header first, each ending with its line break. */
function slowRows(a: Analysis): string[] {
  const head =
    'namespace,operation,shape,count,total_ms,mean_ms,p95_ms,max_ms,plans,keys_examined,docs_examined,returned'
  const rows = a.slow.map((g) =>
    [
      g.ns,
      g.op,
      g.shape,
      g.count,
      g.totalMs,
      g.meanMs,
      g.p95Ms,
      g.maxMs,
      Object.keys(g.plans).join(' | '),
      g.keysExamined,
      g.docsExamined,
      g.returned,
    ]
      .map(cell)
      .join(','),
  )
  return [head, ...rows].map((row) => `${row}\n`)
}

/** The slow shapes as CSV, the slowest first. */
export const slowCsv = (a: Analysis): string => slowRows(a).join('')

/** The longest text the app saves for a plugin (its `ui.download`). */
export const CSV_MAX_CHARS = 1_000_000
/**
 * The longest file asked to be saved, as the app measures the message (1 MiB of JSON, every quote
 * counted twice), with room for the rest of the message.
 */
export const CSV_MAX_MESSAGE_BYTES = 1024 * 1024 - 4096
const bytes = (s: string) => new TextEncoder().encode(s).length

/**
 * Wave 3 second review: the slow shapes as a CSV the app takes — cut at a whole row, the slowest
 * kept, within its limits; how many rows were left out is told.
 */
export function slowCsvFile(a: Analysis, name: string): { text: string; left: number } {
  const [head, ...rows] = slowRows(a)
  let chars = head!.length
  let size = bytes(JSON.stringify({ name, type: 'csv', text: head }))
  const kept = [head!]
  for (const row of rows) {
    // A row's share of the message: its text as JSON, without the quotes around it.
    const more = bytes(JSON.stringify(row)) - 2
    if (chars + row.length > CSV_MAX_CHARS || size + more > CSV_MAX_MESSAGE_BYTES) break
    kept.push(row)
    chars += row.length
    size += more
  }
  return { text: kept.join(''), left: rows.length - (kept.length - 1) }
}
