// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { checkManifest } from '../src/plugins/folder'
import { manifestOf } from './support/tar'

const message = (over: Record<string, unknown>) => {
  try {
    checkManifest(Buffer.from(manifestOf(over)), 'hello', new Set(['index.html']))
  } catch (e) {
    return (e as Error).message
  }
  throw new Error('accepted')
}
/** A character that ends a line, or controls a terminal, where a log or a message shows it. */
const control = (text: string) =>
  [...text].some((c) => {
    const n = c.codePointAt(0)!
    return n < 0x20 || (n >= 0x7f && n <= 0x9f) || n === 0x2028 || n === 0x2029
  })

/**
 * Review of the awesome list's checks (2026-11-03): a manifest's own keys reach the message that
 * names the field it got wrong, and that message is shown on the Plugins page and printed in logs.
 * A key that is not a plain name is quoted, with what would break a line written as its escape.
 */
describe('a manifest’s refusal', () => {
  it('names a plain field as it is', () => {
    expect(message({ permissions: ['documents:everything'] })).toMatch(
      /^The manifest is not valid: permissions\.0 — /,
    )
  })

  it('quotes a key that is not a plain name, on one line', () => {
    const forged = 'a\n::warning file=README.md::forged\r\u2028\u0085x'
    for (const over of [
      { settings: { [forged]: { type: 'boolean', title: { en: 'A' } } } },
      { [forged]: 1 },
      { name: { en: 'Hello', [forged]: 'x' } },
    ]) {
      const text = message(over)
      expect(control(text), text).toBe(false)
      expect(text).toMatch(/a\\(?:n|u000a)::warning file=README\.md::forged\\(?:r|u000d)\\u2028\\u0085x/)
    }
  })
})
