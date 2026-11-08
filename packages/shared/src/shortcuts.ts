// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { z } from 'zod'

/**
 * Every keyboard shortcut the app has, in one list: the `?` sheet, the Shortcuts settings and the
 * docs page show it. Each entry names keys that a component really handles (the handler is named
 * beside it), and alternatives are separate key lists. "Mod" is Ctrl, or ⌘ on a Mac.
 *
 * W5 (completion §2 W5.3): the global shortcuts (`rebindable`) can be rebound by each user; the
 * keys of editors, lists and the terminal stay as they are (they follow the conventions of those
 * controls), but a new binding may not take them.
 */
export interface Shortcut {
  keys: string[][]
  action: string
  /** A global shortcut each user may rebind. */
  rebindable?: true
  /** Bound as a pair: one set of modifiers with ← and → (moving a tab left or right). */
  pair?: true
}

export const SHORTCUT_GROUPS: Array<{ id: string; items: Shortcut[] }> = [
  {
    id: 'general',
    items: [
      { keys: [['Mod', 'K']], action: 'palette', rebindable: true }, // WorkspaceView
      { keys: [['Mod', 'B']], action: 'navigator', rebindable: true }, // WorkspaceView
      { keys: [['Mod', 'Shift', 'F']], action: 'focusMode', rebindable: true }, // WorkspaceView
      { keys: [['Mod', 'Shift', 'P']], action: 'pinPlace', rebindable: true }, // WorkspaceView
      { keys: [['↑'], ['↓']], action: 'paletteMove' }, // CommandPalette
      { keys: [['?']], action: 'shortcuts', rebindable: true }, // WorkspaceView
      { keys: [['Mod', 'Shift', 'L']], action: 'library', rebindable: true }, // WorkspaceView
      { keys: [['Mod', 'I']], action: 'askAi', rebindable: true }, // CollectionTab
      { keys: [['Mod', '.']], action: 'assistant', rebindable: true }, // WorkspaceView
      { keys: [['Escape']], action: 'close' }, // UiModal, UiMenu, UiPopover, CommandPalette
    ],
  },
  {
    id: 'editing',
    items: [
      { keys: [['/']], action: 'focusQuery' }, // QueryComposer
      { keys: [['Enter']], action: 'runQuery' }, // CodeInput (single line)
      { keys: [['Mod', 'Enter']], action: 'submit' }, // CodeInput (multi-line)
      { keys: [['Tab']], action: 'indent' }, // CodeInput (multi-line)
      { keys: [['Escape', 'Tab']], action: 'leaveEditor' }, // CodeInput (multi-line)
      { keys: [['↑'], ['↓']], action: 'completion' }, // CodeInput completion list
      { keys: [['Tab'], ['Enter']], action: 'acceptCompletion' }, // CodeInput completion list
      { keys: [['Escape']], action: 'closeSuggestions' }, // CodeInput completion list
    ],
  },
  {
    id: 'assistant',
    items: [
      { keys: [['Enter']], action: 'chatSend' }, // ChatComposer
      { keys: [['Shift', 'Enter']], action: 'chatNewline' }, // ChatComposer
      { keys: [['Escape']], action: 'chatLeave' }, // ChatComposer
      { keys: [['←'], ['→']], action: 'chatResize' }, // AssistantPanel separator
    ],
  },
  {
    id: 'navigation',
    items: [
      { keys: [['←'], ['→'], ['Home'], ['End']], action: 'sectionTabs' }, // CollectionTab, ConnectionDialog
    ],
  },
  {
    id: 'tabs',
    items: [
      { keys: [['←'], ['→'], ['Home'], ['End']], action: 'tabMove' }, // TabStrip
      { keys: [['Delete']], action: 'tabClose' }, // TabStrip
      {
        keys: [
          ['Mod', 'Shift', '←'],
          ['Mod', 'Shift', '→'],
        ],
        action: 'tabReorder',
        rebindable: true,
        pair: true,
      }, // WorkspaceView
      { keys: [['Mod', '\\']], action: 'splitView', rebindable: true }, // WorkspaceView (W6.1)
      { keys: [['Shift', 'F10'], ['Menu']], action: 'tabMenu' }, // TabStrip: the tab's menu (W6.1)
    ],
  },
  {
    id: 'tree',
    items: [
      { keys: [['↑'], ['↓'], ['Home'], ['End']], action: 'treeMove' }, // ConnectionTree
      { keys: [['→'], ['←']], action: 'treeExpand' }, // TreeRow
      { keys: [['Enter']], action: 'treeOpen' }, // TreeRow
      { keys: [['Space']], action: 'treeToggle' }, // TreeRow
      { keys: [['Shift', 'F10'], ['Menu']], action: 'treeMenu' }, // TreeRow
    ],
  },
  {
    id: 'table',
    items: [
      { keys: [['Enter']], action: 'editCell' }, // DocumentTable
      { keys: [['Enter']], action: 'saveCell' }, // InlineCellEditor
      { keys: [['Escape']], action: 'cancelEdit' }, // InlineCellEditor
      { keys: [['Shift', 'F10'], ['Menu']], action: 'rowMenu' }, // DocumentTable (a cell: its row's menu)
    ],
  },
  {
    // Document page design (user request 2026-11-04): a document opened as the page.
    id: 'document',
    items: [
      {
        keys: [
          ['Alt', '↑'],
          ['Alt', '↓'],
        ],
        action: 'documentStep',
      }, // DocumentPage
      { keys: [['Mod', 'F']], action: 'documentSearch' }, // DocumentPageBody
      { keys: [['Enter'], ['Shift', 'Enter']], action: 'documentMatch' }, // DocumentSearchBar
      {
        keys: [
          ['Mod', 'Z'],
          ['Mod', 'Shift', 'Z'],
        ],
        action: 'documentUndo',
      }, // DocumentPageBody
      { keys: [['Enter']], action: 'documentEditValue' }, // DocumentTreeView
      { keys: [['Alt', 'Shift', 'F']], action: 'documentFormat' }, // DocumentPageBody (the edit view)
      { keys: [['F2']], action: 'documentRename' }, // DocumentTreeView
      { keys: [['Delete']], action: 'documentRemove' }, // DocumentTreeView
      { keys: [['Escape']], action: 'documentBack' }, // DocumentPage
    ],
  },
  {
    // W6.4 (merged with W5): the data model's diagram, while it has the focus.
    id: 'diagram',
    items: [
      { keys: [['+'], ['-']], action: 'diagramZoom' }, // ModelDiagram
      { keys: [['0']], action: 'diagramFit' }, // ModelDiagram
      { keys: [['←'], ['→'], ['↑'], ['↓']], action: 'diagramPan' }, // ModelDiagram
      { keys: [['Enter'], ['Space']], action: 'diagramSelect' }, // ModelDiagram (a collection)
      { keys: [['Escape']], action: 'diagramClear' }, // ModelDiagram
    ],
  },
  {
    id: 'shell',
    items: [
      { keys: [['Enter']], action: 'shellRun' }, // ShellView (or continue while the code may go on)
      { keys: [['Shift', 'Enter']], action: 'shellNewline' }, // ShellView
      { keys: [['Ctrl', 'Enter']], action: 'shellRunNow' }, // ShellView
      { keys: [['Ctrl', 'C']], action: 'shellCancel' }, // ShellView (copies with output selected)
      { keys: [['Ctrl', 'R']], action: 'shellSearch' }, // ShellView reverse history search
      { keys: [['Ctrl', 'L']], action: 'shellClear' }, // ShellView
      { keys: [['↑'], ['↓']], action: 'shellHistory' }, // ShellView (lines, then history)
      { keys: [['Home'], ['End'], ['Ctrl', 'A'], ['Ctrl', 'E']], action: 'shellLineEdges' }, // ShellView
      {
        keys: [
          ['Ctrl', 'U'],
          ['Ctrl', 'K'],
        ],
        action: 'shellKillLine',
      }, // ShellView
      {
        keys: [
          ['Alt', 'B'],
          ['Alt', 'F'],
          ['Ctrl', '←'],
          ['Ctrl', '→'],
        ],
        action: 'shellWord',
      }, // ShellView
      {
        keys: [
          ['Ctrl', 'W'],
          ['Alt', 'D'],
          ['Ctrl', 'Backspace'],
          ['Ctrl', 'Delete'],
        ],
        action: 'shellDeleteWord',
      }, // ShellView
      { keys: [['Tab']], action: 'shellComplete' }, // ShellView
      { keys: [['Shift', 'Tab']], action: 'shellLeave' }, // ShellView
    ],
  },
]

