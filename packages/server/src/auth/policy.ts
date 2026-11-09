// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { z } from 'zod'
import { SettingsRepo } from '../store/settings'
import { transaction } from '../store/db'
import { Errors } from '../errors'
import type { Principal, ServerContext } from '../http/context'

const KEY = 'auth.adminTwoFactor'
/** Required 2FA (2026-10-28): its own setting, so a stored admin policy stays valid as it was. */
const EVERYONE_KEY = 'auth.everyoneTwoFactor'
const PolicySchema = z.strictObject({ required: z.boolean() })

export interface TwoFactorPolicy {
  adminTwoFactor: boolean
  forced: boolean
  everyoneTwoFactor: boolean
  everyoneForced: boolean
}

/**
 * Phase 4c §4 (spec §5 S3): administrators must have 2FA — by configuration (MM_REQUIRE_ADMIN_2FA,
 * then not to be turned off in the app) or by an administrator's setting. Required 2FA (2026-10-28):
 * everyone must, the same way (MM_REQUIRE_2FA).
 */
export function twoFactorPolicy(ctx: ServerContext): TwoFactorPolicy {
  // Required 2FA final review (minor 4): read on every request and socket check, so kept until
  // changed (only setTwoFactorPolicy writes these settings).
  const kept = POLICIES.get(ctx)
  if (kept) return { ...kept }
  const settings = new SettingsRepo(ctx.store.db, ctx.now)
  const forced = ctx.config.requireAdmin2fa
  const everyoneForced = ctx.config.requireAll2fa
  const policy = {
    adminTwoFactor: forced || storedRequired(settings, KEY),
    forced,
    everyoneTwoFactor: everyoneForced || storedRequired(settings, EVERYONE_KEY),
    everyoneForced,
  }
  POLICIES.set(ctx, policy)
  return { ...policy }
}

const POLICIES = new WeakMap<ServerContext, TwoFactorPolicy>()

/** Required 2FA final review (minor 5): a stored rule that no longer reads counts as on, never off. */
function storedRequired(settings: SettingsRepo, key: string): boolean {
  return settings.get(key, PolicySchema, { required: settings.has(key) }).required
}

export function setTwoFactorPolicy(
  ctx: ServerContext,
  change: { adminTwoFactor?: boolean; everyoneTwoFactor?: boolean },
): void {
  const settings = new SettingsRepo(ctx.store.db, ctx.now)
  transaction(ctx.store.db, () => {
    if (change.adminTwoFactor !== undefined) settings.set(KEY, { required: change.adminTwoFactor })
    if (change.everyoneTwoFactor !== undefined)
      settings.set(EVERYONE_KEY, { required: change.everyoneTwoFactor })
  })
  // Read afresh from now on.
  POLICIES.delete(ctx)
}

/** An authenticator app or a passkey. */
export function hasTwoFactor(ctx: ServerContext, userId: string): boolean {
  return !!ctx.users.findById(userId)?.totpEnabled || ctx.passkeys.countForUser(userId) > 0
}

const hasFactorOf = (ctx: ServerContext, user: { id: string; totpEnabled: boolean }) =>
  user.totpEnabled || ctx.passkeys.countForUser(user.id) > 0

export type TwoFactorReason = 'everyone' | 'admins' | 'account'

/** Why a user must have 2FA — the broadest reason first — or null when it is up to them. */
export function twoFactorRequiredBy(
  ctx: ServerContext,
  user: { role: string; requireTwoFactor: boolean },
): TwoFactorReason | null {
  const policy = twoFactorPolicy(ctx)
  if (policy.everyoneTwoFactor) return 'everyone'
  if (user.role === 'admin' && policy.adminTwoFactor) return 'admins'
  return user.requireTwoFactor ? 'account' : null
}

/** A user who must set 2FA up before anything else, and why; null when they need not. */
export function twoFactorPendingReason(
  ctx: ServerContext,
  principal: Principal | null,
): TwoFactorReason | null {
  if (principal?.kind !== 'user') return null
  const user = ctx.users.findById(principal.userId)
  if (!user) return null
  // The principal's role: the one this request (or socket) acts with.
  const reason = twoFactorRequiredBy(ctx, { role: principal.role, requireTwoFactor: user.requireTwoFactor })
  return reason && !hasFactorOf(ctx, user) ? reason : null
}

/** Required 2FA final review (minor 2): the active users who must set 2FA up now. */
export function pendingUserIds(ctx: ServerContext): string[] {
  return ctx.users
    .list()
    .filter((u) => !u.disabled && twoFactorRequiredBy(ctx, u) !== null && !hasFactorOf(ctx, u))
    .map((u) => u.id)
}

export function twoFactorPending(ctx: ServerContext, principal: Principal | null): boolean {
  return twoFactorPendingReason(ctx, principal) !== null
}

/** While required, a user's last 2FA method stays (`remaining`: the methods left after). */
export function keepsLastFactor(
  ctx: ServerContext,
  user: { role: string; requireTwoFactor: boolean },
  remaining: number,
): boolean {
  return remaining === 0 && twoFactorRequiredBy(ctx, user) !== null
}

/** The refusal to remove a required user's last method. */
export function lastFactorRefusal(ctx: ServerContext, user: { role: string; requireTwoFactor: boolean }) {
  return Errors.conflict(
    twoFactorRequiredBy(ctx, user) === 'admins'
      ? 'Administrators must keep two-factor authentication'
      : 'Two-factor authentication is required for this account',
    { reason: 'last_factor_required' },
  )
}

/**
 * 4c review I1: who may do what changed (2FA became required, a role changed) — the real-time hub
 * checks its open sockets again at once instead of at the next heartbeat.
 */
export class AccessSignal {
  private readonly listeners = new Set<() => void>()
  on(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  changed(): void {
    for (const l of this.listeners) l()
  }
}
