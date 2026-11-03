import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQueryClient } from '@tanstack/vue-query'
import {
  cspImageSource,
  type PluginAdminView,
  type PluginPermission,
  type PluginScanFinding,
} from '@mongo-manager/shared/browser'
import { pluginsApi } from '@/api/plugins'
import { explainError } from '@/api/reasons'
import { useDialogStore } from '@/stores/dialogs'
import { useToastStore } from '@/stores/toasts'
import { localized } from '@/plugins/store'

/** Each permission in a sentence an administrator approves (wave 2 adds two read-only ones). */
const PERMISSION_TEXT: Record<PluginPermission, string> = {
  'documents:read': 'read',
  'documents:write': 'write',
  'collection:read': 'collection',
  'database:read': 'database',
}
export type PluginStatus = 'enabled' | 'approve' | 'changed' | 'disabled' | 'broken'
export const PLUGIN_STATUS_TONES: Record<PluginStatus, 'accent' | 'warning' | 'danger' | 'neutral' | 'info'> =
  {
    enabled: 'accent',
    approve: 'info',
    changed: 'warning',
    disabled: 'neutral',
    broken: 'danger',
  }
export const pluginStatus = (p: PluginAdminView): PluginStatus =>
  p.error || !p.manifest
    ? 'broken'
    : p.enabled
      ? 'enabled'
      : p.approvedPermissions.length || p.approvedCurrent
        ? p.approvedCurrent
          ? 'disabled'
          : 'changed'
        : 'approve'

/** What a scan found, as a badge: high risks, those to review, low ones; null when it was not read. */
export const scanTone = (p: PluginAdminView): 'danger' | 'warning' | 'info' | 'neutral' | null =>
  !p.scan
    ? null
    : p.scan.counts.high
      ? 'danger'
      : p.scan.counts.medium
        ? 'warning'
        : p.scan.counts.low
          ? 'info'
          : 'neutral'
/**
 * Whether approving it asks for its id typed, as the server does: a high finding, or no scan at all
 * (review 2026-10-11), in a plugin not shipped with the app.
 */
export const riskToAccept = (p: PluginAdminView): boolean =>
  p.source !== 'bundled' && (!p.scan || p.scan.counts.high > 0)
/** A rule's key in `plugins.security.rule` (its id in camel case). */
const ruleKey = (rule: string) => rule.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())

/**
 * Phase 4b §2: what an administrator does to a plugin — approve it for the files shown, disable,
 * set it up, remove it — on the Plugins page and on a plugin's own page (user request 2026-10-10).
 */
