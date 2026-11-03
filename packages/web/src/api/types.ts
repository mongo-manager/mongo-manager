import type { Permission, Role } from '@mongo-manager/shared'

export interface AuthStatus {
  mode: 'local' | 'team'
  setupRequired: boolean
  authenticated: boolean
  /**
   * Security audit 2026-10-16: local mode refused this browser — it has not opened the app from a
   * launch link (the client sets it from the server's refusal).
   */
  launchRequired?: boolean
}

export type SecondFactorMethod = 'totp' | 'passkey' | 'recovery'

export interface Me {
  mode: 'local' | 'team'
  user: { id: string; username: string; role: Role }
  permissions: Permission[]
  csrfToken: string
  readOnly: boolean
  twoFactor: { enabled: boolean; totp: boolean; passkeys: number; recoveryCodesRemaining: number }
  /** Phase 4c §4: an administrator who must set 2FA up before anything else. */
  twoFactorRequired?: boolean
  /** Required 2FA (2026-10-28): why the set-up is required (older servers: absent). */
  twoFactorRequiredBy?: 'everyone' | 'admins' | 'account'
}

export type LoginResult =
  | { user: Me['user']; csrfToken: string }
  | { mfaRequired: true; ticket: string; methods: SecondFactorMethod[] }
