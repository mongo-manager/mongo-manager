// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { api, localKeyNow } from './client'

/**
 * Review of the audit fixes (important 1): in local mode the server answers a request only with the
 * page's key, which a link the browser follows on its own (a download) cannot send. Such a link
 * carries a one-time ticket for its path, asked for with the key.
 *
 * Second review (N2): every way an API link is followed gets one — a plain click (asked for then),
 * what the app opens itself (followApiLink: a toast's Download), and what the browser follows without
 * the page (middle-click, "Open in new tab", "Save link as"): the ticket is put in the link's address
 * just before — on its context menu, a press of any button, or the keyboard's focus. The server
 * answers a link that still has none with a page saying where to click it.
 */
let isLocal: () => boolean = () => false

/** How the app knows it runs in local mode (installed by main.ts; tests set it). */
export function setLocalMode(local: () => boolean): void {
  isLocal = local
}

const apiRoot = (doc: Document) => new URL('api/', doc.baseURI)

function isApiLink(url: URL, doc: Document): boolean {
  const root = apiRoot(doc)
  return url.origin === root.origin && url.pathname.startsWith(root.pathname)
}

/** The address with a fresh ticket for its path. */
async function ticketed(href: string, doc: Document): Promise<string> {
  const url = new URL(href, doc.baseURI)
  url.searchParams.delete('mm_link')
  const { ticket } = await api.post<{ ticket: string }>('auth/local/link', { path: url.pathname })
  url.searchParams.set('mm_link', ticket)
  return url.href
}

function follow(href: string, doc: Document, opts: { download?: string | null; newTab?: boolean }): void {
  const link = doc.createElement('a')
  link.href = href
  link.rel = 'noopener'
  link.dataset.mmTicketed = '1'
  if (opts.download !== undefined && opts.download !== null) link.setAttribute('download', opts.download)
  if (opts.newTab) link.target = '_blank'
  link.style.display = 'none'
  // Attached: a detached link is followed without the document's listeners and settings.
  doc.body.append(link)
  link.click()
  link.remove()
}

/** Opens or downloads an API address the app itself follows: with a ticket in local mode. */
export async function followApiLink(
  href: string,
  opts: { download?: string | null; newTab?: boolean } = {},
  doc: Document = document,
): Promise<void> {
  const local = isLocal() && localKeyNow() && isApiLink(new URL(href, doc.baseURI), doc)
  follow(local ? await ticketed(href, doc) : href, doc, opts)
}

export function installLocalLinks(doc: Document, local: () => boolean, failed: () => void): () => void {
  setLocalMode(local)
  const apiAnchor = (target: EventTarget | null): HTMLAnchorElement | null => {
    const anchor = (target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null
    if (!anchor || anchor.dataset.mmTicketed || !isLocal() || !localKeyNow()) return null
    return isApiLink(new URL(anchor.href, doc.baseURI), doc) ? anchor : null
  }
  const onClick = (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0) return
    const anchor = apiAnchor(event.target)
    if (!anchor) return
    event.preventDefault()
    const newTab = event.ctrlKey || event.metaKey || event.shiftKey || anchor.target === '_blank'
    ticketed(anchor.href, doc).then(
      (href) => follow(href, doc, { download: anchor.getAttribute('download'), newTab }),
      () => failed(),
    )
  }
  /** Just before the browser may follow the link on its own: its address gets a fresh ticket. */
  const prepare = (event: Event) => {
    if (event.type === 'pointerdown' && (event as PointerEvent).button === 0) return
    const anchor = apiAnchor(event.target)
    if (!anchor) return
    ticketed(anchor.href, doc).then(
      (href) => anchor.setAttribute('href', href),
      () => undefined,
    )
  }
  doc.addEventListener('click', onClick, true)
  for (const type of ['contextmenu', 'pointerdown', 'focusin']) doc.addEventListener(type, prepare, true)
  return () => {
    doc.removeEventListener('click', onClick, true)
    for (const type of ['contextmenu', 'pointerdown', 'focusin']) doc.removeEventListener(type, prepare, true)
  }
}
