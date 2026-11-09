// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
/**
 * Phase 4a-2 plan ruling 6: the one fence grammar. The web's Markdown and the server's code blocks
 * both count blocks with it, so an action always sits under the block the server parsed.
 */
export const FENCE = /^\s*```\s*([\w-]*)\s*$/

/** Every fenced block in order; a fence line closes an open block, an unclosed one runs to the end. */
export function fencedBlocks(src: string): Array<{ lang: string; text: string }> {
  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  const out: Array<{ lang: string; text: string }> = []
  for (let i = 0; i < lines.length; i++) {
    const open = FENCE.exec(lines[i]!)
    if (!open) continue
    const body: string[] = []
    for (i++; i < lines.length && !FENCE.test(lines[i]!); i++) body.push(lines[i]!)
    out.push({ lang: open[1] ?? '', text: body.join('\n') })
  }
  return out
}
