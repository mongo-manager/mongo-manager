// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { PluginAdminView, PluginSource } from '@mongo-manager/shared/browser'
import { fold } from '@/ds/fold'
import { pluginStatus } from './usePluginAdmin'

/**
 * User request 2026-10-28: the Plugins page narrowed to the enabled ones, those an administrator
 * still has to act on (waiting for an approval, changed, broken) or the disabled ones; to one source;
 * to those a search finds.
 */
export const PLUGIN_STATE_FILTERS = ['all', 'enabled', 'attention', 'disabled'] as const
export type PluginStateFilter = (typeof PLUGIN_STATE_FILTERS)[number]
export const PLUGIN_SOURCES: readonly PluginSource[] = ['bundled', 'upload', 'folder']

export function inState(p: PluginAdminView, state: PluginStateFilter): boolean {
  const status = pluginStatus(p)
  if (state === 'all') return true
  if (state === 'attention') return status !== 'enabled' && status !== 'disabled'
  return status === state
}

/**
 * What a search reads in a plugin: its id and version, and its name, description and what it adds, in
 * every language.
 */
function searchable(p: PluginAdminView): string[] {
  const m = p.manifest
  if (!m) return [p.id]
  const c = m.contributes
  const titles = [...c.collectionTabs, ...c.documentActions, ...c.sidebarPanels].map((x) => x.title)
  const texts = [m.name, m.description, ...titles].flatMap((text) => Object.values(text ?? {}))
  return [p.id, m.version, ...texts.filter((s): s is string => typeof s === 'string')]
}

/**
 * Whether a plugin holds every word searched for, anywhere in it or in `also` (what it asks for, as the
 * page says it: final review); no words, every plugin.
 */
export function matchesSearch(
  p: PluginAdminView,
  query: string,
  locale: string,
  also: readonly string[] = [],
): boolean {
  const words = fold(query, locale).split(/\s+/).filter(Boolean)
  if (!words.length) return true
  const text = [...searchable(p), ...also].map((s) => fold(s, locale)).join('\n')
  return words.every((w) => text.includes(w))
}
