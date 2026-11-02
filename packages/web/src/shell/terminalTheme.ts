import type { ITheme } from '@xterm/xterm'

/**
 * User request 2026-10-11 (the shell's redesign): the terminal in the app's own look — its surface,
 * text and accent, light or dark — with a palette tuned to read on each. Colours reach the terminal
 * only from the constants below, written around text that went through writeSafe (which turns every
 * ESC into visible text), so what a server or a document prints can never colour or drive it.
 */

/** A CSS custom property of the document, as the app's theme sets it ('' when not set). */
export const cssToken = (name: string): string =>
  typeof document === 'undefined'
    ? ''
    : getComputedStyle(document.documentElement).getPropertyValue(name).trim()

const LIGHT = {
  background: '#ffffff',
  foreground: '#111827',
  accent: '#047a4d',
  palette: {
    black: '#1f2937',
    red: '#c9241a',
    green: '#0b7a4b',
    yellow: '#946200',
    blue: '#1d4ed8',
    magenta: '#a21caf',
    cyan: '#0e7490',
    white: '#6b7280',
    brightBlack: '#4b5563',
    brightRed: '#dc2626',
    brightGreen: '#15803d',
    brightYellow: '#a34a00',
    brightBlue: '#2563eb',
    brightMagenta: '#c026d3',
    brightCyan: '#0891b2',
    brightWhite: '#374151',
  },
}
const DARK = {
  background: '#111317',
  foreground: '#edeef0',
  accent: '#2fbf7f',
  palette: {
    black: '#2a2e36',
    red: '#ff6b5f',
    green: '#5fe3a1',
    yellow: '#ffcf70',
    blue: '#7aa2ff',
    magenta: '#e28bff',
    cyan: '#6cd9e6',
    white: '#d4d7dd',
    brightBlack: '#8a919c',
    brightRed: '#ff8a80',
    brightGreen: '#86efac',
    brightYellow: '#fde68a',
    brightBlue: '#a5b4fc',
    brightMagenta: '#f0abfc',
    brightCyan: '#a5f3fc',
    brightWhite: '#ffffff',
  },
}

/** A hex colour with this alpha (00–ff); another notation is kept as it is. */
const withAlpha = (color: string, alpha: string) =>
  /^#[0-9a-f]{6}$/i.test(color) ? `${color}${alpha}` : color

/**
 * User request 2026-10-12 ("Terminal ekranı için tema seçimi ekle"): the app's own look, or a
 * well-known terminal theme, each its whole palette (the shell's colours are palette entries, so a
 * theme recolours what is on screen too).
 */
export const TERMINAL_THEMES = [
  'app',
  'github-light',
  'github-dark',
  'one-dark',
  'dracula',
  'monokai',
  'nord',
  'solarized-light',
  'solarized-dark',
] as const
export type TerminalThemeName = (typeof TERMINAL_THEMES)[number]

