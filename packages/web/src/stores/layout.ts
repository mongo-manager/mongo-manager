import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

/**
 * UI redesign R1 revision 2 §3.1, §3.6: the sidebar's size and state, and focus mode. Interface state
 * only (plan ruling 7).
 */
const KEY = 'mm:layout'
export const SIDEBAR_MIN = 220
export const SIDEBAR_MAX = 360
export const SIDEBAR_DEFAULT = 260
const NARROW = '(max-width: 1023px)'
/** UI redesign R1 revision 2 §4.5: the inspector drawer; below 1280 px it floats over the results. */
export const INSPECTOR_MIN = 360
export const INSPECTOR_MAX = 760
export const INSPECTOR_DEFAULT = 460
const INSPECTOR_OVERLAY = '(max-width: 1279px)'
/** W6.1: below the md breakpoint (768 px) two tabs side by side would not fit; split view is off. */
const NO_SPLIT = '(max-width: 767px)'
/** The sidebar's element id (its toggles control it). */
export const SIDEBAR_ID = 'sidebar'

/** Where the groups' state was once kept; it is forgotten now (user request 2026-10-10). */
const OLD_GROUPS_KEY = 'mm:sidebar-groups'
function forgetOldGroups(): void {
  try {
    localStorage.removeItem(OLD_GROUPS_KEY)
  } catch {
    // storage blocked: nothing was kept either
  }
}

const clamp = (n: number) => Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, n)))
const clampInspector = (n: number) => Math.round(Math.min(INSPECTOR_MAX, Math.max(INSPECTOR_MIN, n)))
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

function load(): { sidebarCollapsed: boolean; sidebarWidth: number; inspectorWidth: number } {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, unknown>
    return {
      sidebarCollapsed: parsed.sidebarCollapsed === true,
      sidebarWidth: finite(parsed.sidebarWidth) ? clamp(parsed.sidebarWidth) : SIDEBAR_DEFAULT,
      inspectorWidth: finite(parsed.inspectorWidth)
        ? clampInspector(parsed.inspectorWidth)
        : INSPECTOR_DEFAULT,
    }
  } catch {
    return { sidebarCollapsed: false, sidebarWidth: SIDEBAR_DEFAULT, inspectorWidth: INSPECTOR_DEFAULT }
  }
}

export const useLayoutStore = defineStore('layout', () => {
  const stored = load()
  const sidebarCollapsed = ref(stored.sidebarCollapsed)
  const sidebarWidth = ref(stored.sidebarWidth)
  const inspectorWidth = ref(stored.inspectorWidth)
  /** Below 1280 px the inspector floats over the results instead of taking their room. */
  const inspectorOverlay = ref(false)
  let inspectorMedia: MediaQueryList | null = null
  const onInspectorMedia = (e: MediaQueryListEvent) => {
    inspectorOverlay.value = e.matches
  }
  /** W6.1: whether the window is wide enough for split view (it is kept, only not shown, below). */
  const splitAllowed = ref(true)
  let splitMedia: MediaQueryList | null = null
  const onSplitMedia = (e: MediaQueryListEvent) => {
    splitAllowed.value = !e.matches
  }
  /** Focus mode hides the sidebar and the tab strip; it is never remembered. */
  const focusMode = ref(false)
  /**
   * The sidebar's groups: closed until opened, and open while they hold the active place unless the
   * user closed them. Not kept past a reload (user request 2026-10-10): a reload opens only the
   * group holding the open page.
   */
  forgetOldGroups()
  const groups = ref<Record<string, boolean>>({})
  const isGroupOpen = (id: string, holdsActive = false) => groups.value[id] ?? holdsActive
  function toggleGroup(id: string, holdsActive = false): void {
    groups.value = { ...groups.value, [id]: !isGroupOpen(id, holdsActive) }
  }
  /** Below 1024 px the sidebar is an overlay, closed until asked for (spec §5). */
  const narrow = ref(false)
  const overlayOpen = ref(false)
  /** Whether the sidebar is on screen at all (expanded or as a rail, or the open overlay). */
  const sidebarShown = computed(() => !focusMode.value && (narrow.value ? overlayOpen.value : true))
  let media: MediaQueryList | null = null
  const onMedia = (e: MediaQueryListEvent) => {
    narrow.value = e.matches
    overlayOpen.value = false
  }

  function persist(): void {
    try {
      localStorage.setItem(
        KEY,
        JSON.stringify({
          sidebarCollapsed: sidebarCollapsed.value,
          sidebarWidth: sidebarWidth.value,
          inspectorWidth: inspectorWidth.value,
        }),
      )
    } catch {
      // storage blocked: the layout is just not remembered
    }
  }
  function start(): void {
    if (media || typeof window.matchMedia !== 'function') return
    media = window.matchMedia(NARROW)
    narrow.value = media.matches
    media.addEventListener('change', onMedia)
    inspectorMedia = window.matchMedia(INSPECTOR_OVERLAY)
    inspectorOverlay.value = inspectorMedia.matches
    inspectorMedia.addEventListener('change', onInspectorMedia)
    splitMedia = window.matchMedia(NO_SPLIT)
    splitAllowed.value = !splitMedia.matches
    splitMedia.addEventListener('change', onSplitMedia)
  }
  function stop(): void {
    media?.removeEventListener('change', onMedia)
    media = null
    inspectorMedia?.removeEventListener('change', onInspectorMedia)
    inspectorMedia = null
    splitMedia?.removeEventListener('change', onSplitMedia)
    splitMedia = null
  }
  /** Mod+B: the overlay below 1024 px, otherwise expanded ↔ rail. */
  function toggleSidebar(): void {
    if (narrow.value) overlayOpen.value = !overlayOpen.value
    else {
      sidebarCollapsed.value = !sidebarCollapsed.value
      persist()
    }
  }
  function closeOverlay(): void {
    overlayOpen.value = false
  }
  function setSidebarWidth(n: number): void {
    sidebarWidth.value = clamp(n)
    persist()
  }
  function setInspectorWidth(n: number): void {
    inspectorWidth.value = clampInspector(n)
    persist()
  }
  function toggleFocus(): void {
    focusMode.value = !focusMode.value
  }
  return {
    sidebarCollapsed,
    sidebarWidth,
    inspectorWidth,
    inspectorOverlay,
    splitAllowed,
    focusMode,
    narrow,
    overlayOpen,
    sidebarShown,
    isGroupOpen,
    toggleGroup,
    start,
    stop,
    toggleSidebar,
    closeOverlay,
    setSidebarWidth,
    setInspectorWidth,
    toggleFocus,
  }
})
