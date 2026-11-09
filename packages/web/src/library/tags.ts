// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { MAX_TAGS, checkTag } from '@mongo-manager/shared/browser'

export interface ParsedTags {
  tags: string[]
  /** The first tag the server would refuse, as typed, and why. */
  invalid?: string
  error?: 'chars' | 'long' | 'many'
}

/**
 * Phase 2c: tags as typed ("#Hot, q3 hot") into what the server keeps (["hot", "q3"]), checked as
 * the server checks them, so a refused tag is named beside the field (final review 2c, I3).
 */
export function parseTags(text: string): ParsedTags {
  const tags: string[] = []
  for (const part of text.split(/[\s,]+/)) {
    if (!part.replace(/^#+/, '')) continue
    const checked = checkTag(part)
    if ('error' in checked) {
      if (checked.error === 'empty') continue
      return { tags, invalid: part, error: checked.error }
    }
    if (!tags.includes(checked.tag)) tags.push(checked.tag)
  }
  if (tags.length > MAX_TAGS) return { tags, error: 'many' }
  return { tags }
}

/** The message for a refused tag. */
export function tagError(
  t: (key: string, values?: Record<string, unknown>) => string,
  parsed: ParsedTags,
): string {
  if (!parsed.error) return ''
  if (parsed.error === 'many') return t('library.tagMany', { max: MAX_TAGS })
  return t(parsed.error === 'long' ? 'library.tagLong' : 'library.tagChars', { tag: parsed.invalid })
}
