import type {
  AlertChannels,
  AlertChannelsView,
  AlertRuleInput,
  AlertRuleView,
  AlertView,
  ConnectionHealth,
  ReportInput,
  ReportPatch,
  ReportValue,
  ReportView,
  SmtpSettingsInput,
  SmtpSettingsView,
  WebhookView,
} from '@mongo-manager/shared/browser'
import { api, path } from './client'

/** W3.3, W3.4: alerts (rules, channels, history, the bell) and the connections' live health. */
export const alertKeys = {
  all: ['alerts'] as const,
  rules: (connectionId: string) => ['alerts', 'rules', connectionId] as const,
  channels: ['alerts', 'channels'] as const,
  history: (filter: string) => ['alerts', 'history', filter] as const,
  active: ['alerts', 'active'] as const,
  optIn: ['alerts', 'opt-in'] as const,
  /** Design 2026-10-25 (C7): scheduled reports. */
  reports: ['alerts', 'reports'] as const,
  health: ['connections', 'health'] as const,
  healthOf: (id: string) => ['connections', id, 'health'] as const,
}

export interface RulePatch {
  threshold?: number
  slowOpSeconds?: number
  sustain?: number
  enabled?: boolean
  channels?: AlertChannels
}

export const alertsApi = {
  rules: (connectionId = '') =>
    api.get<AlertRuleView[]>(
      `alerts/rules${connectionId ? `?connectionId=${encodeURIComponent(connectionId)}` : ''}`,
    ),
  createRule: (input: AlertRuleInput) => api.post<AlertRuleView>('alerts/rules', input),
  patchRule: (id: string, patch: RulePatch) => api.patch<AlertRuleView>(path`alerts/rules/${id}`, patch),
  deleteRule: (id: string) => api.delete<void>(path`alerts/rules/${id}`),
  snooze: (id: string, minutes: number | null) =>
    api.post<AlertRuleView>(path`alerts/rules/${id}/snooze`, { minutes }),
  // Design 2026-10-25 (C7): scheduled reports.
  reports: () => api.get<ReportView[]>('alerts/reports'),
  createReport: (input: ReportInput) => api.post<ReportView>('alerts/reports', input),
  patchReport: (id: string, patch: ReportPatch) => api.patch<ReportView>(path`alerts/reports/${id}`, patch),
  deleteReport: (id: string) => api.delete<void>(path`alerts/reports/${id}`),
  runReport: (id: string) =>
    api.post<{ values: ReportValue[]; sent: boolean }>(path`alerts/reports/${id}/run`),
  channels: () => api.get<AlertChannelsView>('alerts/channels'),
  setEmail: (input: SmtpSettingsInput) => api.put<SmtpSettingsView>('alerts/channels/email', input),
  setEmailEnabled: (enabled: boolean) => api.patch<SmtpSettingsView>('alerts/channels/email', { enabled }),
  testEmail: () => api.post<{ ok: boolean; error: string | null }>('alerts/channels/email/test'),
  createWebhook: (input: { name: string; url: string; enabled?: boolean }) =>
    api.post<WebhookView>('alerts/channels/webhooks', input),
  patchWebhook: (
    id: string,
    patch: { name?: string; url?: string; enabled?: boolean; rotateSecret?: true },
  ) => api.patch<WebhookView>(path`alerts/channels/webhooks/${id}`, patch),
  deleteWebhook: (id: string) => api.delete<void>(path`alerts/channels/webhooks/${id}`),
  testWebhook: (id: string) =>
    api.post<{ ok: boolean; attempts: number; error: string | null }>(
      path`alerts/channels/webhooks/${id}/test`,
    ),
  history: (filter: { connectionId?: string; state?: string; limit?: number } = {}) => {
    const q = new URLSearchParams()
    for (const [k, v] of Object.entries(filter)) if (v !== undefined && v !== '') q.set(k, String(v))
    const text = q.toString()
    return api.get<AlertView[]>(`alerts/history${text ? `?${text}` : ''}`)
  },
  active: () => api.get<AlertView[]>('alerts/active'),
  acknowledge: (id: string) => api.post<AlertView>(path`alerts/${id}/acknowledge`),
  dismiss: (id: string) => api.post<{ ok: true }>(path`alerts/${id}/dismiss`),
  optIn: () => api.get<{ inApp: boolean; available: boolean }>('me/alerts'),
  setOptIn: (inApp: boolean) => api.put<{ inApp: boolean; available: boolean }>('me/alerts', { inApp }),
  health: () => api.get<ConnectionHealth[]>('connections/health'),
  healthOf: (id: string) => api.get<ConnectionHealth>(path`connections/${id}/health`),
}
