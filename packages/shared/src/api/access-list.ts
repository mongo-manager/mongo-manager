import { z } from 'zod'

/**
 * Panel access (2026-10-30): the addresses the team-mode panel answers, as an administrator sets
 * them in the app — no reverse proxy needed. An empty list lets every address in. Saving signs out
 * every session from an address outside it; the panel refuses any other address from then on.
 */
export const ACCESS_LIST_MAX = 100

export interface AccessEntry {
  /** An IPv4 or IPv6 address, or a range in CIDR form (`203.0.113.0/24`, `2001:db8::/48`). */
  range: string
  /** What it is, for the administrator (an office, a VPN). */
  label: string
}

export const AccessEntrySchema = z.strictObject({
  range: z.string().trim().min(2).max(64),
  // No control characters: a label is printed on a terminal by the command line too.
  label: z
    .string()
    .trim()
    .max(60)
    .regex(/^\P{Cc}*$/u),
})

export const AccessPreviewSchema = z.strictObject({
  entries: z.array(AccessEntrySchema).max(ACCESS_LIST_MAX),
})

/**
 * Saving asks for the administrator's password (and a recent second factor). A list without the
 * address they are on is refused unless `lockMeOut` says they meant it.
 */
export const AccessSaveSchema = z.strictObject({
  entries: z.array(AccessEntrySchema).max(ACCESS_LIST_MAX),
  password: z.string().max(1024).optional(),
  lockMeOut: z.boolean().optional(),
})
export type AccessSave = z.infer<typeof AccessSaveSchema>

/** A signed-in session as an administrator sees it. */
export interface AccessSession {
  username: string
  /** The address it signed in from (null for one from before addresses were kept). */
  ip: string | null
  userAgent: string | null
  createdAt: number
  lastSeenAt: number
  /** The administrator's own session. */
  current: boolean
  /** Whether the list (in force, or the one previewed) lets its address in. */
  allowed: boolean
}

export interface AccessPolicy {
  entries: AccessEntry[]
  /** The address the administrator's request came from, as the server sees it. */
  yourAddress: string
  /**
   * What "my address" adds: the address itself, or for IPv6 its /64 — a device's IPv6 address
   * changes often within it (privacy addresses).
   */
  yourRange: string
  /** Whether the list lets that address in. */
  youAllowed: boolean
  /**
   * The request came through a proxy that is not named as trusted (it sent X-Forwarded-For): every
   * request then looks like the proxy's, and a list cannot tell people apart.
   */
  untrustedProxy: boolean
  sessions: AccessSession[]
}

/** A preview of a list not saved yet: the same, or which entry does not read. */
export type AccessPreview = AccessPolicy & { invalid: number[] }
