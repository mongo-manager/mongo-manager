// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import {
  REBINDABLE_ACTIONS,
  SHORTCUT_GROUPS,
  ShortcutBindingsSchema,
  bindingProblem,
  comboId,
  effectiveKeys,
  pairOf,
} from '../src/browser'

/** W5 (completion §2 W5.3): customizable shortcuts — what a user may bind, checked alike everywhere. */
const parse = (bindings: unknown) => ShortcutBindingsSchema.safeParse({ bindings })

describe('rebindable shortcuts', () => {
  it('marks the global shortcuts, and only those, as rebindable', () => {
    const rebindable = SHORTCUT_GROUPS.flatMap((g) =>
      g.items.filter((s) => s.rebindable).map((s) => s.action),
    )
    expect(rebindable.sort()).toEqual([...REBINDABLE_ACTIONS].sort())
    // Editor, list and terminal keys stay as they are.
    for (const id of ['editing', 'shell', 'tree', 'table', 'assistant', 'navigation'])
      expect(SHORTCUT_GROUPS.find((g) => g.id === id)!.items.some((s) => s.rebindable)).toBe(false)
  })

  it('accepts what ships, and a free combination', () => {
    for (const action of REBINDABLE_ACTIONS)
      expect(bindingProblem(action, effectiveKeys(action, {}), {}), action).toBeNull()
    expect(parse({ palette: [['Mod', 'Shift', 'K']] }).success).toBe(true)
    expect(parse({ tabReorder: pairOf(['Alt', 'Shift', '←']) }).success).toBe(true)
    expect(parse({}).success).toBe(true)
  })

  it('refuses a combination another shortcut has, fixed or rebound', () => {
    // The shell's Ctrl+R, the query editor's Mod+Enter (reserved too), the tree's Shift+F10.
    expect(bindingProblem('palette', [['Mod', 'R']], {})).toEqual({ reason: 'reserved' })
    expect(bindingProblem('library', [['Mod', 'Shift', 'F']], {})).toEqual({
      reason: 'conflict',
      with: 'focusMode',
    })
    expect(bindingProblem('library', [['Alt', 'B']], {})).toEqual({ reason: 'conflict', with: 'shellWord' })
    expect(bindingProblem('library', [['Mod', 'U']], {})).toEqual({ reason: 'reserved' })
    // Rebound: the old keys are free, the new ones taken.
    const bound = { palette: [['Mod', 'Shift', 'K']], navigator: [['Mod', 'Shift', 'B']] }
    expect(bindingProblem('library', [['Mod', 'B']], bound)).toBeNull()
    // Mod+K, freed by the palette, is still the terminal's Ctrl+K for another action.
    expect(bindingProblem('library', [['Mod', 'K']], bound)).toEqual({
      reason: 'conflict',
      with: 'shellKillLine',
    })
    expect(bindingProblem('library', [['Mod', 'Shift', 'K']], bound)).toEqual({
      reason: 'conflict',
      with: 'palette',
    })
    expect(parse({ palette: [['Mod', 'Shift', 'K']], library: [['Mod', 'Shift', 'K']] }).success).toBe(false)
    // Even what ships, while another action holds it.
    expect(bindingProblem('palette', [['Mod', 'K']], { library: [['Mod', 'K']] })).toEqual({
      reason: 'conflict',
      with: 'library',
    })
  })

  it('refuses the browser’s and editing’s keys, and plain keys that would fire while typing', () => {
    for (const combo of [
      ['Mod', 'C'],
      ['Mod', 'V'],
      ['Mod', 'W'],
      ['Mod', 'Shift', 'I'],
      ['F5'],
      ['Alt', '←'],
    ])
      expect(bindingProblem('palette', [combo], {}), combo.join('+')).toEqual({ reason: 'reserved' })
    for (const combo of [['K'], ['Shift', 'K'], ['/'], ['←'], ['Enter']])
      expect(bindingProblem('palette', [combo], {}), combo.join('+')).toMatchObject({
        reason: expect.stringMatching(/needsModifier|conflict/),
      })
    expect(bindingProblem('palette', [['F8']], {})).toBeNull()
    // The document tree's rename (document page, 2026-11-04) has F2: it stays its own.
    expect(bindingProblem('palette', [['F2']], {})).toEqual({ reason: 'conflict', with: 'documentRename' })
  })

  // Review I4: a bare ? fires while typing in any field that lets it through; only the list it opens
  // (which checks for typing itself) may have it.
  it('allows a bare ? only for the shortcut list', () => {
    expect(bindingProblem('shortcuts', [['?']], {})).toBeNull()
    for (const action of ['palette', 'askAi', 'library', 'assistant'] as const)
      expect(bindingProblem(action, [['?']], { shortcuts: [['F2']] }), action).toEqual({
        reason: 'needsModifier',
      })
  })

  // Review (minor): more of the browser's and the system's keys, on every platform (Mod is ⌘ on a Mac).
  it('keeps tab switching, zoom, minimise and history keys for the browser', () => {
    for (const combo of [
      ['Mod', 'PageUp'],
      ['Mod', 'PageDown'],
      ['Mod', 'Shift', 'PageUp'],
      ['Mod', 'Shift', 'PageDown'],
      ...['1', '2', '5', '9'].map((d) => ['Mod', d]),
      ['Mod', 'Shift', 'Q'],
      ['Shift', 'F5'],
      ['Mod', 'F5'],
      ['Mod', '['],
      ['Mod', ']'],
      ['Mod', '←'],
      ['Mod', '→'],
      ['Mod', 'M'],
      ['Mod', '`'],
    ])
      expect(bindingProblem('palette', [combo], {}), combo.join('+')).toEqual({ reason: 'reserved' })
  })

  // W6b merge: split view's key is rebindable and taken while it has it; the tab menu's are fixed.
  it('knows split view and the tab menu', () => {
    expect(REBINDABLE_ACTIONS).toContain('splitView')
    expect(bindingProblem('palette', [['Mod', '\\']], {})).toEqual({ reason: 'conflict', with: 'splitView' })
    expect(bindingProblem('splitView', [['Mod', 'Shift', '\\']], {})).toBeNull()
    expect(bindingProblem('palette', [['Mod', '\\']], { splitView: [['Mod', 'Shift', '\\']] })).toBeNull()
    expect(bindingProblem('palette', [['Shift', 'F10']], {})).toMatchObject({ reason: 'conflict' })
    expect(parse({ splitView: [['Mod', 'Shift', '\\']] }).success).toBe(true)
  })

  it('binds a pair with the same modifiers on ← and →', () => {
    expect(bindingProblem('tabReorder', [['Alt', 'Shift', 'K']], {})).toEqual({ reason: 'pairKey' })
    expect(parse({ tabReorder: [['Alt', 'Shift', '←']] }).success).toBe(false)
    expect(
      parse({
        tabReorder: [
          ['Alt', 'Shift', '←'],
          ['Mod', '→'],
        ],
      }).success,
    ).toBe(false)
    expect(
      parse({
        tabReorder: [
          ['Alt', 'Shift', '→'],
          ['Alt', 'Shift', '←'],
        ],
      }).success,
    ).toBe(false)
    expect(
      parse({
        palette: [
          ['Mod', 'Shift', 'K'],
          ['Mod', 'Shift', 'J'],
        ],
      }).success,
    ).toBe(false)
  })

  it('takes only known actions, modifiers and keys, bounded (abuse cases)', () => {
    for (const bindings of [
      { unknown: [['Mod', 'K']] },
      { shellCancel: [['Mod', 'Shift', 'K']] },
      { palette: [['Ctrl', 'Shift', 'K']] },
      { palette: [['Shift', 'Mod', 'K']] },
      { palette: [['Mod', 'Mod', 'K']] },
      { palette: [['Mod', 'k']] },
      { palette: [['Mod', '<script>']] },
      { palette: [['Mod', ' ']] },
      { palette: [['Mod', 'Shift', 'Alt', 'K', 'J']] },
      { palette: [] },
      { palette: 'Mod+K' },
      { palette: [['Mod', 'Ä']] },
    ])
      expect(parse(bindings).success, JSON.stringify(bindings)).toBe(false)
    expect(ShortcutBindingsSchema.safeParse({ bindings: {}, extra: 1 }).success).toBe(false)
  })

  it('compares Ctrl and Mod as one, modifiers in any order', () => {
    expect(comboId(['Ctrl', 'K'])).toBe(comboId(['Mod', 'K']))
    expect(comboId(['Shift', 'Mod', 'K'])).toBe('mod+shift+k')
  })
})
