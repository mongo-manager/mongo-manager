// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { ref } from 'vue'
import { defineStore } from 'pinia'
import { startAuthentication } from '@simplewebauthn/browser'
import type { Permission } from '@mongo-manager/shared'
import { ApiError, api, setCsrfToken, setLocalKey } from '@/api/client'
import type { AuthStatus, LoginResult, Me, SecondFactorMethod } from '@/api/types'

const launchRequired = (e: ApiError) =>
  e.status === 401 && (e.details as { reason?: unknown } | undefined)?.reason === 'launch_required'

/** How long one read of the session may take before it gives up (they run one at a time). */
export const READ_TIMEOUT_MS = 15_000

/** The page key of a browser just come from a launch link; null when there is none to claim. */
async function claimLocalKey(signal: AbortSignal): Promise<string | null> {
  try {
    return (await api.post<{ key: string }>('auth/local/claim', undefined, { signal })).key
  } catch {
    return null
  }
}

export const useSessionStore = defineStore('session', () => {
  const status = ref<AuthStatus | null>(null)
  const me = ref<Me | null>(null)
  const mfa = ref<{ ticket: string; methods: SecondFactorMethod[] } | null>(null)
  const ready = ref(false)
  /** Panel access (2026-10-30): the address the panel refused, while it refuses it. */
  const blockedAddress = ref<string | null>(null)

  // 2026-10-17: one read at a time, each after the one before (so each still sees what happened
  // before it was asked, e.g. a sign-in). Two at once on a page come from a launch link both claimed
  // its one-time key; the refused second wrote "not allowed" over the signed-in first.
  let last: Promise<void> = Promise.resolve()
  // How many reads were asked: one overtaken by a later one does not say the session is ready.
  let asked = 0
  function refresh(): Promise<void> {
    const mine = ++asked
    const next = last
      .catch(() => undefined)
      .then(async () => {
        // A read that hangs would hold every one behind it (a sign-in, a sign-out): it gives up.
        const abort = new AbortController()
        const timer = setTimeout(() => abort.abort(), READ_TIMEOUT_MS)
        try {
          await read(abort.signal)
        } finally {
          clearTimeout(timer)
        }
        if (mine === asked) ready.value = true
      })
    last = next
    return next
  }

  async function read(signal: AbortSignal, claimed = false): Promise<void> {
    try {
      status.value = await api.get<AuthStatus>('auth/status', { signal })
    } catch (e) {
      // Security audit 2026-10-16: local mode opens only from a launch link; this browser has none.
      if (!(e instanceof ApiError && launchRequired(e))) throw e
      // Review of the audit fixes (important 1): just come from a link, this page claims its key
      // (once; kept in this origin's storage) and asks again.
      // Once: a key just claimed that the server still refuses is not claimed again and again.
      const key = claimed ? null : await claimLocalKey(signal)
      if (key) {
        setLocalKey(key)
        return read(signal, true)
      }
      status.value = { mode: 'local', setupRequired: false, authenticated: false, launchRequired: true }
    }
    if (status.value.authenticated) {
      me.value = await api.get<Me>('auth/me', { signal })
      setCsrfToken(me.value.csrfToken)
    } else {
      me.value = null
      setCsrfToken(undefined)
    }
  }

  function can(permission: Permission): boolean {
    return me.value?.permissions.includes(permission) ?? false
  }

  async function finish(result: { csrfToken: string }): Promise<void> {
    setCsrfToken(result.csrfToken)
    mfa.value = null
    await refresh()
  }

  async function setup(token: string, username: string, password: string): Promise<void> {
    await finish(await api.post<{ csrfToken: string }>('auth/setup', { token, username, password }))
  }

  async function login(username: string, password: string): Promise<'ok' | 'mfa'> {
    const result = await api.post<LoginResult>('auth/login', { username, password })
    if ('mfaRequired' in result) {
      mfa.value = { ticket: result.ticket, methods: result.methods }
      return 'mfa'
    }
    await finish(result)
    return 'ok'
  }

  function ticket(): string {
    if (!mfa.value) throw new Error('No sign-in in progress')
    return mfa.value.ticket
  }

  async function verifyTotp(code: string): Promise<void> {
    await finish(await api.post<{ csrfToken: string }>('auth/login/totp', { ticket: ticket(), code }))
  }

  async function verifyRecovery(code: string): Promise<void> {
    await finish(await api.post<{ csrfToken: string }>('auth/login/recovery', { ticket: ticket(), code }))
  }

  async function verifyPasskey(): Promise<void> {
    const t = ticket()
    const optionsJSON = await api.post<Parameters<typeof startAuthentication>[0]['optionsJSON']>(
      'auth/login/passkey/options',
      { ticket: t },
    )
    const response = await startAuthentication({ optionsJSON })
    await finish(await api.post<{ csrfToken: string }>('auth/login/passkey', { ticket: t, response }))
  }

  /** The shells this browser tab kept for a reload go with the session (review 2026-10-12, M18). */
  function forgetShells(): void {
    try {
      for (const key of Object.keys(sessionStorage))
        if (key.startsWith('mm:shell-session:')) sessionStorage.removeItem(key)
    } catch {
      // Storage refused: nothing was kept.
    }
  }

  function resetMfa(): void {
    mfa.value = null
  }

  async function logout(): Promise<void> {
    await api.post('auth/logout')
    me.value = null
    forgetShells()
    setCsrfToken(undefined)
    await refresh()
  }

  return {
    status,
    me,
    mfa,
    ready,
    blockedAddress,
    refresh,
    can,
    setup,
    login,
    verifyTotp,
    verifyRecovery,
    verifyPasskey,
    resetMfa,
    logout,
  }
})
