// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/**
 * Review of K+R2 (C1): a menu that is not focusable cannot be reached with Tab, and its actions (hide,
 * drop, export) were then out of a keyboard's reach. Every DsMenu is focusable, but a tree row's: the
 * row is the stop, and its menu opens with the context-menu key or Shift+F10.
 */
const SRC = join(import.meta.dirname, '..', 'src')
// The document page's tree (final review I6, 2026-11-04) is as the workspace tree: the line is the
// stop, and Shift+F10 or the Menu key opens its menu.
const EXEMPT = new Set(['workspace/tree/TreeRow.vue', 'documents/page/DocumentTreeView.vue'])
/**
 * W6.1: a tab's own menu (TabStrip) is as a tree row's: the tab is the stop (one in the Tab order,
 * arrows between them) and the Menu key or Shift+F10 opens it — marked by `data-tab-menu`.
 */
const OPENED_BY_ITS_TAB = /(?:^|\s)data-tab-menu(?=\s|$)/
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith('.vue') ? [join(dir, e.name)] : [],
  )

describe('every menu can be reached with the keyboard', () => {
  it('marks each DsMenu focusable', () => {
    const unreachable: string[] = []
    for (const file of files(SRC)) {
      const name = relative(SRC, file).split(sep).join('/')
      if (EXEMPT.has(name)) continue
      const source = readFileSync(file, 'utf8')
      for (const m of source.matchAll(/<DsMenu\b([^>]*?)\/?>/gs))
        // `focusable` alone or bound to true; `:focusable="false"` (or any other value) does not count.
        if (
          !/(?:^|\s)(?::?focusable)(?:="true")?(?=\s|$)/.test(m[1]!) &&
          !(name === 'workspace/TabStrip.vue' && OPENED_BY_ITS_TAB.test(m[1]!))
        )
          unreachable.push(`${name}:${source.slice(0, m.index).split('\n').length}`)
    }
    expect(unreachable).toEqual([])
  })
})