export const REBINDABLE_ACTIONS = [
  'palette',
  'navigator',
  'focusMode',
  'pinPlace',
  'shortcuts',
  'library',
  'askAi',
  'assistant',
  'tabReorder',
  'splitView',
] as const
export type RebindableAction = (typeof REBINDABLE_ACTIONS)[number]
export type ShortcutBindings = Partial<Record<RebindableAction, string[][]>>

const ALL = SHORTCUT_GROUPS.flatMap((g) => g.items)
const byAction = new Map(ALL.map((s) => [s.action, s]))
/** The shortcut of a rebindable action as shipped. */
export const defaultShortcut = (action: RebindableAction): Shortcut => byAction.get(action)!

/** Modifiers, in the order a combination is written. */
export const SHORTCUT_MODIFIERS = ['Mod', 'Alt', 'Shift'] as const
const ARROWS = ['←', '→', '↑', '↓']
const NAMED = [...ARROWS, 'Home', 'End', 'PageUp', 'PageDown', 'Insert', 'Delete', 'Backspace', 'Enter']
const FUNCTION_KEYS = Array.from({ length: 12 }, (_, i) => `F${i + 1}`)
/** One printable character (no space): a letter is written upper-case. */
const PRINTABLE = /^[!-~]$/

/** A key a binding may end in. */
export const isBindableKey = (key: string): boolean =>
  (PRINTABLE.test(key) && !/[a-z]/.test(key)) || NAMED.includes(key) || FUNCTION_KEYS.includes(key)

