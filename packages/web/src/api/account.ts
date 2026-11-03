import type { startRegistration } from '@simplewebauthn/browser'
import type {
  AccessEntry,
  AccessPolicy,
  AccessPreview,
  Role,
  SessionIdleMinutes,
  SessionPolicy,
  SignInBanHours,
  SignInBans,
} from '@mongo-manager/shared'
import { api, path, apiHref } from './client'

export interface PasskeyInfo {
  id: string
  name: string
  createdAt: number
  lastUsedAt: number | null
}
export interface PasskeySupport {
  available: boolean
  reason?: 'ip-address' | 'insecure-context'
  message?: string
}
export interface UserInfo {
  id: string
  username: string
  role: Role
  totpEnabled: boolean
  /** Phase 4c §5: an authenticator app or a passkey. */
  twoFactor?: boolean
  /** Required 2FA (2026-10-28): an administrator requires 2FA of this user (older servers: absent). */
  requireTwoFactor?: boolean
  disabled: boolean
  createdAt: number
  passwordChangedAt: number
}
export interface AuditEntry {
  id: number
  at: number
  userId: string | null
  username: string | null
  ip: string | null
  action: string
  connectionId: string | null
  namespace: string | null
  outcome: 'success' | 'denied' | 'failure'
  details: unknown
}
export interface AuditFilter {
  limit?: number
  beforeId?: number
  action?: string
  userId?: string
  connectionId?: string
  /** ISO 8601 instants, inclusive. */
  from?: string
  to?: string
  /** Design 2026-10-25 (B6): one assistant turn's entries. */
  run?: string
}
export type GrantRole = Role | 'none'
export interface Grant {
  userId: string
  role: GrantRole
  /** Phase 3a-1: whether this user may open the advanced shell on the connection. */
  shell?: boolean
  /** Phase 3b: this user may not see the connection's personal data. */
  masked?: boolean
  /** Phase 3d-1: a viewer may export files from the connection. */
  export?: boolean
}

type CreationOptions = Parameters<typeof startRegistration>[0]['optionsJSON']

export const accountKeys = {
  passkeys: ['account', 'passkeys'] as const,
  passkeySupport: ['account', 'passkeySupport'] as const,
  users: ['users'] as const,
  audit: (filter: AuditFilter) => ['audit', filter] as const,
  grants: (connectionId: string) => ['connections', connectionId, 'grants'] as const,
  // Phase 4c.
  auditSettings: ['audit', 'settings'] as const,
  auditIntegrity: ['audit', 'integrity'] as const,
  policy: ['users', 'policy'] as const,
  sessionPolicy: ['users', 'session-policy'] as const,
  bans: ['users', 'bans'] as const,
  access: ['users', 'access'] as const,
  activity: (days: number) => ['users', 'activity', days] as const,
}

export const accountApi = {
  changePassword: (currentPassword: string, newPassword: string) =>
    api.post<{ csrfToken: string }>('auth/password', { currentPassword, newPassword }),
  totpEnroll: (password: string) =>
    api.post<{ secret: string; otpauthUri: string }>('auth/totp/enroll', { password }),
  totpConfirm: (code: string) => api.post<{ recoveryCodes?: string[] }>('auth/totp/confirm', { code }),
  totpDisable: (password: string, code: string) => api.post<void>('auth/totp/disable', { password, code }),
  regenerateRecoveryCodes: (password: string) =>
    api.post<{ recoveryCodes: string[] }>('auth/recovery-codes', { password }),
  passkeySupport: () => api.get<PasskeySupport>('auth/passkeys/support'),
  passkeys: () => api.get<PasskeyInfo[]>('auth/passkeys'),
  passkeyOptions: (password: string) => api.post<CreationOptions>('auth/passkeys/options', { password }),
  addPasskey: (name: string, response: unknown) =>
    api.post<{ passkey: PasskeyInfo; recoveryCodes?: string[] }>('auth/passkeys', { name, response }),
  renamePasskey: (id: string, name: string) => api.patch<PasskeyInfo>(path`auth/passkeys/${id}`, { name }),
  deletePasskey: (id: string, password: string) => api.delete<void>(path`auth/passkeys/${id}`, { password }),
}

