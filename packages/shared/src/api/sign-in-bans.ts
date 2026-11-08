// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { z } from 'zod'

/**
 * Sign-in bans (2026-10-30): an address that keeps failing or hammering the team-mode sign-in is
 * refused there for a while, longer each time it comes back; an administrator sees the addresses,
 * lifts a ban or blocks an address. IPv6 addresses are held by their /64, as the sign-in throttle
 * holds them.
 */
export const SIGN_IN_BAN_HOURS = [1, 24, 168, 720] as const
export type SignInBanHours = (typeof SIGN_IN_BAN_HOURS)[number]

/** How an address came to be refused: by its own sign-in attempts, or by an administrator. */
export type SignInBanReason = 'sign_in' | 'manual'

export interface SignInBan {
  /**
   * The address as it is held: an IPv4 address, an IPv6 /64 (`2001:db8:1:2::/64`), or an IPv6 /48
   * banned as a whole (`2001:db8:1::/48`).
   */
  address: string
  reason: SignInBanReason
  /** How many times the address was banned lately (each ban lasts longer). */
  strikes: number
  bannedAt: number
  until: number
  /** The administrator who blocked it, for a manual ban. */
  by: string | null
}

export interface SignInBans {
  /** The bans in force, the one ending last first — at most 500 of them. */
  bans: SignInBan[]
  /** How many are in force in all. */
  total: number
  /** The rule a ban follows: failures in the window, and how long each strike lasts (minutes). */
  rule: { failures: number; windowMinutes: number; stepsMinutes: number[] }
}

export const SignInBanBlockSchema = z.strictObject({
  address: z.string().trim().min(2).max(64),
  hours: z.literal(SIGN_IN_BAN_HOURS),
})
export type SignInBanBlock = z.infer<typeof SignInBanBlockSchema>

/** Lifting a ban lets the address try again: it asks for the administrator's password. */
export const SignInBanLiftSchema = z.strictObject({
  address: z.string().trim().min(2).max(64),
  password: z.string().max(1024).optional(),
})
export type SignInBanLift = z.infer<typeof SignInBanLiftSchema>
