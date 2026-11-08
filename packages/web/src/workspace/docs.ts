// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
/** A page of the offline docs (spec §3.6) in a language: English at the top, the others in theirs. */
export const docsPage = (locale: string, page: string): string =>
  locale === 'en' || !/^[a-z]{2}$/.test(locale) ? `docs/${page}` : `docs/${locale}/${page}`

/** The offline docs shipped with the app (spec §3.6), in the current language, in a new window. */
export function openDocs(locale: string): void {
  window.open(new URL(docsPage(locale, 'index.html'), document.baseURI).href, '_blank', 'noopener,noreferrer')
}
