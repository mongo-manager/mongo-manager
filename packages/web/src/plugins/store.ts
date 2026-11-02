import { computed, ref, shallowRef } from 'vue'
import { defineStore } from 'pinia'
import type { LocalizedText, PluginManifest, PluginRuntimeView } from '@mongo-manager/shared/browser'
import type { Bridge } from './bridge'

export type ContributionKind = 'collectionTab' | 'documentAction' | 'sidebarPanel' | 'cellRenderer'

/** One thing a plugin adds, with its plugin. */
export interface Contribution {
  /** `plugin:<pluginId>:<contributionId>`: unique in the app. */
  key: string
  kind: ContributionKind
  id: string
  plugin: PluginRuntimeView
  title: LocalizedText
  icon?: string
}
type Titled = PluginManifest['contributes']['collectionTabs'][number]

/**
 * What a plugin's frame is kept by: the plugin, its version and what it was approved for (any
 * order). Another of these is another page, loaded afresh — never the old one running on with what
 * it was given before (security audit 2026-10-16, M3).
 */
export const pluginFrameKey = (plugin: Pick<PluginRuntimeView, 'id' | 'version' | 'permissions'>) =>
  `${plugin.id}@${plugin.version}|${[...plugin.permissions].sort().join(',')}`
/** A contribution's frame: its key and its plugin's {@link pluginFrameKey}. */
export const frameKey = (c: Pick<Contribution, 'key' | 'plugin'>) => `${c.key}|${pluginFrameKey(c.plugin)}`

/** A plugin's text in the reader's language, English otherwise. */
export const localized = (text: LocalizedText, locale: string) =>
  (locale !== 'en' && Object.hasOwn(text, locale) ? text[locale as keyof LocalizedText] : undefined) ??
  text.en

/**
 * Phase 4b §3: the plugins that run (as the server lists them for this user), what they add, and
 * the hidden frames that render cells. (Their sidebar entries open pages: user request 2026-10-10.)
 */
export const usePluginsStore = defineStore('plugins', () => {
  const runtime = ref<PluginRuntimeView[]>([])
  /** The list arrived: before it, what a plugin brings is loading, not off (review of 1.0.1, M1). */
  const runtimeKnown = ref(false)
  /**
   * The collections the user put a plugin page on by a click (review I2): one that came in a link
   * is opened only when the user says so. Kept for the session.
   */
  const chosen = ref(new Set<string>())
  const choose = (key: string) => void (chosen.value = new Set([...chosen.value, key]))
  /** Cell renderer frames by plugin id, once their bridge is up. */
  const renderers = shallowRef(new Map<string, Bridge>())

  const of = (kind: Exclude<ContributionKind, 'cellRenderer'>, list: (p: PluginRuntimeView) => Titled[]) =>
    computed<Contribution[]>(() =>
      runtime.value.flatMap((plugin) =>
        list(plugin).map((c) => ({
          key: `plugin:${plugin.id}:${c.id}`,
          kind,
          id: c.id,
          plugin,
          title: c.title,
          ...(c.icon ? { icon: c.icon } : {}),
        })),
      ),
    )
  const collectionTabs = of('collectionTab', (p) => p.contributes.collectionTabs)
  // Actions on a document read it: only for plugins approved to read documents.
  const documentActions = of('documentAction', (p) =>
    p.permissions.includes('documents:read') ? p.contributes.documentActions : [],
  )
  const sidebarPanels = of('sidebarPanel', (p) => p.contributes.sidebarPanels)
  /** Cell renderers see the values shown: only plugins approved to read documents. */
  const cellPlugins = computed(() =>
    runtime.value.filter(
      (p) => p.contributes.cellRenderers.length && p.permissions.includes('documents:read'),
    ),
  )
  const byKey = (key: string): Contribution | undefined =>
    [...collectionTabs.value, ...documentActions.value, ...sidebarPanels.value].find((c) => c.key === key)

  /**
   * User request 2026-11-02: SQL import and export (the SQL ↔ MongoDB page and its menus) come with
   * the SQL → MongoDB plugin, offered only while it runs.
   */
  const sqlOffered = computed(() => runtime.value.some((p) => p.id === 'sql-to-mongodb'))

  /** A plugin's page (its sidebar entry): a tab of the same id is another thing (found by e2e). */
  const pageOf = (plugin: string, contribution: string): Contribution | undefined =>
    sidebarPanels.value.find((c) => c.plugin.id === plugin && c.id === contribution)

  function setRuntime(list: PluginRuntimeView[]): void {
    runtime.value = list
    runtimeKnown.value = true
  }
  function setRenderer(id: string, bridge: Bridge | null): void {
    const next = new Map(renderers.value)
    if (bridge) next.set(id, bridge)
    else next.delete(id)
    renderers.value = next
  }
  return {
    runtime,
    runtimeKnown,
    chosen,
    choose,
    renderers,
    collectionTabs,
    documentActions,
    sidebarPanels,
    cellPlugins,
    sqlOffered,
    byKey,
    pageOf,
    setRuntime,
    setRenderer,
  }
})

/** What a plugin page's chosen collection is known by. */
export const targetKey = (
  plugin: string,
  contribution: string,
  t: { connectionId: string; db: string; coll: string },
) => JSON.stringify([plugin, contribution, t.connectionId, t.db, t.coll])
