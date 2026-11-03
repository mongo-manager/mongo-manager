import type { PersonalRule } from '@mongo-manager/shared/browser'
import { api, path } from './client'

export const personalFieldKeys = {
  rules: (id: string) => ['connections', id, 'personal-fields'] as const,
  applied: (id: string, db: string, coll: string) =>
    ['connections', id, 'personal-fields', 'applied', db, coll] as const,
  /** User report 2026-10-27: whether values are hidden where a tab is (a bucket's apart). */
  reach: (w: { connectionId: string; db: string; coll: string; bucket: string }) =>
    ['connections', w.connectionId, 'personal-fields', 'applied', w.db, w.coll, 'reach', w.bucket] as const,
}

/** Phase 3b spec §2.1: the connection's personal-field rules (connection admins). */
export const personalFieldsApi = {
  /** `hiddenFromMe`: team mode only — whether I said to hide what the rules name from me too. */
  get: (id: string) =>
    api.get<{ rules: PersonalRule[]; hiddenFromMe?: boolean }>(path`connections/${id}/personal-fields`),
  /** User request 2026-10-24: an administrator hides (or shows again) what the rules name, for themselves. */
  setHiddenFromMe: (id: string, hidden: boolean) =>
    api.put<{ hidden: boolean }>(path`connections/${id}/personal-fields/self`, { hidden }),
  /**
   * Phase 3c §7: the rules that hide values from the caller (names only; empty for others), and the
   * paths hidden in one namespace, resolved through views by the server (final review M4).
   */
  applied: (id: string, db: string, coll: string, bucket = '') => {
    // W5: a database or deployment watch names no collection (or database): only what is named is sent.
    const query = new URLSearchParams()
    if (db) query.set('db', db)
    if (coll) query.set('coll', coll)
    if (db && bucket) query.set('bucket', bucket)
    const search = query.toString() ? `?${query.toString()}` : ''
    // `reaches` (user report 2026-10-27): whether values are hidden from the caller there.
    return api.get<{ rules: PersonalRule[]; patterns?: string[][]; reaches?: boolean }>(
      `${path`connections/${id}/personal-fields/applied`}${search}`,
    )
  },
  /** The rules as they are to be, made on `base` (what was read): 409 when they changed meanwhile. */
  set: (id: string, rules: PersonalRule[], base?: PersonalRule[]) =>
    api.put<{ rules: PersonalRule[] }>(path`connections/${id}/personal-fields`, {
      rules,
      ...(base ? { base } : {}),
    }),
}
