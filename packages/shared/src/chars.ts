// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
/**
 * Characters that hide, reverse, fake or blank text, apart from any schema (no zod): what text a
 * plugin, a file or a person hands the app may not hold. Re-exported by api/gridfs.ts, where they began.
 */
/**
 * Characters a name may not hold: C0 and C1 controls, and those that make a name look like
 * another — bidirectional marks, embeddings, overrides and isolates — and line or paragraph
 * separators (4b review: "invoice<RLO>fdp.exe" shows as "invoiceexe.pdf").
 */
export function isSpoofingChar(code: number): boolean {
  return (
    code < 0x20 ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x061c ||
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x2028 && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  )
}

/**
 * Security audit 2026-10-16 (M2): characters that show as nothing — zero-width spaces and joiners,
 * word joiners and invisible operators, the soft hyphen, combining grapheme joiner, Hangul and
 * Mongolian fillers, variation selectors, the byte-order mark, interlinear annotation and musical
 * format marks, tag characters. Kept apart from isSpoofingChar: an emoji is drawn with a joiner and
 * a variation selector, so a file's name may hold them; text a plugin hands the app may not.
 */
export function isInvisibleChar(code: number): boolean {
  return (
    code === 0x00ad ||
    code === 0x034f ||
    code === 0x115f ||
    code === 0x1160 ||
    code === 0x17b4 ||
    code === 0x17b5 ||
    (code >= 0x180b && code <= 0x180f) ||
    (code >= 0x200b && code <= 0x200d) ||
    (code >= 0x2060 && code <= 0x2064) ||
    (code >= 0x206a && code <= 0x206f) ||
    code === 0x3164 ||
    (code >= 0xfe00 && code <= 0xfe0f) ||
    code === 0xfeff ||
    code === 0xffa0 ||
    (code >= 0xfff9 && code <= 0xfffb) ||
    // Review of the security pass: the braille blank, shorthand and hieroglyph format controls.
    code === 0x2800 ||
    (code >= 0x13430 && code <= 0x1343f) ||
    (code >= 0x1bca0 && code <= 0x1bca3) ||
    (code >= 0x1d173 && code <= 0x1d17a) ||
    (code >= 0xe0000 && code <= 0xe007f) ||
    (code >= 0xe0100 && code <= 0xe01ef)
  )
}

/** What hides, reverses, fakes or blanks text: isSpoofingChar's and the invisible characters. */
export const isHiddenChar = (code: number): boolean => isSpoofingChar(code) || isInvisibleChar(code)

const PICTOGRAPHIC = /^\p{Extended_Pictographic}$/u
const EMOJI_PART = /^[\p{Extended_Pictographic}\p{Emoji_Modifier}\ufe0f]$/u
/**
 * Whether the character at `i` of `chars` (code points) hides anything — isHiddenChar, except an
 * emoji's own presentation selector (U+FE0F after a pictograph) and joiner (U+200D between two of
 * its parts): U+1F469 U+200D U+1F4BB (a woman technologist) hides nothing (review of the security pass).
 */
export function isHiddenAt(chars: readonly string[], i: number): boolean {
  const code = chars[i]!.codePointAt(0)!
  if (!isHiddenChar(code)) return false
  const before = chars[i - 1] ?? ''
  // A keycap is a digit, the selector and U+20E3.
  if (code === 0xfe0f) return !PICTOGRAPHIC.test(before) && chars[i + 1] !== '\u20e3'
  if (code === 0x200d) return !(EMOJI_PART.test(before) && PICTOGRAPHIC.test(chars[i + 1] ?? ''))
  return true
}
