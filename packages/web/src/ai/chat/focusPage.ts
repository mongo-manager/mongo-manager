// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
/**
 * Sixth review of the floating window (M-2, M-3): focus handed to the page (its main region) when the
 * assistant goes away with focus in it — made focusable for that only, until focus leaves it.
 */
export function focusPage(): void {
  const main = document.getElementById('main')
  if (!main) return
  const added = !main.hasAttribute('tabindex')
  const undo = () => main.removeAttribute('tabindex')
  if (added) {
    main.setAttribute('tabindex', '-1')
    main.addEventListener('blur', undo, { once: true })
  }
  main.focus({ preventScroll: true })
  // Seventh review (N-1): where focus could not land, nothing is left behind.
  if (added && document.activeElement !== main) {
    main.removeEventListener('blur', undo)
    undo()
  }
}

/**
 * Sixth review (I-3): a popup of the page closed as its own Escape closes it — a menu or popover (its
 * root handles the key) or a combobox (its field does), each stopping the key there.
 */
export function closePagePopup(windowEl: Element | null, isOwn: (el: Element) => boolean): void {
  const active = document.activeElement as HTMLElement | null
  if (!active || active === document.body || windowEl?.contains(active) || isOwn(active)) return
  const combobox =
    active.getAttribute('role') === 'combobox' && active.getAttribute('aria-expanded') === 'true'
  if (combobox || active.closest('[data-ds-popup]'))
    active.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
}
