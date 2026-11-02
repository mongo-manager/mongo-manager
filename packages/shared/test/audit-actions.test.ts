import { describe, expect, it } from 'vitest'
import {
  ALL_AUDIT_ACTIONS,
  AUDIT_ACTIONS,
  LEGACY_AUDIT_ACTIONS,
  LIVE_SYNC_AUDITED_STATES,
  LIVE_SYNC_STATES,
} from '../src/browser'

/** Audit action labels (2026-10-28): the actions the audit log holds. */
describe('the audit actions', () => {
  it('are each listed once, as a group and a name', () => {
    expect(new Set(ALL_AUDIT_ACTIONS).size).toBe(ALL_AUDIT_ACTIONS.length)
    for (const a of ALL_AUDIT_ACTIONS) expect(a).toMatch(/^[a-zA-Z]+\.[a-zA-Z0-9_.]+$/)
  })

  it('hold the live sync states a sync is audited under, and only those', () => {
    for (const s of LIVE_SYNC_AUDITED_STATES) expect(LIVE_SYNC_STATES).toContain(s)
    const livesync = ALL_AUDIT_ACTIONS.filter(
      (a) => a.startsWith('livesync.') && (LIVE_SYNC_STATES as readonly string[]).includes(a.slice(9)),
    )
    expect(livesync).toEqual(LIVE_SYNC_AUDITED_STATES.map((s) => `livesync.${s}`))
    expect(AUDIT_ACTIONS.every((a) => ALL_AUDIT_ACTIONS.includes(a))).toBe(true)
  })

  it('read an older version’s codes as current actions, never as one of their own', () => {
    for (const [old, now] of Object.entries(LEGACY_AUDIT_ACTIONS)) {
      expect(ALL_AUDIT_ACTIONS).not.toContain(old)
      expect(ALL_AUDIT_ACTIONS).toContain(now)
    }
  })
})
