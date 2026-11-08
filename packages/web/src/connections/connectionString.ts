// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { ref, type Ref } from 'vue'
import { SECRET_MASK } from '@mongo-manager/shared/browser'
import type { ConnectionSettings } from '@mongo-manager/shared'
import { ApiError } from '@/api/client'
import { describeError } from '@/api/errors'
import { connectionsApi } from '@/api/connections'
import type { ConnectionForm } from './formModel'
import { applyUri, passwordFromUri, propertiesFromUri, withScheme } from './uriFill'

type T = (key: string, values?: Record<string, unknown>) => string

/**
 * The connection string at the head of the form (user report 2026-10-16). Its state is the dialog's,
 * not its field's: a section switch keeps what was typed (review of the change, I4).
 *
 * - A paste, Enter or leaving the field reads it at once and says a refusal; typing reads it after a
 *   pause, silently — for a new connection only: editing one, a pause never rewrites it (I2).
 * - Each reading is applied to the form as it was when the field was first changed: a half-typed
 *   user never takes the stored password with it (I1).
 * - Save and Test read a string still unread first (`flush`), and an unread one counts as a change
 *   when the dialog closes (I5).
 */
export function useConnectionString(form: ConnectionForm, editing: boolean, t: T) {
  const text = ref('')
  const read = ref('')
  const error = ref('')
  let parsed = ''
  let silentlyRefused = ''
  let timer: ReturnType<typeof setTimeout> | undefined
  let autoName: string | null = null
  let asked = 0
  let base: { username: string; password: string; tlsEnabled: boolean } | null = null
  let inFlight: Promise<boolean> | null = null

  const hostText = (h: { host: string; port?: number }) => {
    const host = h.host.includes(':') ? `[${h.host}]` : h.host
    return h.port !== undefined ? `${host}:${h.port}` : host
  }
  const hostsText = (s: ConnectionSettings) => s.hosts.map(hostText).join(', ')

  function summary(s: ConnectionSettings, tlsWasOn: boolean): string {
    const parts = [hostsText(s)]
    // An AWS access key is not a user name to show (review M5).
    parts.push(
      s.auth.mechanism === 'none'
        ? t('connection.uriSummary.noAuth')
        : s.auth.username && s.auth.mechanism !== 'MONGODB-AWS'
          ? t('connection.uriSummary.user', { user: s.auth.username })
          : t('connection.uriSummary.auth'),
    )
    if (s.replicaSet) parts.push(t('connection.uriSummary.replicaSet', { name: s.replicaSet }))
    if (s.tls.enabled) parts.push(t('connection.uriSummary.tls'))
    else if (tlsWasOn) parts.push(t('connection.uriSummary.tlsOff'))
    return parts.join(' · ')
  }

  function apply(settings: ConnectionSettings, value: string): void {
    base ??= { username: form.auth.username, password: form.auth.password, tlsEnabled: form.tls.enabled }
    form.auth.username = base.username
    form.auth.password = base.password
    // parse-uri masks the password it parsed; the URI in the browser still has it (Review Focus 2).
    const password = passwordFromUri(value)
    const auth =
      password !== undefined && settings.auth.password === SECRET_MASK
        ? { ...settings.auth, password }
        : { ...settings.auth }
    // So are secret mechanism properties (an AWS session token).
    const properties = propertiesFromUri(value)
    if (properties !== undefined && auth.mechanismProperties?.includes(SECRET_MASK))
      auth.mechanismProperties = properties
    applyUri(form, { ...settings, auth })
    // A name the user gave stays; one this field gave follows the host.
    const name = hostsText(settings).slice(0, 100)
    if (!editing && (!form.name.trim() || form.name === autoName)) {
      form.name = name
      autoName = name
    }
    read.value = t('connection.uriUnderstood', { summary: summary(settings, base.tlsEnabled) })
  }

  /** Reads the string now; true when the form follows it (or there is nothing to read). */
  function readNow(loud: boolean): Promise<boolean> {
    clearTimeout(timer)
    const typed = text.value.trim()
    if (!typed) {
      asked++
      parsed = ''
      read.value = ''
      error.value = ''
      return Promise.resolve(true)
    }
    // "mongodb:/host" is a typo of the scheme, not a host named "mongodb" (review M7).
    if (/^mongodb(\+srv)?:(?!\/\/)/i.test(typed)) {
      asked++
      if (loud) error.value = t('connection.uriSlashes')
      return Promise.resolve(false)
    }
    const value = withScheme(typed)
    if (value === parsed) return inFlight ?? Promise.resolve(true)
    if (!loud && value === silentlyRefused) return Promise.resolve(false)
    const ask = ++asked
    inFlight = connectionsApi.parseUri(value).then(
      ({ settings }) => {
        if (ask !== asked) return false
        parsed = value
        error.value = ''
        apply(settings, value)
        return true
      },
      (e: unknown) => {
        if (ask !== asked) return false
        parsed = ''
        read.value = ''
        if (!loud) {
          silentlyRefused = value
          return false
        }
        // Fourth review: an option the server refuses is said in the app's language, as refused:
        // the string itself was read.
        const refused =
          e instanceof ApiError ? (e.details as { reason?: unknown; option?: unknown }) : undefined
        if (refused?.reason === 'option_not_supported') {
          error.value = t('connection.optionNotSupported', { option: String(refused.option ?? '') })
          return false
        }
        const detail =
          e instanceof ApiError && e.code === 'VALIDATION_ERROR' ? e.message : describeError(e, t)
        error.value = t('connection.uriInvalid', { detail })
        return false
      },
    )
    const mine = inFlight
    void mine.finally(() => {
      if (inFlight === mine) inFlight = null
    })
    return mine
  }

  return {
    text,
    /** What the form follows, said in words (a status, empty when nothing was read). */
    read: read as Readonly<Ref<string>>,
    /** Why the string could not be read (shown on the field). */
    error: error as Readonly<Ref<string>>,
    onInput(): void {
      clearTimeout(timer)
      // A reading of what was there before no longer counts (review M1).
      asked++
      silentlyRefused = ''
      error.value = ''
      if (!text.value.trim()) {
        parsed = ''
        read.value = ''
        return
      }
      if (!editing) timer = setTimeout(() => void readNow(false), 700)
    },
    onPaste(): void {
      // After the paste is in the field.
      setTimeout(() => void readNow(true), 0)
    },
    onLeave(): void {
      void readNow(true)
    },
    /** Enter: a string not yet read is read; one already read lets Enter save (review M3). */
    onEnter(event: KeyboardEvent): void {
      if (withScheme(text.value) === parsed && !inFlight) return
      event.preventDefault()
      void readNow(true)
    },
    /** What is missing, said on the field itself (Test or Save with nothing to connect to). */
    require(message: string): void {
      error.value = message
    },
    /** Before Save or Test: a string typed but not read yet is read first. */
    flush: () => readNow(true),
    /** Text in the field the form does not follow yet: a change to keep or to discard. */
    unread: () => text.value.trim() !== '' && withScheme(text.value) !== parsed,
    dispose: () => clearTimeout(timer),
  }
}

