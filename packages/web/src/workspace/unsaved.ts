import { onBeforeUnmount, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useCollectionViewsStore } from '@/stores/collectionViews'
import { useDialogStore } from '@/stores/dialogs'
import { useTabsStore } from '@/stores/tabs'
import { useTabWorkStore } from '@/stores/tabWork'
import { useTabSectionsStore } from '@/stores/tabSections'
import { useToastStore } from '@/stores/toasts'

/**
 * Reviewer B I1: unsaved document edits live with their tab. Closing that tab asks first, and so does
 * the browser when the page is left while any tab holds them — or other work a tab would lose (a SQL
 * dump read, an import running: review 2026-10-11).
 */
export function useTabClose(): (id: string) => Promise<void> {
  const tabs = useTabsStore()
  const views = useCollectionViewsStore()
  const dialogs = useDialogStore()
  const work = useTabWorkStore()
  const { t } = useI18n()
  return async (id) => {
    if (
      work.has(id) &&
      !(await dialogs.confirm({
        title: t('sqlTransfer.leave.title'),
        message: t('sqlTransfer.leave.message'),
        confirmLabel: t('sqlTransfer.leave.confirm'),
        danger: true,
      }))
    )
      return
    if (
      views.hasUnsaved(id) &&
      !(await dialogs.confirm({
        title: t('connection.discardTitle'),
        message: t('editor.unsaved'),
        confirmLabel: t('connection.discard'),
        danger: true,
      }))
    )
      return
    tabs.close(id)
  }
}

/**
 * User request 2026-10-12: a database's group closes all its tabs; user request 2026-10-23: the
 * others than one (no `db`). When any of them holds unsaved edits or work in progress, it asks once
 * for them all; otherwise it says so with Undo, which puts them back where they were with what they
 * showed (review 2026-10-12, minor 19). A shell or a plugin's page is work in progress too: its
 * session goes with it, and Undo would bring back an empty one (review of the tabs, I1).
 */
export function useTabsClose(): (ids: readonly string[], db?: string) => Promise<void> {
  const tabs = useTabsStore()
  const views = useCollectionViewsStore()
  const sections = useTabSectionsStore()
  const dialogs = useDialogStore()
  const work = useTabWorkStore()
  const toasts = useToastStore()
  const { t } = useI18n()
  return async (ids, db) => {
    const losing = ids.some(
      (id) =>
        work.has(id) ||
        views.hasUnsaved(id) ||
        tabs.tabs.some((tab) => tab.id === id && (tab.kind === 'shell' || tab.kind === 'pluginPage')),
    )
    if (
      losing &&
      !(await dialogs.confirm({
        title: t('tabs.group.closeTitle', { n: ids.length }, ids.length),
        message: t('tabs.group.closeUnsaved'),
        confirmLabel: t('tabs.group.closeConfirm'),
        danger: true,
      }))
    )
      return
    // What each tab shows (its query, page, section), kept to give back with Undo.
    const kept = ids.map((id) => ({ id, view: views.states[id], section: sections.sections[id] }))
    const closed = tabs.closeMany(ids)
    if (losing || closed.length === 0) return
    toasts.push({
      kind: 'info',
      message:
        db === undefined
          ? t('tabs.menu.closedOthers', { n: closed.length }, closed.length)
          : t('tabs.group.closed', { n: closed.length, db }, closed.length),
      actions: [
        {
          label: t('tabs.group.undo'),
          run: () => {
            tabs.restore(closed)
            for (const { id, view, section } of kept) {
              if (view) views.states[id] = view
              if (section !== undefined) sections.set(id, section)
            }
          },
        },
      ],
    })
  }
}

export function useLeaveGuard(): void {
  const views = useCollectionViewsStore()
  const work = useTabWorkStore()
  const onBeforeUnload = (event: BeforeUnloadEvent) => {
    if (views.anyUnsaved() || work.any()) event.preventDefault()
  }
  onMounted(() => window.addEventListener('beforeunload', onBeforeUnload))
  onBeforeUnmount(() => window.removeEventListener('beforeunload', onBeforeUnload))
}
