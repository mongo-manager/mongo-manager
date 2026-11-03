import { ALERT_UNITS, type AlertMetric, type AlertView } from '@mongo-manager/shared/browser'

type Translate = (key: string, values?: Record<string, unknown>) => string

/** A metric's value with its unit, in the reader's number format. */
export function formatMetric(
  t: Translate,
  locale: string,
  metric: AlertMetric,
  value: number | null,
): string {
  if (value === null) return '—'
  const n = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value)
  return t(`alerts.units.${ALERT_UNITS[metric]}`, { n })
}

const EGRESS = new Set([
  'address_refused',
  'address_never',
  'http_refused',
  'bad_url',
  'dns',
  'connect',
  'tls',
  'timeout',
  'redirect',
  'too_large',
  'network',
  'not_found',
])

/** Why a delivery failed, in words: an HTTP status, a refused address, a mail server's answer. */
export function deliveryError(t: Translate, channel: 'email' | 'webhook', code: string | null): string {
  if (!code) return t('alerts.deliveryErrors.network')
  const status = /^HTTP (\d{3})$/.exec(code)
  if (status) return t('alerts.deliveryErrors.http', { status: status[1] })
  if (channel === 'email') return t(`alerts.smtpErrors.${code}`)
  return EGRESS.has(code) ? t(`alerts.deliveryErrors.${code}`) : t('alerts.deliveryErrors.network')
}

/** Design 2026-10-25 (C7): a report run's counts as one line ("Orders: 3 · Shipping: 2"), or null. */
export function reportCounts(t: Translate, locale: string, a: AlertView): string | null {
  if (a.event !== 'report.ready') return null
  const parts = Object.entries(a.detail)
    .filter(([k]) => k !== 'report' && k !== 'reportId')
    .map(([label, v]) =>
      t('alerts.reports.value', {
        label,
        n: typeof v === 'number' ? new Intl.NumberFormat(locale).format(v) : v === null ? '—' : String(v),
      }),
    )
  return parts.length ? parts.join(' · ') : null
}

/** One line for an alert: what, how much, where (the bell and the history). */
export function alertTitle(t: Translate, locale: string, a: AlertView): string {
  const where = a.connectionName ?? t('alerts.deletedConnection')
  if (a.metric)
    return t(a.state === 'resolved' ? 'alerts.line.resolved' : 'alerts.line.firing', {
      metric: t(`alerts.metrics.${a.metric}`),
      value: formatMetric(t, locale, a.metric, a.value),
      threshold: formatMetric(t, locale, a.metric, a.threshold),
      connection: where,
    })
  // Design 2026-10-25 (C7): a report by its name where it is shown (administrators).
  if (a.event === 'report.ready' && typeof a.detail.report === 'string')
    return t('alerts.line.report', { name: a.detail.report, connection: where })
  return t('alerts.line.event', { event: t(`alerts.events.${a.event}`), connection: where })
}