interface Named {
  background: string
  foreground: string
  cursor: string
  /** black red green yellow blue magenta cyan white, then their bright ones. */
  palette: [string, string, string, string, string, string, string, string]
  bright: [string, string, string, string, string, string, string, string]
}
// prettier-ignore
const NAMED: Record<Exclude<TerminalThemeName, 'app'>, Named> = {
  'github-light': {
    background: '#ffffff', foreground: '#24292f', cursor: '#0969da',
    palette: ['#24292f', '#cf222e', '#116329', '#4d2d00', '#0969da', '#8250df', '#1b7c83', '#6e7781'],
    bright: ['#57606a', '#a40e26', '#1a7f37', '#633c01', '#218bff', '#a475f9', '#3192aa', '#8c959f'],
  },
  'github-dark': {
    background: '#0d1117', foreground: '#e6edf3', cursor: '#58a6ff',
    palette: ['#484f58', '#ff7b72', '#3fb950', '#d29922', '#58a6ff', '#bc8cff', '#39c5cf', '#b1bac4'],
    bright: ['#6e7681', '#ffa198', '#56d364', '#e3b341', '#79c0ff', '#d2a8ff', '#56d4dd', '#ffffff'],
  },
  'one-dark': {
    background: '#282c34', foreground: '#abb2bf', cursor: '#528bff',
    palette: ['#3f4451', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#d7dae0'],
    bright: ['#5c6370', '#ef7b85', '#a6d189', '#f0cd8f', '#74bdf7', '#d48ce7', '#68c6d2', '#ffffff'],
  },
  dracula: {
    background: '#282a36', foreground: '#f8f8f2', cursor: '#f8f8f2',
    palette: ['#21222c', '#ff5555', '#50fa7b', '#f1fa8c', '#bd93f9', '#ff79c6', '#8be9fd', '#f8f8f2'],
    bright: ['#6272a4', '#ff6e6e', '#69ff94', '#ffffa5', '#d6acff', '#ff92df', '#a4ffff', '#ffffff'],
  },
  monokai: {
    background: '#272822', foreground: '#f8f8f2', cursor: '#f8f8f0',
    palette: ['#272822', '#f92672', '#a6e22e', '#f4bf75', '#66d9ef', '#ae81ff', '#a1efe4', '#f8f8f2'],
    bright: ['#75715e', '#f92672', '#a6e22e', '#f4bf75', '#66d9ef', '#ae81ff', '#a1efe4', '#f9f8f5'],
  },
  nord: {
    background: '#2e3440', foreground: '#d8dee9', cursor: '#d8dee9',
    palette: ['#3b4252', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#88c0d0', '#e5e9f0'],
    bright: ['#4c566a', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#8fbcbb', '#eceff4'],
  },
  'solarized-light': {
    background: '#fdf6e3', foreground: '#586e75', cursor: '#268bd2',
    palette: ['#073642', '#dc322f', '#859900', '#b58900', '#268bd2', '#d33682', '#2aa198', '#eee8d5'],
    bright: ['#657b83', '#cb4b16', '#859900', '#b58900', '#268bd2', '#6c71c4', '#2aa198', '#fdf6e3'],
  },
  'solarized-dark': {
    background: '#002b36', foreground: '#93a1a1', cursor: '#93a1a1',
    palette: ['#073642', '#dc322f', '#859900', '#b58900', '#268bd2', '#d33682', '#2aa198', '#eee8d5'],
    bright: ['#586e75', '#cb4b16', '#859900', '#b58900', '#268bd2', '#6c71c4', '#2aa198', '#fdf6e3'],
  },
}
const COLOURS = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'] as const

function named(theme: Named): ITheme {
  const out: Record<string, string> = {
    background: theme.background,
    foreground: theme.foreground,
    cursor: theme.cursor,
    cursorAccent: theme.background,
    selectionBackground: withAlpha(theme.cursor, '40'),
    selectionInactiveBackground: withAlpha(theme.cursor, '26'),
    scrollbarSliderBackground: withAlpha(theme.foreground, '1f'),
    scrollbarSliderHoverBackground: withAlpha(theme.foreground, '33'),
    scrollbarSliderActiveBackground: withAlpha(theme.foreground, '47'),
  }
  COLOURS.forEach((name, i) => {
    out[name] = theme.palette[i]!
    out[`bright${name[0]!.toUpperCase()}${name.slice(1)}`] = theme.bright[i]!
  })
  return out as ITheme
}

/** A well-known theme's background, for the surface around the terminal (null: the app's). */
export const themeBackground = (name: TerminalThemeName): string | null =>
  name !== 'app' && Object.hasOwn(NAMED, name) ? NAMED[name].background : null

export function terminalTheme(
  dark: boolean,
  read: (name: string) => string = cssToken,
  name: TerminalThemeName = 'app',
): ITheme {
  if (name !== 'app' && Object.hasOwn(NAMED, name)) return named(NAMED[name])
  const base = dark ? DARK : LIGHT
  const background = read('--ds-surface') || base.background
  const foreground = read('--ds-fg') || base.foreground
  const accent = read('--ds-accent') || base.accent
  return {
    background,
    foreground,
    cursor: accent,
    cursorAccent: background,
    selectionBackground: withAlpha(accent, '40'),
    selectionInactiveBackground: withAlpha(accent, '26'),
    scrollbarSliderBackground: withAlpha(foreground, '1f'),
    scrollbarSliderHoverBackground: withAlpha(foreground, '33'),
    scrollbarSliderActiveBackground: withAlpha(foreground, '47'),
    ...base.palette,
    // The prompt's colour (bold green) is the app's accent.
    green: accent,
    brightGreen: accent,
  }
}

/** The app's own colours (SGR), the only escape sequences written with text. */
export const SGR = {
  prompt: '\x1b[1;32m',
  error: '\x1b[31m',
  warning: '\x1b[33m',
  info: '\x1b[90m',
  reset: '\x1b[0m',
} as const

/** Text already made safe (writeSafe), in one of the app's colours. */
export const paint = (kind: Exclude<keyof typeof SGR, 'reset'>, safe: string): string =>
  `${SGR[kind]}${safe}${SGR.reset}`
