/**
 * Fourth review of the floating window (M-A): a popup (on the body) is the assistant window's own when
 * its trigger — the control naming it in aria-controls — is in the window; any other is the page's.
 */
export function isOwnLayer(windowEl: Element | null, el: Element | null): boolean {
  const layer = el?.closest<HTMLElement>('[data-ds-popup]')
  if (!windowEl || !layer?.id) return false
  // An id list, as aria-controls is (fifth review, nit).
  return [...windowEl.querySelectorAll('[aria-controls]')].some((c) =>
    (c.getAttribute('aria-controls') ?? '').split(/\s+/).includes(layer.id),
  )
}
