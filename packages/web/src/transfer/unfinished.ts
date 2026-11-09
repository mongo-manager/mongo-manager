// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
type Translate = (key: string, values: Record<string, unknown>, plural?: number) => string

/**
 * Data review 2026-10-13 (low): what an import that did not finish wrote, and what it read but never
 * wrote — so it is not run again with Insert blind.
 */
export function unfinishedText(
  t: Translate,
  n: (v: number) => string,
  u: { written: number; notWritten: number; uncertain?: number },
): string {
  const written = t('dataTransfer.report.unfinishedWritten', { n: n(u.written) }, u.written)
  const notWritten = t('dataTransfer.report.unfinishedNotWritten', { n: n(u.notWritten) }, u.notWritten)
  const line = u.notWritten
    ? t('dataTransfer.report.unfinishedBoth', { written, notWritten })
    : t('dataTransfer.report.unfinished', { written })
  // Review of the data fixes (I4): a batch the server failed as a whole — never "not written".
  if (!u.uncertain) return line
  return `${line} ${t('dataTransfer.report.unfinishedUncertain', { n: n(u.uncertain) }, u.uncertain)}`
}
