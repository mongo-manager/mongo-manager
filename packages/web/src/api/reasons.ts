// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { ApiError } from './client'
import { describeError } from './errors'
import type { PasswordProblem } from '@mongo-manager/shared/browser'

type Translate = (key: string, values?: Record<string, unknown>) => string

/** Server refusals with a machine-readable `details.reason`, shown in the user's language. */
const REASONS: Record<string, string> = {
  masked_secret_reuse: 'connection.secretReuse',
  masked_secret_on_create: 'connection.secretOnCreate',
  self_demote: 'users.reasons.selfDemote',
  bad_key: 'dataTransfer.badKeyReason',
  risk_not_accepted: 'plugins.security.riskNotAccepted',
  github_address: 'plugins.github.reasons.address',
  github_off: 'plugins.github.reasons.off',
  github_not_found: 'plugins.github.reasons.notFound',
  github_rate_limited: 'plugins.github.reasons.rateLimited',
  github_unreachable: 'plugins.github.reasons.unreachable',
  github_failed: 'plugins.github.reasons.failed',
  github_redirect: 'plugins.github.reasons.redirect',
  github_redirects: 'plugins.github.reasons.redirects',
  github_forbidden: 'plugins.github.reasons.forbidden',
  github_asset: 'plugins.github.reasons.asset',
  github_digest: 'plugins.github.reasons.digest',
  github_digest_unknown: 'plugins.github.reasons.digestUnknown',
  github_no_archive: 'plugins.github.reasons.noArchive',
  github_many_archives: 'plugins.github.reasons.manyArchives',
  // The updater (2026-11-03).
  updates_off: 'about.updates.off',
  update_unavailable: 'about.updates.reasons.unavailable',
  update_changed: 'about.updates.reasons.changed',
  update_running: 'about.updates.reasons.running',
  last_admin: 'users.reasons.lastAdmin',
  self_delete: 'users.reasons.selfDelete',
  self_password: 'users.reasons.selfPassword',
  self_2fa_reset: 'users.reasons.selfTwoFactor',
  username_taken: 'users.reasons.usernameTaken',
  // Sign-in bans (2026-10-30).
  ban_not_an_address: 'users.bans.reasons.notAnAddress',
  ban_loopback: 'users.bans.reasons.loopback',
  ban_own_address: 'users.bans.reasons.ownAddress',
  ban_private: 'users.bans.reasons.private',
  // Panel access (2026-10-30).
  access_invalid: 'users.access.reasons.invalid',
  access_excludes_you: 'users.access.reasons.excludesYou',
  wrong_password: 'security.reasons.wrongPassword',
  wrong_password_or_code: 'security.reasons.wrongPasswordOrCode',
  invalid_code: 'security.reasons.invalidCode',
  step_up_required: 'security.reasons.stepUpRequired',
  totp_enabled: 'security.reasons.totpEnabled',
  totp_not_enabled: 'security.reasons.totpNotEnabled',
  no_pending_enrollment: 'security.reasons.noPendingEnrollment',
  two_factor_required: 'security.reasons.twoFactorRequired',
  passkey_expired: 'security.reasons.passkeyExpired',
  passkey_failed: 'security.reasons.passkeyFailed',
  passkey_duplicate: 'security.reasons.passkeyDuplicate',
  // Phase 4c §4.
  two_factor_needed_first: 'users.reasons.twoFactorNeededFirst',
  forced_by_config: 'users.reasons.forcedByConfig',
  last_factor_required: 'security.reasons.lastFactorRequired',
  two_factor_setup_required: 'security.reasons.twoFactorSetupRequired',
  // W7, W8: the server's policy for Kerberos, OIDC and client-side encryption; OIDC sign-in.
  ...Object.fromEntries(
    [
      'kerberos_unavailable',
      'kerberos_team_disabled',
      'workload_identity_team_disabled',
      'encryption_unavailable',
      'crypt_shared_path_team',
      'crypt_shared_path_needed',
      'crypt_shared_path_invalid',
      'mongocryptd_not_local',
      'oidc_host_not_allowed',
      'oidc_needs_tls',
      'oidc_token_resource_unconfirmed',
      'oidc_workload_unconfirmed',
      'encryption_masked_write',
      'encryption_decrypt_only',
      'encryption_not_set_up',
      'kms_provider_missing',
      'kms_host_not_allowed',
      'encryption_keys_hidden',
      'not_oidc',
      'oidc_workload',
      'oidc_issuer',
      'oidc_issuer_unreachable',
      'oidc_pkce',
      'oidc_device_unsupported',
      'oidc_no_idp',
      'oidc_busy',
      'oidc_issuer_mismatch',
      'oidc_device_off',
      'oidc_redirect_foreign',
      'oidc_per_person',
      'oidc_level2',
      'oidc_token',
      'oidc_sign_in',
      'encrypted_connection',
    ].map((r) => [r, `connection.reasons.${r}`]),
  ),
}

// Typed by the shared codes: a new one without its text does not compile (final review M8).
const PROBLEMS: Record<PasswordProblem, string> = {
  too_short: 'security.problems.tooShort',
  too_long: 'security.problems.tooLong',
  contains_username: 'security.problems.containsUsername',
  too_common: 'security.problems.tooCommon',
  repeated_char: 'security.problems.repeatedChar',
  too_predictable: 'security.problems.tooPredictable',
}

/** The words of a refusal reason, where it has some (seventh review of the open's stop, minor 2). */
export function reasonKey(reason: string): string | undefined {
  return Object.hasOwn(REASONS, reason) ? REASONS[reason] : undefined
}

/** The localized sentence for a refusal the server named, or null when it named none we know. */
export function reasonMessage(e: unknown, t: Translate): string | null {
  if (!(e instanceof ApiError)) return null
  const details = e.details as { reason?: unknown; problems?: unknown; why?: unknown } | undefined
  const reason = details?.reason
  if (typeof reason !== 'string') return null
  if (reason === 'weak_password') {
    const problems = Array.isArray(details?.problems) ? details.problems : []
    const texts = problems
      .filter((p): p is string => typeof p === 'string' && Object.hasOwn(PROBLEMS, p))
      .map((p) => t(PROBLEMS[p as PasswordProblem]))
    return texts.length > 0 ? t('security.reasons.weakPassword', { problems: texts.join('; ') }) : null
  }
  if (reason === 'passkeys_unavailable') {
    return t(
      details?.why === 'ip-address'
        ? 'security.passkeys.unavailableIp'
        : 'security.passkeys.unavailableInsecure',
    )
  }
  const key = reasonKey(reason)
  return key ? t(key) : null
}

/**
 * One sentence for a failed account or admin action: the named reason in the user's language;
 * failing that, the server's validation text (better than a generic line); otherwise the generic message.
 */
export function explainError(e: unknown, t: Translate): string {
  const named = reasonMessage(e, t)
  if (named) return named
  if (e instanceof ApiError && e.code === 'VALIDATION_ERROR' && e.message) return e.message
  return describeError(e, t)
}
