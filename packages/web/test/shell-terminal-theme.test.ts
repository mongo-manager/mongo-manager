// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { SGR, TERMINAL_THEMES, paint, terminalTheme } from '../src/shell/terminalTheme'
import { writeSafe } from '../src/shell/writeSafe'

// User request 2026-10-11: the terminal in the app's own look, light and dark, never a raw black box.
describe('the shell terminal’s theme', () => {
  const tokens = (values: Record<string, string>) => (name: string) => values[name] ?? ''

  it('takes the app’s surface, text and accent, the accent as cursor and selection', () => {
    const theme = terminalTheme(
      false,
      tokens({ '--ds-surface': '#ffffff', '--ds-fg': '#111827', '--ds-accent': '#047a4d' }),
    )
    expect(theme.background).toBe('#ffffff')
    expect(theme.foreground).toBe('#111827')
    expect(theme.cursor).toBe('#047a4d')
    expect(theme.cursorAccent).toBe('#ffffff')
    expect(theme.selectionBackground).toBe('#047a4d40')
    // The prompt (bold green) is the app's accent, whichever accent is chosen.
    expect(theme.green).toBe('#047a4d')
    expect(theme.brightGreen).toBe('#047a4d')
  })

  it('has a palette for each of light and dark, readable on its surface', () => {
    const light = terminalTheme(false, tokens({}))
    const dark = terminalTheme(true, tokens({}))
    expect(light.red).not.toBe(dark.red)
    expect(light.background).toBe('#ffffff')
    expect(dark.background).toBe('#111317')
    // Without the app's tokens (a test, a page not styled yet), a sound default.
    expect(light.foreground).toBe('#111827')
    expect(dark.foreground).toBe('#edeef0')
  })

  // User request 2026-10-12: "Terminal ekranı için tema seçimi ekle".
  it('offers well-known themes beside the app’s, each a whole palette the app’s tokens never change', () => {
    expect(TERMINAL_THEMES).toEqual([
      'app',
      'github-light',
      'github-dark',
      'one-dark',
      'dracula',
      'monokai',
      'nord',
      'solarized-light',
      'solarized-dark',
    ])
    const app = tokens({ '--ds-surface': '#123456', '--ds-accent': '#abcdef' })
    const dracula = terminalTheme(true, app, 'dracula')
    expect(dracula.background).toBe('#282a36')
    expect(dracula.foreground).toBe('#f8f8f2')
    expect(dracula.magenta).toBe('#ff79c6')
    // Its own, whatever the app's light or dark and its accent.
    expect(terminalTheme(false, app, 'dracula')).toEqual(dracula)
    for (const name of TERMINAL_THEMES.filter((n) => n !== 'app')) {
      const theme = terminalTheme(false, app, name)
      for (const key of [
        'background',
        'foreground',
        'cursor',
        'black',
        'red',
        'green',
        'yellow',
        'blue',
        'magenta',
        'cyan',
        'white',
        'brightBlack',
        'brightMagenta',
      ] as const)
        expect([name, key, theme[key]]).toEqual([name, key, expect.stringMatching(/^#[0-9a-f]{6}$/)])
    }
    // An unknown name is the app's.
    expect(terminalTheme(false, app, 'nope' as never)).toEqual(terminalTheme(false, app, 'app'))
  })

  it('paints only the app’s own constants around text already made safe', () => {
    const hostile = '\x1b]52;c;ZXZpbA==\x07\x1b[2J'
    const painted = paint('error', writeSafe(hostile))
    expect(painted.startsWith(SGR.error)).toBe(true)
    expect(painted.endsWith(SGR.reset)).toBe(true)
    // The text's own escapes stay visible text: the only ESC bytes are the two constants.
    expect(painted.split('\x1b').length - 1).toBe(2)
    expect(painted).toContain('\\x1b]52')
  })
})