export function usePluginAdmin() {
  const { t, te, locale } = useI18n()
  const queryClient = useQueryClient()
  const dialogs = useDialogStore()
  const toasts = useToastStore()
  const busy = ref<string | null>(null)

  /** Runs an action, saying how it went; whether it worked (review M12). */
  async function run(key: string, action: () => Promise<unknown>, message?: string): Promise<boolean> {
    busy.value = key
    try {
      await action()
      if (message) toasts.push({ kind: 'success', message })
      return true
    } catch (e) {
      toasts.push({ kind: 'error', message: explainError(e, t) })
      return false
    } finally {
      busy.value = null
      await queryClient.invalidateQueries({ queryKey: ['plugins'] })
    }
  }
  const nameOf = (p: PluginAdminView) => (p.manifest ? localized(p.manifest.name, locale.value) : p.id)
  const permission = (p: PluginPermission) => t(`plugins.permission.${PERMISSION_TEXT[p]}`)
  /** A finding's rule in a sentence; one this version does not know by its id. */
  const ruleText = (f: Pick<PluginScanFinding, 'rule'>) =>
    te(`plugins.security.rule.${ruleKey(f.rule)}`) ? t(`plugins.security.rule.${ruleKey(f.rule)}`) : f.rule
  const scanBadge = (p: PluginAdminView) =>
    !p.scan
      ? ''
      : p.scan.counts.high
        ? t('plugins.security.badge.high', { count: p.scan.counts.high }, p.scan.counts.high)
        : p.scan.counts.medium
          ? t('plugins.security.badge.medium', { count: p.scan.counts.medium })
          : p.scan.counts.low
            ? t('plugins.security.badge.low', { count: p.scan.counts.low }, p.scan.counts.low)
            : t('plugins.security.badge.clean')
  const contributions = (p: PluginAdminView) => {
    const c = p.manifest?.contributes
    if (!c) return []
    return [
      ...c.collectionTabs.map((x) =>
        t('plugins.contributes.collectionTab', { title: localized(x.title, locale.value) }),
      ),
      ...c.documentActions.map((x) =>
        t('plugins.contributes.documentAction', { title: localized(x.title, locale.value) }),
      ),
      ...c.sidebarPanels.map((x) =>
        t('plugins.contributes.sidebarPanel', { title: localized(x.title, locale.value) }),
      ),
      ...c.cellRenderers.map((x) =>
        t('plugins.contributes.cellRenderer', { match: t(`plugins.cellMatches.${x.match}`) }),
      ),
    ]
  }
  /**
   * Approves it after asking, saying what its scan found (user request 2026-10-11: never a bare
   * yes): one with a high finding only with its id typed, sent as the risk accepted.
   */
  async function approve(p: PluginAdminView): Promise<void> {
    const asked = p.manifest!.permissions
    const risky = riskToAccept(p)
    const high = [...new Set((p.scan?.findings ?? []).filter((f) => f.severity === 'high').map(ruleText))]
    // Security audit 2026-10-16 (M1): an address setting is where the plugin may send what it reads.
    const addresses = Object.values(p.manifest!.settings)
      .filter((s) => s.type === 'url')
      .map((s) => localized(s.title, locale.value))
    const message = [
      t('plugins.approveMessage', {
        name: nameOf(p),
        version: p.manifest!.version,
        permissions: asked.length ? asked.map(permission).join(', ') : t('plugins.permission.none'),
        files: p.fileCount,
        digest: p.digest!.slice(0, 16),
      }),
      addresses.length ? t('plugins.urlSettingRisk', { settings: addresses.join(', ') }) : '',
      p.scan ? `${scanBadge(p)}. ${t('plugins.security.summary', p.scan.counts)}` : '',
      risky
        ? p.scan
          ? t('plugins.security.approveRisk', { rules: high.join('; ') })
          : t('plugins.security.approveUnscanned')
        : '',
    ]
    const ok = await dialogs.confirm({
      title: t('plugins.approveTitle', { name: nameOf(p) }),
      message: message.filter(Boolean).join('\n\n'),
      confirmLabel: t('plugins.approve'),
      danger: risky,
      requireText: risky ? p.id : undefined,
    })
    if (ok)
      await run(
        p.id,
        () => pluginsApi.approve(p.id, p.digest!, risky ? p.id : undefined),
        t('plugins.approved', { name: nameOf(p) }),
      )
  }
  async function remove(p: PluginAdminView): Promise<boolean> {
    const ok = await dialogs.confirm({
      title: t('plugins.removeTitle', { name: nameOf(p) }),
      message: t(p.source === 'upload' ? 'plugins.removeUpload' : 'plugins.removeFolder', {
        name: nameOf(p),
      }),
      confirmLabel: t('plugins.remove'),
      danger: true,
    })
    return ok && (await run(p.id, () => pluginsApi.remove(p.id), t('plugins.removed', { name: nameOf(p) })))
  }
  const disable = (p: PluginAdminView) =>
    run(p.id, () => pluginsApi.disable(p.id), t('plugins.disabled', { name: nameOf(p) }))
  const saveSettings = (p: PluginAdminView, values: Record<string, string | boolean>) =>
    run(p.id, () => pluginsApi.settings(p.id, values), t('plugins.settingsSaved', { name: nameOf(p) }))

  /**
   * Review of the security pass (Minor): the address settings saved before the upgrade that are no
   * longer taken (plain http but on this computer): kept, given to no frame — by their titles.
   */
  const refusedAddresses = (p: PluginAdminView) =>
    Object.entries(p.manifest?.settings ?? {})
      .filter(([key, s]) => {
        const value = p.settings[key]
        return s.type === 'url' && typeof value === 'string' && value !== '' && !cspImageSource(value)
      })
      .map(([, s]) => localized(s.title, locale.value))

  return {
    busy,
    run,
    nameOf,
    refusedAddresses,
    permission,
    contributions,
    ruleText,
    scanBadge,
    approve,
    remove,
    disable,
    saveSettings,
  }
}
