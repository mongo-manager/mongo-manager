// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { Errors } from '../../errors'

/** JSON with every object's keys in order: two encodings of one value compare equal. */
function stable(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : v,
  )
}

/**
 * Final review of the query parameters (Minor 9): someone shown a saved definition with values
 * hidden from them (another's shared one, a local-mode one) sends back what they were shown when
 * they rename or retag it. The stored definition is then kept as it is (`keep`); one they changed
 * would put "***" where values they never saw were, and is refused. Nothing hidden: theirs to
 * replace (`replace`).
 */
export function maskedEdit(shown: unknown, stored: unknown, sent: unknown, what: string): 'keep' | 'replace' {
  if (stable(shown) === stable(stored)) return 'replace'
  if (stable(shown) === stable(sent)) return 'keep'
  throw Errors.forbidden(
    `This ${what} holds values hidden from you: only someone who may see them can change its query`,
    { reason: 'masked_definition' },
  )
}