export type ConnectionString = ReturnType<typeof useConnectionString>

/**
 * Where an edited or duplicated connection points, from its form (review M1): hosts, user, replica set
 * and TLS, never a secret.
 */
export function formTarget(form: ConnectionForm, t: T): string {
  const hosts = form.hosts
    .filter((h) => h.host.trim())
    .map((h) => {
      const host = h.host.includes(':') ? `[${h.host.trim()}]` : h.host.trim()
      return h.port.trim() && form.scheme === 'mongodb' ? `${host}:${h.port.trim()}` : host
    })
  if (!hosts.length) return ''
  const parts = [hosts.join(', ')]
  parts.push(
    form.auth.mechanism === 'none'
      ? t('connection.uriSummary.noAuth')
      : form.auth.username && form.auth.mechanism !== 'MONGODB-AWS'
        ? t('connection.uriSummary.user', { user: form.auth.username })
        : t('connection.uriSummary.auth'),
  )
  if (form.replicaSet.trim())
    parts.push(t('connection.uriSummary.replicaSet', { name: form.replicaSet.trim() }))
  if (form.tls.enabled) parts.push(t('connection.uriSummary.tls'))
  if (form.ssh.enabled) parts.push(t('connection.uriSummary.ssh'))
  return parts.join(' · ')
}
