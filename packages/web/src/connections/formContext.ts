// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { inject, provide, type InjectionKey } from 'vue'
import type { ConnectionForm, Section } from './formModel'
import type { ConnectionString } from './connectionString'

export interface ConnectionFormContext {
  form: ConnectionForm
  /** Localised error for a field key (server issue path without "settings."). */
  errorFor(key: string): string | undefined
  /** Hint shown under a secret field that still holds the stored (masked) value. */
  secretHint(value: string): string | undefined
  /** The connection string at the head of the form (its state is the dialog's). */
  connectionString: ConnectionString
  /** An existing connection is edited (not a new one, nor a duplicate). */
  editing: boolean
  /** The name has the first focus (an edited or duplicated connection). */
  focusName: boolean
  /** Opens Advanced options at a section, focusing a field of it (`data-connection-field`). */
  openSection(section: Section, field?: string): void
}

const KEY: InjectionKey<ConnectionFormContext> = Symbol('connection-form')

export const provideConnectionForm = (ctx: ConnectionFormContext): void => provide(KEY, ctx)

export function useConnectionForm(): ConnectionFormContext {
  const ctx = inject(KEY)
  if (!ctx) throw new Error('useConnectionForm() used outside ConnectionDialog')
  return ctx
}