export const usersApi = {
  list: () => api.get<UserInfo[]>('users'),
  /**
   * Security audit 2026-10-16: changes that hand out a lasting way in (a new account, a role, another
   * account's password or second factors) are confirmed with the administrator's own password.
   */
  create: (
    username: string,
    password: string,
    role: Role,
    currentPassword: string,
    requireTwoFactor = false,
  ) => api.post<UserInfo>('users', { username, password, role, requireTwoFactor, currentPassword }),
  update: (
    id: string,
    patch: { role?: Role; disabled?: boolean; requireTwoFactor?: boolean; currentPassword?: string },
  ) => api.patch<UserInfo>(path`users/${id}`, patch),
  resetPassword: (id: string, password: string, currentPassword: string) =>
    api.post<void>(path`users/${id}/password`, { password, currentPassword }),
  reset2fa: (id: string, currentPassword: string) =>
    api.post<void>(path`users/${id}/reset-2fa`, { currentPassword }),
  remove: (id: string) => api.delete<void>(path`users/${id}`),
  /** Phase 4c §4: administrators must have 2FA. */
  policy: () => api.get<AdminPolicy>('users/policy'),
  /** Turning a requirement off asks the administrator's password (4c review I4). */
  setPolicy: (change: { adminTwoFactor?: boolean; everyoneTwoFactor?: boolean }, password?: string) =>
    api.put<AdminPolicy>('users/policy', { ...change, ...(password ? { password } : {}) }),
  /** Session lifetime (2026-10-29): a longer idle time asks the administrator's password. */
  sessionPolicy: () => api.get<SessionPolicy>('users/session-policy'),
  setSessionPolicy: (idleMinutes: SessionIdleMinutes, password?: string) =>
    api.put<SessionPolicy>('users/session-policy', { idleMinutes, ...(password ? { password } : {}) }),
  /** Sign-in bans (2026-10-30): blocking tightens the sign-in; lifting asks the administrator's password. */
  bans: () => api.get<SignInBans>('users/bans'),
  blockAddress: (address: string, hours: SignInBanHours) =>
    api.post<SignInBans>('users/bans', { address, hours }),
  liftBan: (address: string, password: string) =>
    api.post<SignInBans>('users/bans/lift', { address, password }),
  /** Panel access (2026-10-30): the addresses the panel answers; saving asks the password. */
  access: () => api.get<AccessPolicy>('users/access'),
  previewAccess: (entries: AccessEntry[]) => api.post<AccessPreview>('users/access/preview', { entries }),
  saveAccess: (entries: AccessEntry[], password: string, lockMeOut: boolean) =>
    api.put<AccessPolicy>('users/access', { entries, password, ...(lockMeOut ? { lockMeOut } : {}) }),
  /** Phase 4c §3: each user's activity over the last days. */
  activity: (days: 7 | 30 | 90) => api.get<UserActivity[]>(`users/activity?days=${days}`),
}

export interface AdminPolicy {
  adminTwoFactor: boolean
  /** Required by the server's configuration: not to be turned off in the app. */
  forced: boolean
  /** Required 2FA (2026-10-28): every user must have 2FA (older servers: absent). */
  everyoneTwoFactor?: boolean
  everyoneForced?: boolean
}

/** Whether a user must have 2FA, by their own flag or the policy. */
export function twoFactorRequiredOf(
  user: { role: Role; requireTwoFactor?: boolean },
  policy: AdminPolicy | undefined,
): boolean {
  return (
    !!user.requireTwoFactor ||
    !!policy?.everyoneTwoFactor ||
    (user.role === 'admin' && !!policy?.adminTwoFactor)
  )
}
export interface UserActivity {
  userId: string
  username: string
  role: Role
  disabled: boolean
  lastSignInAt: number | null
  signIns: number
  failedSignIns: number
  actions: number
  denied: number
  lastActivityAt: number | null
  groups: Array<{ group: string; count: number }>
}
export interface AuditRetention {
  /** Null: kept for ever. */
  days: number | null
  /** When the days take effect (fewer days wait a day: 4c review I4). */
  effectiveAt: number | null
  /** Asked with `preview`: how many entries those days would remove. */
  wouldRemove?: number
}

export const auditApi = {
  list: (filter: AuditFilter) => {
    const query = new URLSearchParams()
    for (const [key, value] of Object.entries(filter))
      if (value !== undefined && value !== '') query.set(key, String(value))
    const qs = query.toString()
    return api.get<AuditEntry[]>(qs ? `audit?${qs}` : 'audit')
  },
  /** Phase 4c §1: a link exporting every entry the filters match (no page, no limit). */
  exportHref: (filter: Omit<AuditFilter, 'limit' | 'beforeId'>, format: 'csv' | 'ndjson') => {
    const query = new URLSearchParams({ format })
    for (const [key, value] of Object.entries(filter))
      if (value !== undefined && value !== '' && key !== 'limit' && key !== 'beforeId')
        query.set(key, String(value))
    return apiHref(`audit/export?${query}`)
  },
  /** Phase 4c §2: how long entries are kept. */
  settings: (preview?: number) =>
    api.get<AuditRetention>(preview ? `audit/settings?preview=${preview}` : 'audit/settings'),
  /** Fewer days ask the administrator's password (team mode). */
  saveSettings: (days: number | null, password?: string) =>
    api.put<AuditRetention>('audit/settings', { days, ...(password ? { password } : {}) }),
  /** Security audit 2026-10-16: whether the log's chain checks, and where it broke first. */
  integrity: () => api.get<AuditIntegrity>('audit/integrity'),
}

export interface AuditIntegrity {
  ok: boolean
  brokenAt: { id: number; at: number } | null
  /** Entries from before the chain existed. */
  legacy: number
}

export const grantsApi = {
  list: (connectionId: string) => api.get<Grant[]>(path`connections/${connectionId}/grants`),
  set: (
    connectionId: string,
    userId: string,
    role: GrantRole | null,
    flags: { shell?: boolean; masked?: boolean; export?: boolean } = {},
  ) => api.put<void>(path`connections/${connectionId}/grants/${userId}`, { role, ...flags }),
}