/**
 * The keys the browser or the system keep, or that editing needs everywhere: a binding never takes
 * them (written as `comboId` writes them).
 */
const RESERVED = new Set(
  [
    // Editing in every field.
    ...['C', 'V', 'X', 'A', 'Z', 'Y'].map((k) => `Mod+${k}`),
    'Mod+Shift+Z',
    'Mod+Shift+V',
    // Tabs, windows, reload, find, print, save, open, history, address bar, zoom.
    ...['W', 'T', 'N', 'Q', 'R', 'L', 'F', 'G', 'P', 'S', 'O', 'H', 'J', 'D', 'U', 'E'].map(
      (k) => `Mod+${k}`,
    ),
    ...['+', '-', '=', '0'].map((k) => `Mod+${k}`),
    ...['T', 'N', 'W', 'R', 'I', 'J', 'C', 'Delete', 'G'].map((k) => `Mod+Shift+${k}`),
    'Mod+Enter',
    'Mod+Tab',
    'Mod+Shift+Tab',
    'Alt+←',
    'Alt+→',
    'Alt+Home',
    'Alt+F4',
    'Alt+Tab',
    'F1',
    'F3',
    'F5',
    'F6',
    'F7',
    'F11',
    'F12',
    // Review (minor): switching tabs, moving tabs, quitting, a hard reload; on a Mac (Mod is ⌘) back
    // and forward, minimise and switching windows.
    'Mod+PageUp',
    'Mod+PageDown',
    'Mod+Shift+PageUp',
    'Mod+Shift+PageDown',
    ...['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => 'Mod+' + d),
    'Mod+Shift+Q',
    'Shift+F5',
    'Mod+F5',
    'Mod+[',
    'Mod+]',
    'Mod+←',
    'Mod+→',
    'Mod+M',
    'Mod+`',
  ].map((id) => id.toLowerCase()),
)

/** A combination written one way, to compare: Ctrl counts as Mod (they are one key off a Mac). */
export function comboId(combo: readonly string[]): string {
  const keys = combo.map((k) => (k === 'Ctrl' ? 'Mod' : k))
  const mods = SHORTCUT_MODIFIERS.filter((m) => keys.slice(0, -1).includes(m))
  return [...mods, keys.at(-1) ?? ''].join('+').toLowerCase()
}

const ComboSchema = z
  .array(z.string().max(12))
  .min(1)
  .max(4)
  .superRefine((combo, ctx) => {
    const mods = combo.slice(0, -1)
    const key = combo.at(-1)!
    const order = mods.map((m) => SHORTCUT_MODIFIERS.indexOf(m as never))
    if (order.some((i) => i < 0) || order.some((i, n) => n > 0 && i <= order[n - 1]!))
      ctx.addIssue({ code: 'custom', message: 'Modifiers are Mod, Alt and Shift, each once, in that order' })
    if (!isBindableKey(key))
      ctx.addIssue({ code: 'custom', message: `${key} is not a key a shortcut can use` })
  })

/** Why a binding cannot be used, or null. Shared by the settings page and the server. */
export type BindingProblem =
  | { reason: 'reserved' }
  | { reason: 'needsModifier' }
  | { reason: 'pairKey' }
  | { reason: 'conflict'; with: string }

/**
 * Checks one action's new combinations against the browser's keys, every fixed shortcut and the
 * other actions' bindings (as they would be). A key without Mod or Alt is allowed only for a function
 * key, or `?` for the shortcut list alone (as shipped; its handler checks for typing): a plain key
 * would fire while typing elsewhere (review I4).
 */
export function bindingProblem(
  action: RebindableAction,
  combos: readonly (readonly string[])[],
  bindings: ShortcutBindings,
): BindingProblem | null {
  const shortcut = defaultShortcut(action)
  // What ships is always allowed back (Mod+K is also the terminal's Ctrl+K, where the terminal has it).
  const shipped = new Set(shortcut.keys.map(comboId))
  if (combos.length > 0 && combos.every((c) => shipped.has(comboId(c)))) {
    const mine = new Set(combos.map(comboId))
    const taken = REBINDABLE_ACTIONS.find(
      (other) => other !== action && effectiveKeys(other, bindings).some((c) => mine.has(comboId(c))),
    )
    return taken ? { reason: 'conflict', with: taken } : null
  }
  for (const combo of combos) {
    const key = combo.at(-1) ?? ''
    if (shortcut.pair && key !== '←' && key !== '→') return { reason: 'pairKey' }
    if (RESERVED.has(comboId(combo))) return { reason: 'reserved' }
    const modified = combo.includes('Mod') || combo.includes('Alt')
    if (
      !modified &&
      !FUNCTION_KEYS.includes(key) &&
      !(key === '?' && combo.length === 1 && action === 'shortcuts')
    )
      return { reason: 'needsModifier' }
  }
  const mine = new Set(combos.map(comboId))
  for (const other of ALL) {
    if (other.action === action) continue
    const keys = other.rebindable ? effectiveKeys(other.action as RebindableAction, bindings) : other.keys
    if (keys.some((c) => mine.has(comboId(c)))) return { reason: 'conflict', with: other.action }
  }
  return null
}

/** The keys an action has for this user: their own binding, or the shipped one. */
export function effectiveKeys(action: RebindableAction, bindings: ShortcutBindings): string[][] {
  return bindings[action] ?? defaultShortcut(action).keys
}

/** The pair a recorded combination gives a pair action: the same modifiers with ← and →. */
export const pairOf = (combo: readonly string[]): string[][] => {
  const mods = combo.slice(0, -1)
  return [
    [...mods, '←'],
    [...mods, '→'],
  ]
}

/**
 * A user's own bindings (W5), as kept on the server for them: each a rebindable action, with one or
 * two combinations (a pair action two: ← then →), none taking the browser's keys, a fixed shortcut's
 * or another action's.
 */
export const ShortcutBindingsSchema = z
  .strictObject({
    bindings: z.partialRecord(z.enum(REBINDABLE_ACTIONS), z.array(ComboSchema).min(1).max(2)),
  })
  .superRefine((value, ctx) => {
    for (const [action, combos] of Object.entries(value.bindings) as Array<[RebindableAction, string[][]]>) {
      const shortcut = defaultShortcut(action)
      const pairOk = () => {
        const [left, right] = pairOf(combos[0]!)
        return comboId(left!) === comboId(combos[0]!) && comboId(right!) === comboId(combos[1]!)
      }
      if (shortcut.pair && (combos.length !== 2 || !pairOk()))
        ctx.addIssue({
          code: 'custom',
          path: ['bindings', action],
          message: 'A pair is one set of keys with ← and →',
        })
      else if (!shortcut.pair && combos.length !== 1)
        ctx.addIssue({ code: 'custom', path: ['bindings', action], message: 'One combination per action' })
      const problem = bindingProblem(action, combos, value.bindings)
      if (problem)
        ctx.addIssue({
          code: 'custom',
          path: ['bindings', action],
          message:
            problem.reason === 'conflict'
              ? `The keys are taken by ${problem.with}`
              : `Not usable: ${problem.reason}`,
        })
    }
  })
export type ShortcutBindingsBody = z.infer<typeof ShortcutBindingsSchema>
