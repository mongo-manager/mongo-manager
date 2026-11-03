import { nextTick, onBeforeUnmount, watch, type Ref } from 'vue'

// Review of the dialog focus fix: a control kept out of the Tab order (tabindex -1) is not a stop.
const OUT = ':not([tabindex="-1"])'
const FOCUSABLE = [
  `a[href]${OUT}`,
  `button:not([disabled])${OUT}`,
  `input:not([disabled])${OUT}`,
  `select:not([disabled])${OUT}`,
  `textarea:not([disabled])${OUT}`,
  `[tabindex]${OUT}`,
].join(', ')

/** A modal surface while open: its panel and its controls in Tab order. */
interface Surface {
  panel: Ref<HTMLElement | null>
  focusables: () => HTMLElement[]
  /** The control inside that last had the focus. */
  last: HTMLElement | null
  /** A press on the surface's text put the focus on the panel: Tab goes on from there, as browsers do. */
  clicked: boolean
}
/** The open modal surfaces, the last one on top. */
const surfaces: Surface[] = []

/**
 * A focus that fell to the page goes back to the surface on top: not to its own surface, which may
 * be one under another (a dialog over a sheet, a confirm over a dialog).
 */
function reclaim(): void {
  const active = document.activeElement
  if (active && active !== document.body) return
  if (fellFrom && canHold(fellFrom)) return
  // The top surface with a panel (one may be opening, its panel not there yet).
  const top = surfaces.findLast((s) => s.panel.value)
  const el = top?.panel.value
  if (!top || !el) return
  // Back to the control that had it, when it is still there and can take it (a disabled one cannot).
  const back = top.last
  if (back && back !== el && el.contains(back)) {
    back.focus({ preventScroll: true })
    if (document.activeElement === back) return
  }
  // A panel without a tabindex (the command palette's) cannot hold the focus: its first control does.
  if (el.hasAttribute('tabindex')) {
    el.focus({ preventScroll: true })
    top.clicked = false
  } else top.focusables()[0]?.focus({ preventScroll: true })
}

// U12: the focus can fall to the page from anywhere while a surface is open: a change removes the
// control that had it (Next on a sheet's last step; a toast's button, outside the surface), or the
// browser moves it off a control turned disabled (a submit button turned busy: Chrome does that on a
// timer, after the change). Escape and Tab would no longer reach the surface: the focus comes back to
// the top one instead (the kit import dialog stayed open on Escape after a refused import, 2026-10-23).
let later: ReturnType<typeof setTimeout> | undefined
/** Once, a moment later: a second call does not put off the one waiting. */
const soon = () => {
  if (later !== undefined) return
  later = setTimeout(() => {
    later = undefined
    reclaim()
  }, 0)
}
/** Still there and able to take the focus: connected, enabled, shown. */
const canHold = (el: HTMLElement): boolean =>
  el.isConnected && !el.matches(':disabled') && !el.closest('[hidden]') && (el.checkVisibility?.() ?? true)

/**
 * A control of a popup still there, outside every open surface, that the focus fell from (a press on
 * the text of a list, a menu or a popover opened from a surface): the user went there, and the focus
 * is not the surface's to take back while that control can hold it (its popup open); it is once the
 * popup goes, is hidden or its control turns disabled.
 */
let fellFrom: HTMLElement | null = null
const onDocumentFocusOut = (event: FocusEvent) => {
  if (event.relatedTarget) return
  const lost = event.target
  // Only a popup of the kit (a list, a menu, a popover): a toast's or the page's control is not the
  // user going somewhere, and the surface takes the focus back as before.
  fellFrom =
    lost instanceof HTMLElement &&
    lost.closest('[data-ds-popup]') &&
    !surfaces.some((s) => s.panel.value?.contains(lost))
      ? lost
      : null
  if (fellFrom) watchPopup(fellFrom)
  else unwatchPopup()
  soon()
}
const onDocumentFocusIn = () => {
  fellFrom = null
  unwatchPopup()
}

// Review of 293c3d6e: a popup hidden by its style, a class or hidden (not removed) gives the focus
// back. Watched only while a focus fell from one, and only that popup and the boxes above it: the
// page's own styles change all the time and cost nothing then.
const HIDES = ['hidden', 'style', 'class']
let popupWatcher: MutationObserver | null = null
function watchPopup(from: HTMLElement): void {
  unwatchPopup()
  const root = from.closest<HTMLElement>('[data-ds-popup]')
  if (!root || typeof MutationObserver === 'undefined') return
  popupWatcher ??= new MutationObserver(() => soon())
  popupWatcher.observe(root, { attributes: true, subtree: true, attributeFilter: HIDES })
  for (let box = root.parentElement; box && box !== document.documentElement; box = box.parentElement)
    popupWatcher.observe(box, { attributes: true, attributeFilter: HIDES })
}
function unwatchPopup(): void {
  popupWatcher?.disconnect()
}
let watcher: MutationObserver | null = null
function watchPage(): void {
  if (watcher || typeof document === 'undefined') return
  document.addEventListener('focusout', onDocumentFocusOut, true)
  document.addEventListener('focusin', onDocumentFocusIn, true)
  if (typeof MutationObserver === 'undefined') return
  watcher = new MutationObserver((records) => {
    // A control removed has dropped the focus already; one turned disabled drops it a moment later.
    if (records.some((r) => r.type === 'childList')) reclaim()
    if (records.some((r) => r.type === 'attributes')) soon()
  })
  watcher.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['disabled'],
  })
}
function unwatchPage(): void {
  document.removeEventListener('focusout', onDocumentFocusOut, true)
  document.removeEventListener('focusin', onDocumentFocusIn, true)
  fellFrom = null
  unwatchPopup()
  watcher?.disconnect()
  watcher = null
  clearTimeout(later)
  later = undefined
}

