// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
/**
 * Phase 3a-1 spec §10.1: nothing reaches the terminal except through writeSafe. Any control byte
 * that could drive the terminal — C0 (except the newline and tab we allow), DEL, C1, and the bidi
 * overrides/isolates — is rendered as a visible escape, so a document, a server message or user
 * output can never form an escape sequence (no OSC 52 clipboard write, no title change, no
 * "Trojan Source" bidi reordering). Colours come only from the app's own SGR constants elsewhere.
 */

function escapeChar(code: number): string {
  // \xNN for the C0/C1/DEL range, \uNNNN for the bidi controls.
  if (code <= 0xff) return `\\x${code.toString(16).padStart(2, '0')}`
  return `\\u${code.toString(16).padStart(4, '0')}`
}

const BIDI = new Set([0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069])

/**
 * The characters that show nothing — what Unicode counts as default-ignorable: zero-width spaces and
 * joiners, direction marks, word joiners, variation selectors, Hangul fillers, the BOM, tag characters
 * (used to smuggle text), the soft hyphen — as their escapes, for the code being typed: a snippet
 * cannot hide one in a name there (review 2026-10-12, M4; second review, minor 17). Output keeps them
 * (an emoji's joiner is part of how it shows).
 */
const INVISIBLE = /[\p{Default_Ignorable_Code_Point}\u061c]/gu
const unicodeEscape = (code: number) =>
  code > 0xffff ? `\\u{${code.toString(16)}}` : `\\u${code.toString(16).padStart(4, '0')}`
export const revealInvisible = (text: string): string =>
  text.replace(INVISIBLE, (ch) => unicodeEscape(ch.codePointAt(0)!))

export function writeSafe(text: string): string {
  let out = ''
  for (const ch of text) {
    const code = ch.codePointAt(0)!
    if (ch === '\n') {
      out += '\r\n'
    } else if (ch === '\t') {
      out += '\t'
    } else if (
      code < 0x20 ||
      code === 0x7f ||
      (code >= 0x80 && code <= 0x9f) ||
      // A lone surrogate (an unpaired half); a valid pair iterates as one code point > 0xffff.
      (code >= 0xd800 && code <= 0xdfff) ||
      BIDI.has(code)
    ) {
      out += escapeChar(code)
    } else {
      out += ch
    }
  }
  return out
}
