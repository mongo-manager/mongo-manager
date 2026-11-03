import { ApiError } from '@/api/client'
import { describeError } from '@/api/errors'

type Translate = (key: string, values?: Record<string, unknown>) => string

/** Server refusals of W3 (users and roles, sharding, alerts) said in the user's language. */
const REASONS: Record<string, string> = {
  own_account: 'dbAccess.errors.ownAccount',
  broad_role: 'dbAccess.errors.broadRole',
  password_required: 'alerts.email.passwordAgain',
  builtin_role: 'dbAccess.errors.builtinRole',
  user_exists: 'dbAccess.errors.userExists',
  role_exists: 'dbAccess.errors.roleExists',
  not_sharded: 'shardingAdmin.errors.notSharded',
  system_namespace: 'shardingAdmin.errors.systemNamespace',
  too_many_sampled: 'alerts.errors.tooManySampled',
  too_many_rules: 'alerts.errors.tooManyRules',
  too_many_webhooks: 'alerts.errors.tooManyWebhooks',
  http_refused: 'alerts.errors.httpRefused',
  address_never: 'alerts.errors.addressNever',
  bad_url: 'alerts.errors.badUrl',
}

/**
 * One sentence for a failure of the server-administration pages. MongoDB refusing the connection's
 * account is told apart from the app refusing the user: it names the command, and that the rights
 * are MongoDB's to give.
 */
export function adminErrorText(e: unknown, t: Translate): string {
  if (e instanceof ApiError) {
    const d = (e.details ?? {}) as { reason?: unknown; command?: unknown }
    if (d.reason === 'mongo_not_permitted')
      return t('dbAccess.errors.mongoRefused', { command: String(d.command ?? '') })
    if (typeof d.reason === 'string' && REASONS[d.reason]) return t(REASONS[d.reason]!)
    // MongoDB's own words (sanitised by the server) say best what it would not do.
    if (e.code === 'MONGO_ERROR') return t('errors.MONGO_ERROR', { message: e.message })
  }
  return describeError(e, t)
}

/**
 * Re-review (1): the server found rights the page could not see (a custom role of another database
 * inheriting a broad one): the confirmation is asked, and the change sent again with it.
 */
export const isBroadRefusal = (e: unknown): boolean =>
  e instanceof ApiError && (e.details as { reason?: unknown } | undefined)?.reason === 'broad_role'

export const isOwnAccountRefusal = (e: unknown): boolean =>
  e instanceof ApiError && (e.details as { reason?: unknown } | undefined)?.reason === 'own_account'