/**
 * Focus handling for modal surfaces: focuses the first control when opened, keeps Tab inside,
 * and returns focus to the opener when closed or unmounted (v-if hosts never flip `open`).
 */
export function useModalFocus(panel: Ref<HTMLElement | null>, isOpen: () => boolean) {
  let previouslyFocused: HTMLElement | null = null
  const focusables = () => Array.from(panel.value?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])
  const surface: Surface = { panel, focusables, last: null, clicked: false }
  const enter = () => {
    if (!surfaces.includes(surface)) surfaces.push(surface)
    watchPage()
  }
  const leave = () => {
    const at = surfaces.indexOf(surface)
    if (at >= 0) surfaces.splice(at, 1)
    if (!surfaces.length) unwatchPage()
  }

  function restore(): void {
    const target = previouslyFocused
    previouslyFocused = null
    if (target?.isConnected) target.focus()
  }

  watch(
    isOpen,
    async (open) => {
      if (open) {
        enter()
        previouslyFocused = document.activeElement as HTMLElement | null
        await nextTick()
        // Start on the field marked autofocus, else on the first field; the header's close button
        // comes first in DOM order.
        const field =
          panel.value?.querySelector<HTMLElement>('[autofocus]') ??
          panel.value?.querySelector<HTMLElement>('input:not([type="hidden"]), select, textarea')
        ;(field ?? focusables()[0] ?? panel.value)?.focus()
      } else {
        leave()
        restore()
      }
    },
    { immediate: true },
  )
  onBeforeUnmount(() => {
    leave()
    restore()
  })

  // Which way a Tab the browser carries out is going, while it goes (see trapTab).
  let tabbing: 'forward' | 'back' | null = null
  let tabbed: ReturnType<typeof setTimeout> | undefined
  const onFocusOut = (event: FocusEvent) => {
    // The control the focus leaves (also the one focused when the surface opened).
    if (event.target !== panel.value) surface.last = event.target as HTMLElement
    const to = event.relatedTarget as Node | null
    if (!tabbing || (to && panel.value?.contains(to))) return
    // A Tab from where a click left the focus went out of the surface: back to its first or last control.
    const way = tabbing
    tabbing = null
    setTimeout(() => (way === 'back' ? focusables().at(-1) : focusables()[0])?.focus(), 0)
  }
  const onFocusIn = (event: FocusEvent) => {
    if (event.target === panel.value) return
    surface.last = event.target as HTMLElement
    surface.clicked = false
  }
  const onPointerDown = () => {
    surface.clicked = true
  }
  let detach: (() => void) | null = null
  const stop = () => {
    detach?.()
    detach = null
    clearTimeout(tabbed)
  }
  watch(
    panel,
    (el) => {
      stop()
      if (!el) return
      el.addEventListener('focusout', onFocusOut)
      el.addEventListener('focusin', onFocusIn)
      el.addEventListener('pointerdown', onPointerDown)
      detach = () => {
        el.removeEventListener('focusout', onFocusOut)
        el.removeEventListener('focusin', onFocusIn)
        el.removeEventListener('pointerdown', onPointerDown)
      }
    },
    { flush: 'post' },
  )
  onBeforeUnmount(stop)

  /** Call from the surface's keydown handler; returns true when it handled the event. */
  function trapTab(event: KeyboardEvent): boolean {
    if (event.key !== 'Tab') return false
    const items = focusables()
    const first = items[0]
    const last = items.at(-1)
    const active = document.activeElement
    if (!first || !last || first === last) {
      event.preventDefault()
      first?.focus()
    } else if (active === panel.value && !surface.clicked) {
      // On the surface itself (a fallen focus came back, or Keep editing gave it): to its first or
      // last control, not to the page behind it.
      event.preventDefault()
      ;(event.shiftKey ? last : first).focus()
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    } else {
      // The browser moves the focus, from the control or from where a click left it: should that take
      // it out of the surface, onFocusOut brings it back.
      tabbing = event.shiftKey ? 'back' : 'forward'
      clearTimeout(tabbed)
      tabbed = setTimeout(() => (tabbing = null), 0)
    }
    return true
  }

  return { trapTab }
}
