import { MIN_MONGODB_VERSION } from '@mongo-manager/shared/browser'
import { ApiError } from './client'
import { cautionKind, cautionText } from '@/documents/caution'

type Translate = (key: string, values?: Record<string, unknown>) => string

const KNOWN = new Set([
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'RATE_LIMITED',
  'VALIDATION_ERROR',
  'CONFLICT',
  'NOT_FOUND',
  'READ_ONLY',
  'DOCUMENT_CHANGED',
])
const MONGO_KINDS = new Set([
  'auth',
  'network',
  'dns',
  'tls',
  'timeout',
  'ssh',
  'ssh-host-key',
  'dependency',
  'config',
  'busy',
  'pool',
  'unsupported',
  'oidc',
  'encryption',
  'closed',
  'unknown',
])

/** Phase 3d-1: refusals of the transfer routes that have their own sentence. */
const TRANSFER_REASONS = new Set([
  'transfer_quota',
  'transfer_full',
  'transfer_busy',
  'upload_busy',
  'upload_idle',
  'upload_aborted',
  'content_type',
  'xlsx_rows',
  'mapping_conflict',
  'mapping_required',
  'mapping_source',
  'mapping_path',
  'export_write_stage',
  'preset_name',
  'preset_limit',
])

/** A rule of the collection's validator a write did not meet, as the server names it (code 121). */
interface ValidationProblem {
  path: string
  rule: string
  reason?: string
  expected?: string
  found?: string
  description?: string
  /** One "any of these": the problems sharing it are alternatives. */
  group?: number
  /** A dependency's rule: it applies while this field is there. */
  when?: string
}
const SHOWN_PROBLEMS = 5
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

function problemsOf(value: unknown): ValidationProblem[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((p: unknown) => {
    const { path, rule, reason, expected, found, description, group, when } = (p ?? {}) as Record<
      string,
      unknown
    >
    if (typeof path !== 'string' || typeof rule !== 'string' || rule === '') return []
    return [
      {
        path,
        rule,
        reason: str(reason),
        expected: str(expected),
        found: str(found),
        description: str(description),
        group: typeof group === 'number' ? group : undefined,
        when: str(when),
      },
    ]
  })
}

/** A type the server names as JSON ("string", ["double","int"]), said without its quotes. */
function typeNames(expected: string): string {
  try {
    const value: unknown = JSON.parse(expected)
    if (typeof value === 'string') return value
    if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return value.join(', ')
  } catch {
    // Not JSON: said as it came.
  }
  return expected
}

const TYPE_RULES = new Set(['bsonType', 'type', '$type'])

function ruleText(p: ValidationProblem, t: Translate): string {
  const field = p.path || t('errors.validation.document')
  const values = { ...p, field }
  if (p.rule === 'required') return t('errors.validation.required', values)
  if (p.rule === 'additionalProperties') return t('errors.validation.notAllowed', values)
  if (TYPE_RULES.has(p.rule) && p.expected) {
    const typed = { ...values, expected: typeNames(p.expected) }
    return t(p.found ? 'errors.validation.typeFound' : 'errors.validation.type', typed)
  }
  if ((p.rule === 'enum' || p.rule === '$in') && p.expected) return t('errors.validation.oneOf', values)
  if (p.rule === '$nin' && p.expected) return t('errors.validation.noneOf', values)
  if ((p.rule === '$not' || p.rule === '$nor') && p.expected) return t('errors.validation.mustNot', values)
  if (p.rule === 'not') return t('errors.validation.notSchema', values)
  if (p.rule === 'oneOf' && p.group === undefined) return t('errors.validation.oneOfMany', values)
  if (p.expected) return t('errors.validation.rule', values)
  return t(p.reason ? 'errors.validation.ruleReason' : 'errors.validation.ruleOnly', values)
}

function problemText(p: ValidationProblem, t: Translate): string {
  // The schema's own words for the field come first; the rule stays beside them.
  const said = p.description
    ? t('errors.validation.described', {
        field: p.path || t('errors.validation.document'),
        description: p.description.replace(/[.\s]+$/, ''),
        rule: p.expected ? `${p.rule} ${p.expected}` : p.rule,
      })
    : ruleText(p, t)
  return p.when ? t('errors.validation.when', { text: said, when: p.when }) : said
}

/** Research 2026-10-28 (SERVER-20547): which of the validator's rules a write did not meet. */
function validationText(problems: ValidationProblem[], more: boolean, t: Translate): string {
  // The alternatives of one rule are one item: "a or b".
  const items: ValidationProblem[][] = []
  for (const p of problems) {
    const last = items.at(-1)
    if (p.group !== undefined && last?.[0]?.group === p.group) last.push(p)
    else items.push([p])
  }
  const or = ` ${t('errors.validation.or')} `
  const said = items.slice(0, SHOWN_PROBLEMS).map((group) => group.map((p) => problemText(p, t)).join(or))
  const left = items.length - said.length
  if (more) said.push(t('errors.validation.more'))
  else if (left > 0) said.push(t('errors.validation.moreCount', { count: left }))
  return t('errors.validation.failed', { problems: said.join('; ') })
}

