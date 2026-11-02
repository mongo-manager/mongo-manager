import { useI18n } from 'vue-i18n'
import type { PreflightCheck } from '@mongo-manager/shared/browser'
import { formatBytes, formatCount, formatDuration } from '@/format'
import { ApiError } from '@/api/client'
import { describeError } from '@/api/errors'

/** U2, U13: a preflight check as a sentence. */
export function useCheckText() {
  const { t, locale } = useI18n()
  const b = (n: unknown) => formatBytes(Number(n ?? 0), locale.value)
  return (c: PreflightCheck): string => {
    const p = c.params ?? {}
    switch (c.key) {
      // Twelfth review of explain masking (I3): sizes hidden where rules hide personal data.
      case 'size':
        if (p.hidden) return t('backup.check.sizeHidden')
        return t('backup.check.size', {
          bytes: b(p.bytes),
          fileBytes: b(p.fileBytes),
          duration:
            p.seconds !== undefined
              ? t('backup.check.durationPart', { duration: formatDuration(Number(p.seconds), locale.value) })
              : '',
        })
      case 'quota':
        if (p.hidden) return t(`backup.check.quotaHidden.${c.level}`, { room: b(p.room) })
        return t(`backup.check.quota.${c.level}`, { room: b(p.room), fileBytes: b(p.fileBytes) })
      case 'personal':
      case 'conflict':
      case 'rules':
        return t(`backup.check.${c.key}.${c.level === 'ok' ? 'ok' : 'warn'}`, {
          count: formatCount(Number(p.count ?? 0), locale.value),
        })
      case 'ttl':
        return t(`backup.check.ttl.${c.level === 'ok' ? 'ok' : 'warn'}`, { names: String(p.names ?? '') })
      // Backup review I4: a cap the backup did not bring.
      case 'capped':
        return t('backup.check.capped', { names: String(p.names ?? '') })
      case 'tools':
        return c.level === 'ok'
          ? t('backup.check.tools.ok', { version: String(p.version ?? '') })
          : t('backup.check.tools.block', {
              reason: t(`backup.engine.reason.${String(p.reason)}`, { fields: String(p.fields ?? '') }),
            })
      case 'destination':
        // Phase 3d-3b V5: a chosen destination, by name, and what it refuses.
        return t(`backup.check.destination.${String(p.reason ?? 'ok')}`, { name: String(p.name ?? '') })
      case 'timeseries':
      case 'timeseries_version':
      case 'encrypted':
        return t(`backup.check.${c.key}`, { names: String(p.names ?? '') })
      default:
        return t(`backup.check.${c.key}`)
    }
  }
}

/**
 * Phase 3d-3b final review: a destination listing is limited per user (30 a minute, two at once — the
 * upload gate): over the rate it answers 429, with two running a conflict named upload_busy. Both are
 * said as listings, not as the generic "attempts" or "uploads".
 */
export function useListingError() {
  const { t } = useI18n()
  const backupError = useBackupError()
  return (e: unknown): string => {
    if (e instanceof ApiError && e.status === 429) return t('backup.remote.tooMany')
    if (e instanceof ApiError && (e.details as { reason?: unknown } | undefined)?.reason === 'upload_busy')
      return t('backup.remote.listBusy')
    return backupError(e).join(' ')
  }
}

/** A refused start or plan in the words of its reason; anything else as the API describes it. */
export function useBackupError() {
  const { t, te } = useI18n()
  return (e: unknown): string[] => {
    const d = (e instanceof ApiError ? e.details : undefined) as
      { reason?: unknown; reasons?: unknown } | undefined
    if (d?.reason === 'refused' && Array.isArray(d.reasons))
      return d.reasons.map((r) =>
        te(`backup.refusal.${String(r)}`) ? t(`backup.refusal.${String(r)}`) : String(r),
      )
    if (typeof d?.reason === 'string' && te(`backup.refusal.${d.reason}`))
      return [t(`backup.refusal.${d.reason}`)]
    // Phase 3d-3b: a destination that refused or could not be reached, in the reader's words.
    if (typeof d?.reason === 'string' && te(`destinations.reason.${d.reason}`))
      return [t(`destinations.reason.${d.reason}`)]
    return [describeError(e, t)]
  }
}
