// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { useI18n } from 'vue-i18n'
import { LEGACY_AUDIT_ACTIONS } from '@mongo-manager/shared/browser'

/**
 * Audit action labels (2026-10-28): an action's message key — its group, then the rest of its code
 * (`auth.totp.disable` → `audit.actions.auth.totp_disable`): no action's key is another's parent.
 */
export function auditActionKey(action: string): string {
  const dot = action.indexOf('.')
  return dot < 1
    ? `audit.actions.${action}`
    : `audit.actions.${action.slice(0, dot)}.${action.slice(dot + 1).replaceAll('.', '_')}`
}
export const auditGroupKey = (group: string) => `audit.groups.${group}`

/** Final review: the action an older version's code stands for now; any other, as it is. */
export const currentAuditAction = (code: string): string =>
  Object.hasOwn(LEGACY_AUDIT_ACTIONS, code) ? LEGACY_AUDIT_ACTIONS[code]! : code

/**
 * What an action and a group of actions are called, in the user's language (in English when that
 * language has no words for it yet). One with no words at all (a row changed outside the app) is its
 * code, as it is: `known` says which.
 */
export function useAuditWords() {
  const { t, te } = useI18n()
  // `te` with no locale looks down the fallback chain (vue-i18n 11), as `t` does.
  const say = (code: string, key: string) =>
    te(key) ? { text: t(key), known: true } : { text: code, known: false }
  return {
    action: (code: string) => say(code, auditActionKey(currentAuditAction(code))),
    group: (code: string) => say(code, auditGroupKey(code)),
  }
}