/** One user-facing sentence for any failure; never shows raw server internals. */
export function describeError(
  e: unknown,
  t: Translate,
  overrides: Partial<Record<string, string>> = {},
): string {
  if (e instanceof ApiError) {
    const override = overrides[e.code]
    if (override) return t(override)
    // Phase 3c §7: personal data the server hides from this user, and MongoDB text it withholds.
    const d = (e.details ?? {}) as {
      reason?: unknown
      field?: unknown
      what?: unknown
      hidden?: unknown
      code?: unknown
      codeName?: unknown
      kind?: unknown
      index?: unknown
      collection?: unknown
      problems?: unknown
      more?: unknown
    }
    // Ninth review of the open's stop (minor 7): one naming no field said "undefined holds…".
    if (e.code === 'FORBIDDEN' && d.reason === 'personal_field')
      return typeof d.field === 'string'
        ? t('masking.personalField', { field: d.field })
        : t('masking.personalFieldUnnamed')
    // Tenth review (nit 2): as personal_field, never "undefined".
    if (e.code === 'FORBIDDEN' && d.reason === 'personal_write')
      return typeof d.field === 'string'
        ? t('masking.personalWrite', { field: d.field })
        : t('masking.personalWriteUnnamed')
    if (e.code === 'FORBIDDEN' && d.reason === 'personal_index') return t('masking.personalIndex')
    if (e.code === 'FORBIDDEN' && d.reason === 'masking_unsupported')
      return t('masking.unsupported', { what: String(d.what) })
    // Security review 2026-10-13 (M3): a page past the byte cap.
    if (d.reason === 'page_too_large') return t('documents.pageTooLarge')
    // Data review 2026-10-13 (H3, M2): written back from here, the stored field would change.
    if (e.code === 'CONFLICT' && d.reason === 'not_round_trip')
      return cautionText(t, { kind: cautionKind(d.kind), field: String(d.field ?? '') }, 'refused')
    // A restricted user's too: the fields and rules, never the values (the server keeps those out).
    const problems = e.code === 'MONGO_ERROR' ? problemsOf(d.problems) : []
    if (problems.length > 0) return validationText(problems, d.more === true, t)
    if (d.hidden === true && e.code === 'CONFLICT')
      return t('masking.duplicateHidden', { index: String(d.index ?? '') })
    // A server not available for now did not refuse it (review of the agent's gate, M-3).
    if (d.hidden === true)
      return t(e.status === 503 ? 'masking.mongoHiddenUnavailable' : 'masking.mongoHidden', {
        code: [d.code, d.codeName].filter((v) => v !== null && v !== undefined).join(' '),
      })
    // Phase 3d-1: file transfer. The server's sentence about a file names what is wrong with it.
    if (e.code === 'BAD_FILE') return t('dataTransfer.errors.badFile', { message: e.message })
    if (e.code === 'GONE') return t('dataTransfer.errors.gone')
    // Final reviews of explain masking: which collection is a time series, or a view.
    if (d.reason === 'replace_timeseries')
      return typeof d.collection === 'string' && d.collection !== ''
        ? t('dataTransfer.errors.replace_timeseries', { collection: d.collection })
        : t('dataTransfer.errors.replace_timeseries_unnamed')
    if (d.reason === 'replace_into_timeseries')
      return typeof d.collection === 'string' && d.collection !== ''
        ? t('dataTransfer.errors.replace_into_timeseries', { collection: d.collection })
        : t('dataTransfer.errors.replace_into_timeseries_unnamed')
    if (d.reason === 'target_timeseries')
      return typeof d.collection === 'string' && d.collection !== ''
        ? t('dataTransfer.errors.target_timeseries', { collection: d.collection })
        : t('dataTransfer.errors.target_timeseries_unnamed')
    if (d.reason === 'target_is_view')
      return typeof d.collection === 'string' && d.collection !== ''
        ? t('dataTransfer.errors.target_is_view', { collection: d.collection })
        : t('dataTransfer.errors.target_is_view_unnamed')
    if (typeof d.reason === 'string' && TRANSFER_REASONS.has(d.reason))
      return t(`dataTransfer.errors.${d.reason}`)
    if (e.code === 'RATE_LIMITED') {
      const ms = Number((e.details as { retryAfterMs?: unknown } | undefined)?.retryAfterMs ?? 0)
      // Sign-in bans (2026-10-30): the address is refused for a while, or the server is busy.
      if (d.reason === 'address_banned') {
        const minutes = Math.max(1, Math.ceil(ms / 60_000))
        const wait =
          minutes < 60
            ? t('errors.waitMinutes', { n: minutes })
            : t('errors.waitHours', { n: Math.ceil(minutes / 60) })
        return t('errors.addressBanned', { wait })
      }
      if (d.reason === 'server_busy') return t('errors.serverBusy')
      return t('errors.RATE_LIMITED', { seconds: Math.max(1, Math.ceil(ms / 1000)) })
    }
    if (e.code === 'UNSUPPORTED_SERVER') return t('mongo.kinds.unsupported', { min: MIN_MONGODB_VERSION })
    if (e.code === 'MONGO_ERROR') {
      const kind = (e.details as { kind?: unknown } | undefined)?.kind
      if (typeof kind === 'string' && MONGO_KINDS.has(kind)) {
        const said = t(`mongo.kinds.${kind}`)
        // A refused sign-in the server keeps (fourth review, I1): how it is tried again.
        return (e.details as { remembered?: unknown }).remembered === true
          ? `${said} ${t('mongo.remembered')}`
          : said
      }
      // Server messages for MongoDB errors are sanitised (spec §4.9) and are the most useful detail.
      return t('errors.MONGO_ERROR', { message: e.message })
    }
    if (KNOWN.has(e.code)) return t(`errors.${e.code}`)
    return t('errors.UNKNOWN', { code: e.correlationId ?? e.code })
  }
  if (e instanceof TypeError) return t('errors.NETWORK')
  return t('errors.UNKNOWN', { code: 'client' })
}
