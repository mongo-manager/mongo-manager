// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { findServerJs, permissionsFor, type LiveSyncReason, type Permission } from '@mongo-manager/shared'
import type { ServerContext } from '../http/context'
import { effectiveRole, isRestricted, mayExport } from '../connections/access'
import { ownerPrincipal } from '../backup/schedules/policy'
import { compileRules } from '../masking/match'
import { bucketRuled } from '../masking/gridfs'
import { serverError } from '../data/mongo-errors'
import { settingsStamp, TARGET_NEEDS } from './plan'
import type { LiveSyncRecord } from './repo'
import type { CheckResult } from './worker'

/**
 * Phase 3e-2 spec §3.1–§3.2, S2, S3, S9: everything a sync needs, read as its owner now, before every
 * batch. Nothing is read or written when one fails.
 */
export function checkSync(ctx: ServerContext, r: LiveSyncRecord): CheckResult {
  const attention = (reason: LiveSyncReason, detail?: string): CheckResult => ({
    ok: false,
    state: 'attention',
    reason,
    ...(detail ? { detail } : {}),
  })
  const source = ctx.connections.get(r.source.connectionId)
  const target = ctx.connections.get(r.target.connectionId)
  if (!source || !target) return { ok: false, state: 'stopped', reason: 'connection_deleted' }
  if (!ctx.config.liveSync.enabled) return attention('turned_off')
  const principal = ownerPrincipal(ctx, r.owner)
  if (!principal) return attention('owner_access', 'account')
  const sourceRole = effectiveRole(ctx, principal, source.id)
  if (
    !sourceRole ||
    !permissionsFor(sourceRole).has('documents:read') ||
    !mayExport(ctx, principal, source.id)
  )
    return attention('owner_access', 'source')
  const targetRole = effectiveRole(ctx, principal, target.id)
  const can = targetRole ? permissionsFor(targetRole) : new Set<Permission>()
  if (!TARGET_NEEDS.every((p) => can.has(p))) return attention('owner_access', 'target')
  if (
    settingsStamp(source.settings) !== r.stamps.settings.source ||
    settingsStamp(target.settings) !== r.stamps.settings.target
  )
    return attention('connection_changed')
  if (ctx.config.readOnly || target.readOnly) return attention('read_only')
  // W4 review (minor): a filter is judged again by the server's setting (it may have been turned off).
  if (r.options.filter && !ctx.config.allowServerJs && findServerJs(r.options.filter) !== null)
    return attention('filter_refused')
  const rules = ctx.personalFields.get(source.id)
  const targetRules = ctx.personalFields.get(target.id)
  if (rules.version !== r.stamps.versions.source || targetRules.version !== r.stamps.versions.target)
    return attention('rules_changed')
  // Restricted since the start: an unmasked sync would now carry what its owner may not see.
  if (!r.options.masked && isRestricted(ctx, principal, source.id)) return attention('owner_access', 'masked')
  const targetRestricted = isRestricted(ctx, principal, target.id)
  const targetCompiled = compileRules(targetRules.rules)
  if (targetRestricted && targetCompiled.anyInDb(r.target.db))
    return attention('owner_access', 'personal_target')
  // Final review of the agent's gate (next round, M-A) had a bucket withheld for an owner restricted
  // on the target wherever rules were there. User report 2026-10-27: only a bucket a rule reaches
  // holds personal data — and a rule reaching the target database stops the sync above
  // (personal_target), so on the target nothing is left to withhold.
  const masker = r.options.masked ? compileRules(rules.rules) : null
  return {
    ok: true,
    // Security audit 2026-10-16 (Important 4): file contents cannot be masked (as the plan's gridfs_masked);
    // nor checked against the target's rules for an owner restricted there, as the plan refuses a
    // bucket for one (review of the agent's gate, M-1).
    // User report 2026-10-27: the source buckets a rule reaches.
    withholdFiles: (db, coll) => bucketRuled(masker, db, coll),
    maskFor: (db, coll) => {
      if (!masker) return null
      const patterns = masker.forNs(db, coll).patterns
      return patterns.length ? patterns.map((p) => [...p]) : null
    },
  }
}

/** Spec §3.3: MongoDB's text, or its code alone for an owner restricted on the side that raised it. */
export function errorTextFor(
  ctx: ServerContext,
  r: LiveSyncRecord,
  /** 'either': an error that may come from both sides (verify): restricted on either hides it. */
  side: 'source' | 'target' | 'either',
  e: unknown,
): string {
  // The server's own words and code, from under the driver's wrapper (independent review, Minor 5).
  const err = (serverError(e) ?? {}) as { code?: unknown; errmsg?: unknown; message?: unknown }
  const code = err.code === undefined ? '' : `code ${String(err.code)}`
  const principal = ownerPrincipal(ctx, r.owner)
  const sides =
    side === 'either'
      ? [r.source.connectionId, r.target.connectionId]
      : [side === 'source' ? r.source.connectionId : r.target.connectionId]
  if (!principal || sides.some((id) => isRestricted(ctx, principal, id))) return code || 'error'
  const text = String(err.errmsg ?? err.message ?? '').slice(0, 300)
  return code ? `${text} (${code})` : text
}
