import { z } from 'zod'

/**
 * Session lifetime (2026-10-29): how long a team-mode session lasts without a request, in minutes,
 * as an administrator chooses it. Every session ends 12 hours after its sign-in whatever is chosen.
 */
export const SESSION_IDLE_CHOICES = [15, 30, 60, 240, 480] as const
export type SessionIdleMinutes = (typeof SESSION_IDLE_CHOICES)[number]
export const DEFAULT_SESSION_IDLE_MINUTES: SessionIdleMinutes = 30

export const SessionIdleMinutesSchema = z.literal(SESSION_IDLE_CHOICES)

/** A longer time than in force asks for the administrator's password (and a recent second factor). */
export const SessionPolicyBodySchema = z.strictObject({
  idleMinutes: SessionIdleMinutesSchema,
  password: z.string().max(1024).optional(),
})
export type SessionPolicyBody = z.infer<typeof SessionPolicyBodySchema>

export interface SessionPolicy {
  idleMinutes: SessionIdleMinutes
  /** Every session ends this long after its sign-in, whatever the idle time. */
  absoluteMinutes: number
}
