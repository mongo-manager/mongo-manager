import { computed, nextTick, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useTabsStore, type PaneSide, type SplitState } from '@/stores/tabs'
import { useLayoutStore } from '@/stores/layout'
import { useToastStore } from '@/stores/toasts'

/**
 * completion W6.1: split view — two tabs side by side.
 *
 * Ruling (2026-10-16): one tab strip with a pane marker on the two tabs shown, not a strip per pane.
 * The strip already gathers a database's tabs into one; two strips would split those groups and the
 * "All tabs" list in two. As in VS Code, a tab chosen in the strip opens in the pane in use, and a
 * pane's own tab, chosen, puts the focus there. Each pane has a slim header naming its tab, with
 * "Close pane"; the pane in use has the accent bar and says "Active pane". Overview and a window
 * narrower than 768 px hide the split without ending it (review I3, minor 7).
 */

/** The tab being dragged from the strip (the drop zone at the workspace's right edge takes it). */
export const draggingTab = ref<string | null>(null)
/** The drag's data type: only the app's own tabs are dropped beside. */
export const TAB_DRAG_TYPE = 'application/x-mongo-manager-tab'

/**
 * Re-review minor 3: the control that last had the focus in each tab's frame, to give it back when
 * the keyboard returns to that pane. Forgotten once it leaves the page.
 */
const lastFocused = new Map<string, HTMLElement>()
export function rememberFocus(tabId: string, el: EventTarget | null): void {
  if (el instanceof HTMLElement && !el.matches('[data-workspace-frame]')) lastFocused.set(tabId, el)
}

/** The frame the tab in use is shown in (a pane's region, or the one tab's frame). */
function frameOf(tabId: string): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>('[data-workspace-frame]')].find(
    (el) => el.dataset.tabId === tabId,
  )
}

export function useSplitView() {
  const tabs = useTabsStore()
  const layout = useLayoutStore()
  const toasts = useToastStore()
  const { t } = useI18n()
  /** The split as shown: none on Overview or below the md width (it is kept for later). */
  const panes = computed<SplitState | null>(() => (layout.splitAllowed ? tabs.panes : null))
  /** The pane a tab is shown in, as shown. */
  const paneOf = (id: string): PaneSide | null => (panes.value ? tabs.paneOf(id) : null)
  /** A tab on screen: the one in use, or the other pane's. */
  const shown = (id: string): boolean => tabs.activeId === id || paneOf(id) !== null

  /** Review I3: the keyboard's focus goes to the frame of the tab in use (a pane's region). */
  async function focusInUse(): Promise<void> {
    await nextTick()
    const frame = frameOf(tabs.activeId)
    if (!frame) return
    const kept = lastFocused.get(tabs.activeId)
    if (kept && kept.isConnected && frame.contains(kept)) kept.focus({ preventScroll: true })
    else {
      lastFocused.delete(tabs.activeId)
      frame.focus({ preventScroll: true })
    }
  }
  /** What Mod+\ may change: the tab in use and the panes (re-review minor 3: nothing, no focus move). */
  const state = () => `${tabs.activeId}\n${panes.value ? `${panes.value.left}\n${panes.value.right}` : ''}`

  /** Opens a tab beside the one in use; below the md width, or with nothing beside it, just shows it. */
  function openBeside(id: string): void {
    if (!layout.splitAllowed) return tabs.activate(id)
    if (!tabs.openBeside(id)) toasts.push({ kind: 'info', message: t('split.nothingBeside') })
  }

  /**
   * Mod+\: the tab in use beside the one before it; with a split, the other pane. On Overview the
   * split kept comes back, or the two tabs used last go side by side (review minor 6).
   */
  function toggle(): void {
    const was = state()
    const s = panes.value
    if (s) tabs.focusPane(s.focus === 'left' ? 'right' : 'left')
    else if (tabs.active?.kind !== 'welcome') openBeside(tabs.activeId)
    else if (tabs.split && layout.splitAllowed) tabs.activate(tabs.split[tabs.split.focus])
    else {
      const [last] = tabs.recentTabs()
      if (last) openBeside(last)
      else toasts.push({ kind: 'info', message: t('split.nothingBeside') })
    }
    if (state() !== was) void focusInUse()
  }

  /** "Close pane": the other pane's tab stays in use, and the focus with it. */
  function closePane(side: PaneSide): void {
    tabs.closePane(side)
    void focusInUse()
  }

  return { panes, paneOf, shown, openBeside, toggle, closePane, focusInUse }
}
