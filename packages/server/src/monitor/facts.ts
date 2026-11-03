import type { Document, MongoClient } from 'mongodb'
import type { ServerFacts } from '@mongo-manager/shared'
import { LENIENT, toAppError } from '../data/mongo-errors'
import { redactUris } from '../connections/errors'
import { STATUS_WITHOUT_METRICS } from './hub'

const MAX_WARNINGS = 10
const MAX_WARNING_CHARS = 200
const HIDDEN = '…'

/**
 * What names a place in a message, hidden: connection strings and other URLs, Windows, UNC and Unix
 * paths, IPv4 and IPv6 addresses (bracketed with a port too), a host with a port, a dotted host name,
 * an underscored name (a container's). Over-hiding is the safe side (a version number, a setting's
 * dotted name may go too).
 */
const PLACES: RegExp[] = [
  /\\\\[^\s'"<>]+/g,
  /\b[a-z]:\\[^\s'"<>]*/gi,
  // A Unix path after any sign or space (not inside a word), and what follows a URL's scheme ("https:"
  // is kept, "//host/path?query" is not).
  /(?<![\w.])\/[^\s'"),\]}>|;]+/g,
  /\[[0-9a-f:.]*\](?::\d+)?/gi,
  /\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g,
  /(?<![\w:])(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}(?![\w:])/gi,
  /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*:\d{2,5}\b/gi,
  /\b(?=[\w.-]*[a-z])[a-z0-9-]+(?:\.[a-z0-9-]+)+\b/gi,
  /\b[a-z0-9-]+(?:_[a-z0-9-]+)+\b/gi,
]

function hidePlaces(text: string, known: string[]): string {
  let out = redactUris(text)
  for (const name of known) if (name) out = out.split(name).join(HIDDEN)
  for (const place of PLACES) out = out.replace(place, HIDDEN)
  return out
}

/**
 * Widgets wave 2 (2026-10-27): a start-up warning as it may be shown — a structured log line's message
 * alone (never its attributes, which hold paths and hosts), an older server's text line with every
 * place in it hidden; cut to size. Null for an empty line.
 */
export function warningText(line: unknown, known: string[] = []): string | null {
  if (typeof line !== 'string') return null
  let text = line
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    // A text line (before MongoDB 4.4's structured log).
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    // A structured line is its message alone; one without a message shows nothing (never its attr).
    const msg = (parsed as Document).msg
    if (typeof msg !== 'string') return null
    text = msg
  }
  const shown = hidePlaces(text, known).replace(/\s+/g, ' ').trim()
  if (!shown) return null
  return shown.length > MAX_WARNING_CHARS ? `${shown.slice(0, MAX_WARNING_CHARS)}…` : shown
}

const text = (v: unknown, max: number): string | null => (typeof v === 'string' && v ? v.slice(0, max) : null)
const count = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : NaN
  return Number.isFinite(n) && n >= 0 ? n : null
}

/** MongoDB refused the command (the account lacks the right), as against not answering at all. */
const refusal = (e: unknown) => {
  const code = (e as { code?: unknown }).code
  return code === 13 || code === 18
}

/**
 * A server's facts and start-up warnings (mongosh's banner). Each command alone: one MongoDB refuses
 * leaves its facts null and is named; one lost on the way leaves its facts null. A server that could
 * not be read at all is an error (review of wave 2, M3). hostInfo's host name is read only to be
 * hidden from warnings.
 */
export async function gatherFacts(client: MongoClient): Promise<ServerFacts> {
  const admin = client.db('admin')
  const lost: unknown[] = []
  const ask = (cmd: Document) =>
    admin.command(cmd, LENIENT).catch((e: unknown) => {
      if (!refusal(e)) lost.push(e)
      return null
    })
  const answers = await Promise.all([
    ask({ buildInfo: 1 }),
    ask({ hostInfo: 1 }),
    ask({ getParameter: 1, featureCompatibilityVersion: 1 }),
    ask({ getLog: 'startupWarnings' }),
    ask(STATUS_WITHOUT_METRICS),
  ])
  if (lost.length === answers.length) throw toAppError(lost[0])
  const [build, host, fcv, log, status] = answers
  const system = (host?.system ?? {}) as Document
  const os = (host?.os ?? null) as Document | null
  const known = [system.hostname, status?.host]
    .filter((h): h is string => typeof h === 'string')
    .flatMap((h) => [h, h.split(':')[0]!])
  const lines = Array.isArray(log?.log) ? (log.log as unknown[]) : null
  const refused: ServerFacts['refused'] = []
  if (!build) refused.push('buildInfo')
  if (!host) refused.push('hostInfo')
  if (!fcv) refused.push('fcv')
  if (!lines) refused.push('warnings')
  if (!status) refused.push('status')
  return {
    version: text(build?.version, 40),
    fcv: text(((fcv?.featureCompatibilityVersion ?? {}) as Document).version, 20),
    storageEngine: text(((status?.storageEngine ?? {}) as Document).name, 40),
    cores: host ? count(system.numCores) : null,
    memoryMb: host ? count(system.memSizeMB) : null,
    os: os ? { type: text(os.type, 60), name: text(os.name, 60) } : null,
    warnings: lines
      ? lines
          .map((l) => warningText(l, known))
          .filter((w): w is string => w !== null)
          .slice(0, MAX_WARNINGS)
      : null,
    refused,
  }
}
