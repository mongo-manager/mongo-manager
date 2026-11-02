<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, readonly, ref, shallowRef, useId, watch } from 'vue'
import { MIN_MONGODB_VERSION } from '@mongo-manager/shared/browser'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import { connectionsApi, queryKeys } from '@/api/connections'
import { Terminal, type IMarker } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { usePreferencesStore } from '@/stores/preferences'
import { useDialogStore } from '@/stores/dialogs'
import { shellApi } from '@/api/shell'
import { revealInvisible, writeSafe } from './writeSafe'
import { cellWidth } from './cellWidth'
import { paint, terminalTheme, themeBackground } from './terminalTheme'
import { highlight } from './highlight'
import { RotateCcw } from 'lucide-vue-next'
import DsButton from '@/ds/DsButton.vue'
import { formatResult, type ResultPart } from './formatResult'
import { LineEditor, lineFits, pasted } from './lineEditor'
import { shellCommand } from '@mongo-manager/shared/browser'
import { createShellSession, type OpenedHow, type ShellSession } from './session'
import {
  clearLine,
  drawLine,
  leaveLine,
  lineAfterResize,
  type DrawOptions,
  type LineState,
} from './lineRender'
import type { ChannelMessage } from '@/jobs/socket'
import type { CompletionResult } from '@/ds/code/completion'
import type { QueryOrigin } from '@mongo-manager/shared'
import { documentsOf, type ShellResult } from './results'

/** The line the server prints when a command's output passed the cap (phase 3a-1 §4). */
const OUTPUT_TRUNCATED = '\n[output truncated]'

/**
 * Phase 3a-1 spec §10: the shell terminal. All output goes through writeSafe; the CSP is not relaxed.
 * User request 2026-10-11 (the shell's redesign): in the app's look, light or dark, with its state
 * told (connecting, ready, running, closed), Clear and Restart; only the app's own colours.
 */
const props = defineProps<{
  connectionId: string
  db: string
  /** Phase 3a-2: completion for Tab in the terminal (the shell tab's shared completer). */
  completer?: (text: string, caret: number) => Promise<CompletionResult | null>
  /** The tab it belongs to: its session is kept for a reload under this key (none: never kept). */
  sessionKey?: string
}>()
/**
 * Phase 3a-2: `db` is the database the shell is on (after `use` too), for completion (final review M6).
 * `ran`: what was typed has run (its last piece done): what it made — a collection — can be read again.
 */
const emit = defineEmits<{ result: [result: ShellResult]; db: [name: string]; ran: []; cleared: [] }>()
const { t, te } = useI18n()
const uid = useId()
const preferences = usePreferencesStore()
const dialogs = useDialogStore()
// Spec §10: the terminal is labelled with the connection and the database, for screen readers.
const { data: connections } = useQuery({ queryKey: queryKeys.connections, queryFn: connectionsApi.list })
const terminalLabel = computed(() =>
  t('shell.terminal', {
    connection: connections.value?.find((c) => c.id === props.connectionId)?.name ?? props.connectionId,
    db: props.db,
  }),
)

/** Load the server-side history (oldest → newest) into the line editor for Up/Down and Ctrl+R. */
async function loadHistory(): Promise<void> {
  try {
    const { entries } = await shellApi.history(props.connectionId)
    editor.setHistory(entries.map((e) => e.code).reverse())
  } catch {
    // A shell works without its saved history.
  }
}

/**
 * Forgets the command history on this connection, once asked: what came of it, for the page to say
 * and to clear its results too (user report 2026-10-12: it seemed to do nothing, and a failure was
 * never said).
 */
async function clearHistory(): Promise<'cleared' | 'cancelled' | 'failed'> {
  const ok = await dialogs.confirm({
    title: t('shell.clearHistory'),
    message: t('shell.clearHistoryConfirm'),
    confirmLabel: t('shell.clearHistory'),
    danger: true,
  })
  if (!ok) return 'cancelled'
  try {
    await shellApi.clearHistory(props.connectionId)
  } catch {
    return 'failed'
  }
  editor.setHistory([])
  return 'cleared'
}

const host = ref<HTMLElement | null>(null)
const term = shallowRef<Terminal | null>(null)
const editor = new LineEditor()
const closed = ref(false)
let session: ShellSession | null = null
let fit: FitAddon | null = null
let prompt = '> '
const running = ref(false)
/** The session opened (code runs at once) — or not yet (code waits for it). */
const isOpen = ref(false)
/** When the command running started (for the elapsed time shown), or null. */
const runningSince = ref<number | null>(null)
watch(running, (now) => (runningSince.value = now ? Date.now() : null))
const status = computed<'connecting' | 'ready' | 'running' | 'closed'>(() => {
  if (closed.value) return 'closed'
  // Code waiting for the session is not running yet (review 2026-10-11).
  if (!isOpen.value) return 'connecting'
  return running.value ? 'running' : 'ready'
})
/**
 * The tab's session, kept in this browser tab for a reload (user report 2026-10-12: a reload left
 * its shells waiting on the server and opened new ones, until "too many shells open"). Never shared
 * with another browser tab (sessionStorage), never anything but an id the server checks again.
 */
const KEPT = 'mm:shell-session:'
/** A session id as the server makes them: anything else kept is dropped, never sent (review M10). */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
function kept(): string | null {
  if (!props.sessionKey) return null
  try {
    const id = sessionStorage.getItem(KEPT + props.sessionKey)
    if (id && SESSION_ID.test(id)) return id
    if (id) sessionStorage.removeItem(KEPT + props.sessionKey)
  } catch {
    // Storage refused: a new shell opens.
  }
  return null
}
function keep(id: string | null): void {
  if (!props.sessionKey) return
  try {
    if (id) sessionStorage.setItem(KEPT + props.sessionKey, id)
    else sessionStorage.removeItem(KEPT + props.sessionKey)
  } catch {
    // Storage refused (a private window): a reload opens a new shell, as before.
  }
}
/** How it opened, in one line: a new shell, the same again, or a new one for one that had ended. */
function openedLine(how: OpenedHow): string {
  if (how === 'replaced') return paint('warning', writeSafe(t('shell.replaced')))
  return paint('info', writeSafe(t(how === 'resumed' ? 'shell.resumed' : 'shell.connected')))
}

/** The surface around the terminal in a chosen theme's background (the app's: none of its own). */
const surface = computed(() => themeBackground(preferences.terminalTheme))

/** Why the shell closed, in the user's words (the server sends a code). */
const reasonText = (reason: string) => (te(`shell.reasons.${reason}`) ? t(`shell.reasons.${reason}`) : reason)

/** OSC/DCS sequences we refuse even if writeSafe were bypassed (defence in depth, spec §10.1). */
const OSC_CODES = [0, 1, 2, 4, 8, 10, 11, 12, 52, 104, 110, 111, 112, 633, 1337]
/**
 * Every DCS the parser can recognise: each final byte (0x40–0x7E), bare and with each single
 * intermediate (0x20–0x2F) — sixel, DECRQSS ($q), XTGETTCAP (+q) and the rest. writeSafe already
 * escapes ESC so none can arrive; this is the second layer if that ever regresses (review M3).
 */
const DCS_IDS: Array<{ intermediates?: string; final: string }> = (() => {
  const ids: Array<{ intermediates?: string; final: string }> = []
  for (let f = 0x40; f <= 0x7e; f++) {
    const final = String.fromCharCode(f)
    ids.push({ final })
    for (let i = 0x20; i <= 0x2f; i++) ids.push({ intermediates: String.fromCharCode(i), final })
  }
  return ids
})()

/**
 * Whether the cursor is at the start of a line (after a command's echo, or an output's end): output
 * starts there, and the prompt comes after the output's last line — never drawn over it.
 */
let atLineStart = true

/**
 * The line being typed as last drawn — its rows and its parts — or null when the cursor is on output.
 * User report 2026-10-12 ("yazı yazarken ekran titreşiyor"): a line longer than the terminal was
 * written again under itself on every key, and the arrows never showed where the cursor was.
 */
let line: LineState | null = null
let drawn: { prompt: string; text: string } = { prompt: '', text: '' }
const NOT_DRAWN: LineState = { cursorRow: 0, lastRow: 0 }
/**
 * The line's first row, kept by the terminal across a resize's reflow: where its cursor is then is
 * read from the terminal, never guessed (review 2026-10-12, M12).
 */
let lineStart: IMarker | undefined

/** The line's parts: its prompt (or the search's), the text before and after the cursor, made safe. */
function lineParts(): [prompt: string, before: string, after: string] {
  if (editor.searching)
    return [
      `${paint('info', writeSafe(revealInvisible(`(reverse-i-search)\`${editor.searchQuery}':`)))} `,
      writeSafe(revealInvisible(editor.buffer)),
      '',
    ]
  // A character that shows nothing (a zero-width space, a soft hyphen) is shown as its escape in the
  // code being typed: a snippet cannot hide one there (review 2026-10-12, M4).
  return [
    promptText(),
    writeSafe(revealInvisible(editor.buffer.slice(0, editor.cursor))),
    writeSafe(revealInvisible(editor.buffer.slice(editor.cursor))),
  ]
}

/**
 * Past this many characters the line is drawn without colours: colouring it on every key took tens of
 * milliseconds (review 2026-10-12, M5).
 */
const COLOUR_LIMIT = 20_000
/** The cells a plain text takes on one row. */
const cells = (text: string) => [...text].reduce((n, ch) => n + cellWidth(ch.codePointAt(0)!), 0)
const lineColour = () => (editor.buffer.length > COLOUR_LIMIT ? undefined : highlight)

/**
 * Each line after the first opens with mongosh's "..."; a line taller than the terminal says how many
 * lines are left out above and below (user report 2026-10-12: code is pasted in the terminal now).
 */
const lineOptions: DrawOptions = {
  continuation: `${paint('info', '...')} `,
  more: (n, above) => writeSafe(t(above ? 'shell.more.above' : 'shell.more.below', n)),
}

/** Draws the line being typed again, in one write, over every row it takes. */
function render(): void {
  const term_ = term.value
  if (!term_) return
  atLineStart = false
  // Up and Down keep a column where the terminal shows it: after the prompt, after "... ".
  editor.indents = { first: cells(`${prompt.trimEnd()} `), rest: 4 }
  const [prompt_, before, after] = lineParts()
  const fresh = line === null
  const next = drawLine(
    line ?? NOT_DRAWN,
    prompt_,
    before,
    after,
    term_.cols,
    term_.rows,
    lineColour(),
    lineOptions,
  )
  line = next.state
  drawn = { prompt: prompt_, text: before + after }
  // A line drawn anew: its first row marked once the terminal has written it.
  const cursorRow = next.state.cursorRow
  term_.write(next.out, () => {
    if (!fresh || line === null) return
    lineStart?.dispose()
    lineStart = term_.registerMarker?.(-cursorRow)
  })
}

/** Off the line being typed onto a new one, from its end (`tail` written there first, as ^C). */
function leave(tail = ''): string {
  const term_ = term.value
  const out =
    line && term_
      ? leaveLine(line, drawn.prompt, drawn.text, term_.cols, tail, lineColour(), lineOptions)
      : `${tail}\r\n`
  line = null
  lineStart?.dispose()
  lineStart = undefined
  return out
}

/** The prompt in the app's accent, then its space. */
const promptText = () => `${paint('prompt', writeSafe(prompt.trimEnd()))} `

/** mongosh's line after a cursor's batch, written plain (review M6): never coloured as code. */
const MORE = writeSafe('\nType "it" for more')
/** A result in colour, as mongosh shows one. */
const colourResult = (safe: string) =>
  safe.endsWith(MORE) ? highlight(safe.slice(0, -MORE.length)) + MORE : highlight(safe)

function writePart(part: ResultPart): void {
  const term_ = term.value
  if (!term_) return
  const text = formatResult(part)
  // An empty print is an empty line, as in mongosh (second review 2026-10-12, minor 6).
  if (!text && part.type !== 'print') return
  const safe = writeSafe(text)
  if (!atLineStart) term_.write(leave())
  term_.write(
    part.type === 'error'
      ? paint('error', safe)
      : part.type === 'reset'
        ? paint('warning', safe)
        : // A result in colour, as mongosh shows one; what a command prints, and a string result
          // ("switched to db shop"), as printed.
          part.type === 'result' && typeof part.value !== 'string'
          ? colourResult(safe)
          : safe,
  )
  atLineStart = false
}

/** xterm's marks around a paste (bracketed paste, turned on when the terminal opens). */
const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'
/**
 * The most a paste may hold before it is read at all: far past what the line takes. Spec §4's 1 MiB
 * (security audit 2026-10-16: it was 4 MiB).
 */
const MAX_PASTE = 1024 * 1024

function onData(data: string): void {
  // Closed, a line may still be typed: Enter opens a new shell for it (user report 2026-10-12).
  // While a command runs, only Ctrl+C is honoured.
  if (running.value) {
    if (data === '\x03') cancel()
    // A paste is not taken while a command runs: said, never dropped without a word (second review
    // 2026-10-12, minor 24).
    else if (data.startsWith(PASTE_START)) {
      term.value?.write(
        `${atLineStart ? '' : '\r\n'}${paint('warning', writeSafe(t('shell.pasteWhileRunning')))}\r\n`,
      )
      atLineStart = true
    }
    return
  }
  if (data.startsWith(PASTE_START))
    return paste(data.slice(PASTE_START.length, data.endsWith(PASTE_END) ? -PASTE_END.length : undefined))
  // Any other escape sequence is a key the line does not take (PageUp, F1, Alt and a letter): never
  // text in it (review 2026-10-12, minor 1).
  if (data.startsWith('\x1b')) return
  // Text with a line end in it is a paste all the same (a browser that does not mark one).
  if (/[\r\n]/.test(data)) return paste(data)
  // Typed text: a key, or a word an input method composed. Control characters are no text.
  const text = [...data].filter((ch) => ch === '\t' || (ch >= ' ' && ch !== '\x7f')).join('')
  if (!text) return
  if (editor.searching) editor.searchInput(text)
  else editor.input(text)
  render()
}

/**
 * A paste (user report 2026-10-12: "\x0d gibi terimler geliyor"): its line ends (CR, as xterm hands
 * them over) are the line's newlines, and nothing runs until Enter. Searching, it is what is searched
 * for (on one line). Too large for the line, it is not taken at all and that is said: never cut,
 * never silent.
 */
function paste(raw: string): void {
  const text = raw.length > MAX_PASTE ? null : pasted(raw)
  if (text === '') return
  if (text !== null && editor.searching) {
    editor.searchInput(text.replace(/\s*\n\s*/g, ' '))
    return render()
  }
  const before = editor.buffer
  if (text !== null) editor.input(text)
  if (text === null || editor.buffer === before)
    term.value?.write(`${leave()}${paint('warning', writeSafe(t('shell.pasteTooLarge')))}\r\n`)
  render()
}

function onKey(event: KeyboardEvent): void {
  if (running.value) {
    if (event.ctrlKey && event.key.toLowerCase() === 'c') cancel()
    // Clearing the screen works while a command runs, as the header's button does (review 2026-10-13, M6).
    else if (keyName(event) === 'Ctrl+L') clear()
    return
  }
  const name = keyName(event)
  if (!name) return
  if (name === 'Tab') return void completeInTerminal()
  const before = [editor.buffer, editor.cursor, editor.searching, editor.searchQuery].join('\0')
  const state = editor.key(name, event.shiftKey)
  if (state.action === 'run' && state.submit !== undefined) {
    term.value?.write(leave())
    atLineStart = true
    if (state.submit.trim()) lastCode = state.submit
    submit(state.submit)
  } else if (state.action === 'clear') clear()
  else if (state.action === 'cancel') {
    term.value?.write(leave('^C'))
    render()
  } else if (before !== [editor.buffer, editor.cursor, editor.searching, editor.searchQuery].join('\0')) {
    // Whatever moved — the text, the cursor (Ctrl+A too, review 2026-10-12, I10) or the search.
    render()
  }
}

/** The keys the line editor takes, by name; null for one it does not. */
function keyName(e: KeyboardEvent): string | null {
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
  if (isCommand(e)) {
    // With Shift it is the page's (Ctrl+Shift+L opens the Library), never the line's.
    if (e.shiftKey) return null
    const map: Record<string, string> = {
      Backspace: 'Ctrl+Backspace',
      Delete: 'Ctrl+Delete',
      a: 'Ctrl+A',
      e: 'Ctrl+E',
      u: 'Ctrl+U',
      k: 'Ctrl+K',
      w: 'Ctrl+W',
      c: 'Ctrl+C',
      l: 'Ctrl+L',
      r: 'Ctrl+R',
      Enter: 'Ctrl+Enter',
      ArrowLeft: 'Ctrl+ArrowLeft',
      ArrowRight: 'Ctrl+ArrowRight',
    }
    return map[key] ?? null
  }
  if (isAltWord(e)) return `Alt+${ALT_WORD[e.code] ?? key.toUpperCase()}`
  const named = [
    'Enter',
    'Backspace',
    'Delete',
    'ArrowLeft',
    'ArrowRight',
    'ArrowUp',
    'ArrowDown',
    'Home',
    'End',
    'Escape',
    'Tab',
  ]
  return named.includes(e.key) ? e.key : null
}

/**
 * A Ctrl shortcut — never AltGr, which a keyboard reports as Ctrl+Alt and which types `{`, `[`, `@`,
 * `$` on a Turkish keyboard (found 2026-10-12: they were taken for shortcuts and never typed).
 */
const isCommand = (e: KeyboardEvent) =>
  e.ctrlKey && !e.altKey && !e.metaKey && !e.getModifierState?.('AltGraph')
/**
 * Alt with B, F or D: a word back, forward, or deleted (readline's keys) — by the key's place, as
 * macOS's Option types a character there (∫, ƒ, ∂; second review 2026-10-12, minor 19).
 */
const ALT_WORD: Record<string, string> = { KeyB: 'B', KeyF: 'F', KeyD: 'D' }
const isAltWord = (e: KeyboardEvent) =>
  e.altKey &&
  !e.ctrlKey &&
  !e.metaKey &&
  (ALT_WORD[e.code] !== undefined || ['b', 'f', 'd'].includes(e.key.toLowerCase()))

function done(part: ChannelMessage): void {
  if (part.type === 'done') {
    prompt = `${String(part.payload.prompt ?? '>')} `
    if (typeof part.payload.db === 'string' && part.payload.db) emit('db', part.payload.db)
    emit('ran')
    // Code typed while a command was still running after a reload runs now that it has ended.
    const waiting = pending
    pending = null
    if (waiting !== null) {
      if (!atLineStart) term.value?.write(leave())
      atLineStart = true
      return evaluate(waiting)
    }
    running.value = false
    // The prompt under the output's last line.
    if (!atLineStart) term.value?.write(leave())
    render()
  } else if (part.type === 'reset') {
    // A new worker starts on the database the shell tab opened.
    emit('db', props.db)
    writePart({ type: 'reset', message: t('shell.reset') })
  } else {
    // The part's kind is on the message; its fields are in the payload. An error the page words
    // itself is said in the user's language (second review 2026-10-12, minor 15).
    const payload =
      part.type === 'error' ? { ...part.payload, message: errorText(part.payload) } : part.payload
    writePart({ type: part.type as ResultPart['type'], ...payload } as ResultPart)
    reportResult(part)
    // The rest of a script an error stopped: said, never left out silently (review 2026-10-12, I8).
    const skipped = Number(part.payload.skipped ?? 0)
    if (part.type === 'error' && Number.isInteger(skipped) && skipped > 0)
      writePart({ type: 'reset', message: t('shell.skipped', skipped) })
  }
}

/** An error's words: the shell's own, or for a code the page knows, the page's. */
function errorText(payload: Record<string, unknown>): string {
  const message = String(payload.message ?? '')
  if (payload.code === 'STOPPED') return t('shell.errors.stopped')
  // Security audit 2026-10-16: server JavaScript the proxy refused (MM_ALLOW_SERVER_JS is off).
  if (payload.code === 'SERVER_JS') return t('shell.errors.serverJs')
  if (payload.code === 'DISCONNECTED') return t('shell.errors.disconnected')
  if (payload.code === 'NOT_AVAILABLE' && ['exit', 'quit', 'cls'].includes(message))
    return t(`shell.errors.notAvailable.${message}`)
  return message
}

/** The last code typed and run, for "Save as snippet" with nothing typed (never the result pane's "it"). */
let lastCode = ''

/**
 * Runs what was typed, as one command: the shell runs a script of many lines piece by piece, as
 * mongosh runs what is typed (user report 2026-10-12). A blank line runs nothing (a new prompt).
 * `cls` clears the screen and `exit` or `quit` ends the shell, as in mongosh (review 2026-10-12, I12).
 * Closed (it waited too long, say), a new shell opens and it runs there once it has; before the
 * session opened it waits for it (review I1).
 */
function submit(code: string): void {
  if (!code.trim()) return render()
  const trimmed = code.trim()
  const command = trimmed.includes('\n') ? null : shellCommand(trimmed)
  if (command === 'cls') return clear()
  if (command === 'exit' || command === 'quit') return end()
  running.value = true
  if (closed.value) {
    pending = code
    reopen()
  } else if (isOpen.value) evaluate(code)
  else pending = code
}

/** The code each command ran, by its id: the result pane names a result by it (the last 50). */
const commands = new Map<number, string>()
function evaluate(code: string): void {
  const id = session?.evaluate(code) ?? null
  if (id === null) {
    // Never sent (the link was down): said, and the line is free again — never "running" for nothing
    // (review 2026-10-12, minor 11).
    running.value = false
    term.value?.write(`${leave()}${paint('warning', writeSafe(t('shell.notSent')))}\r\n`)
    atLineStart = true
    return render()
  }
  used = true
  commands.set(id, code)
  if (commands.size > 50) commands.delete(commands.keys().next().value!)
}

/** Phase 3a-2: hand results (and output that passed the cap) to the result pane. */
function reportResult(part: ChannelMessage): void {
  const id = Number(part.payload.id ?? 0)
  // A piece of a script is named by itself; a command by what was typed.
  const command = typeof part.payload.command === 'string' ? part.payload.command : commands.get(id)
  if (part.type === 'result') {
    const origin = part.payload.origin as QueryOrigin | undefined
    emit('result', {
      id,
      resultType: typeof part.payload.resultType === 'string' ? part.payload.resultType : null,
      value: part.payload.value,
      ...(origin ? { origin } : {}),
      hasMore: part.payload.hasMore === true,
      documents: documentsOf(part.payload.value),
      ...(command !== undefined ? { command } : {}),
    })
  } else if (part.type === 'print' && part.payload.text === OUTPUT_TRUNCATED) {
    emit('result', {
      id,
      resultType: null,
      value: undefined,
      hasMore: false,
      documents: null,
      truncated: true,
      ...(command !== undefined ? { command } : {}),
    })
  }
}

onMounted(() => {
  const term_ = new Terminal({
    scrollback: 5000,
    screenReaderMode: preferences.screenReader,
    allowProposedApi: false,
    fontFamily: '"JetBrains Mono", ui-monospace, monospace',
    fontSize: 13,
    lineHeight: 1.4,
    cursorBlink: true,
    cursorStyle: 'bar',
    cursorWidth: 2,
    // Text stays readable on the theme's surface, whatever colour is asked for.
    minimumContrastRatio: 4.5,
    theme: terminalTheme(preferences.dark, undefined, preferences.terminalTheme),
    convertEol: false,
    // Every window operation off (spec §10.1).
    windowOptions: {},
  })
  term.value = term_
  fit = new FitAddon()
  term_.loadAddon(fit)
  // Swallow OSC and DCS so a bypass of writeSafe still cannot drive the terminal.
  for (const code of OSC_CODES) term_.parser.registerOscHandler(code, () => true)
  for (const id of DCS_IDS) term_.parser.registerDcsHandler(id, () => true)
  if (host.value) {
    term_.open(host.value)
    try {
      fit.fit()
    } catch {
      // No layout yet in tests.
    }
  }
  // WebGL is loaded opportunistically; the DOM renderer is the fallback.
  void loadWebgl(term_)
  // Esc's Tab lasts while the terminal keeps the focus: back later, Tab completes again (review M7).
  const forgetEsc = () => (tabLeaves = false)
  term_.textarea?.addEventListener('blur', forgetEsc)
  term_.textarea?.addEventListener('focus', forgetEsc)
  term_.onData(onData)
  // Bracketed paste: a paste comes marked, told apart from keys (review 2026-10-12, minor 1).
  term_.write('\x1b[?2004h')
  term_.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true
    // A key an input method composes with is its own: Enter picks a candidate, it runs nothing
    // (second review 2026-10-12, minor 20).
    if (e.isComposing || e.keyCode === 229) return true
    // User report 2026-10-12 ("tab olarak tamamlama kullandığımda terminalden çıkıyor"): Tab completes
    // and the focus stays; Shift+Tab, or Esc then Tab, moves it on as anywhere on the page.
    if (e.key === 'Tab') {
      // Nothing to complete (closed, no completion): Tab goes on, as anywhere (review M8).
      const leave = e.shiftKey || tabLeaves || closed.value || !props.completer
      tabLeaves = false
      if (leave) return false
      e.preventDefault()
      onKey(e)
      return false
    }
    tabLeaves = e.key === 'Escape'
    // Ctrl+C with output selected copies it (the browser's copy, which the terminal fills), as in any
    // terminal: it never clears the line or stops a command (review 2026-10-12, I9).
    if (isCommand(e) && e.key.toLowerCase() === 'c' && term_.hasSelection()) return false
    // A key the line editor takes is the terminal's alone: never the browser's (Ctrl+R reloaded the
    // page, Ctrl+L went to the address bar) nor the page's (Ctrl+K opened the palette) — second review
    // 2026-10-12, I4.
    if (keyName(e)) {
      e.preventDefault()
      e.stopPropagation()
      onKey(e)
      return false
    }
    // Another Ctrl key (paste, copy, select all) is the browser's; a printable key — AltGr's too —
    // goes on to onData.
    return !isCommand(e)
  })

  session = createShellSession({
    onOpened: (p, db, stillRunning, how) => {
      isOpen.value = true
      closed.value = false
      if (db) emit('db', db)
      prompt = `${p} `
      // A reattach while a command runs: its output goes on, here (review 2026-10-11, I4). After a
      // reload the page did not know: it says so, and only Ctrl+C is taken until it ends (review
      // 2026-10-12, I2: a second command was sent while one ran).
      if (stillRunning) {
        // Code typed meanwhile waits for the command to end, then runs (review 2026-10-12, minor 11).
        if (!running.value || pending !== null) {
          running.value = true
          if (!atLineStart) term_.write(leave())
          term_.write(paint('info', writeSafe(t('shell.stillRunning'))) + '\r\n')
          atLineStart = true
        }
        return
      }
      // A new shell for one nothing was run in: nothing lost, nothing said; the line stays as it is.
      if (how === 'replaced' && !used && !running.value) {
        void loadHistory()
        return render()
      }
      if (how !== 'resumed') used = false
      if (!atLineStart) term_.write(leave())
      if (running.value && pending === null) {
        // It ended while the link was down: what it printed then is lost; what it made is read again.
        running.value = false
        emit('ran')
        term_.write(paint('warning', writeSafe(t('shell.lostRun'))) + '\r\n')
      } else term_.write(openedLine(how) + '\r\n')
      atLineStart = true
      void loadHistory()
      // Code typed while the session opened (shown already) runs now, once. Run in this shell, it
      // is used: its replacement is said (review 2026-10-12, minor 10).
      const waiting = pending
      pending = null
      if (waiting !== null) evaluate(waiting)
      else render()
    },
    onPart: done,
    onSessionId: (id) => keep(id),
    onClosed: (reason) => {
      pending = null
      isOpen.value = false
      closed.value = true
      // What ran before it closed may have made a collection: read again.
      if (running.value) emit('ran')
      running.value = false
      term_.write(
        `${leave()}${paint('warning', writeSafe(t('shell.closed', { reason: reasonText(reason) })))}\r\n`,
      )
      atLineStart = true
    },
    onFailed: (code, message, open, about) => {
      // Review I1: a session that could not open never runs the code that waited for it, later.
      pending = null
      running.value = false
      // An open that failed: closed, with a new shell offered (review 2026-10-11).
      if (open) {
        isOpen.value = false
        closed.value = true
      }
      // Seventh review (M2): a connection's failure in the page's language; a kept refusal says so.
      const said =
        about?.kind && te(`mongo.kinds.${about.kind}`)
          ? `${t(`mongo.kinds.${about.kind}`, { min: MIN_MONGODB_VERSION })}${about.remembered ? ` ${t('mongo.remembered')}` : ''}`
          : message
      term_.write(`${leave()}${paint('error', writeSafe(said))}\r\n`)
      atLineStart = true
    },
  })
  // The tab's session from before a reload: the same shell again, its variables kept.
  session.open(props.connectionId, props.db, kept())
  window.addEventListener('resize', onResize)
  // A shell tab stays mounted while hidden (review I3): it fits again when it shows.
  if (typeof ResizeObserver !== 'undefined' && host.value) {
    sized = new ResizeObserver(onResize)
    sized.observe(host.value)
  }
})

async function loadWebgl(term_: Terminal): Promise<void> {
  try {
    const { WebglAddon } = await import('@xterm/addon-webgl')
    term_.loadAddon(new WebglAddon())
  } catch {
    // The DOM renderer is used instead.
  }
}

const onResize = () => {
  try {
    fit?.fit()
  } catch {
    // ignore
  }
  // The terminal reflows the line on its new width: where its cursor is now, read from it.
  const term_ = term.value
  if (!line || !term_) return
  const buffer = term_.buffer?.active
  line =
    lineStart && !lineStart.isDisposed && buffer
      ? lineAfterResize(
          buffer.baseY + buffer.cursorY - lineStart.line,
          ...lineParts(),
          term_.cols,
          term_.rows,
          lineOptions,
          // A tall line keeps showing the rows it showed (review 2026-10-12, minor 17).
          line.top,
        )
      : drawLine(NOT_DRAWN, ...lineParts(), term_.cols, term_.rows, undefined, lineOptions).state
}

// The theme follows the app's, light or dark and its accent.
watch(
  () => [preferences.dark, preferences.accent, preferences.terminalTheme] as const,
  ([dark]) => {
    if (term.value) term.value.options.theme = terminalTheme(dark, undefined, preferences.terminalTheme)
  },
  { flush: 'post' },
)

// W5 (spec 3a-1 §10.6): screen-reader mode, switched in Preferences, applies to an open terminal too.
watch(
  () => preferences.screenReader,
  (on) => {
    if (term.value) term.value.options.screenReaderMode = on
  },
)

function reopen(): void {
  closed.value = false
  isOpen.value = false
  editor.setHistory([])
  session?.open(props.connectionId, props.db)
}

/**
 * Clears the screen; the line being typed stays. The page clears its results with it (user request
 * 2026-10-13: "ekranı temizle sonuçlarıda temizlesin"), by the button, Ctrl+L or cls alike.
 */
function clear(): void {
  emit('cleared')
  line = null
  const term_ = term.value
  if (!term_) return
  // The terminal writes what it is given later, in order, while clear() acts at once: cleared after
  // what is already on its way — the line `cls` was typed on stayed otherwise (user report 2026-10-15).
  term_.write('', () => {
    term_.clear()
    // The prompt only where one may type (not while a command runs, connecting or closed).
    if (status.value === 'ready') render()
  })
}

/** Ends this session (its variables with it) and opens a new one on the database first opened. */
function restart(): void {
  pending = null
  running.value = false
  session?.close()
  term.value?.write(`${leave()}${paint('info', writeSafe(t('shell.restarting')))}\r\n`)
  emit('db', props.db)
  reopen()
}

let sized: ResizeObserver | undefined
onBeforeUnmount(() => {
  sized?.disconnect()
  window.removeEventListener('resize', onResize)
  session?.close()
  session?.dispose()
  term.value?.dispose()
})

/**
 * Phase 3a-2: Tab completes the line. One candidate is inserted; several are listed under the line
 * (through writeSafe: a label is database text) and the line is drawn again.
 */
async function completeInTerminal(): Promise<void> {
  if (!props.completer || editor.searching) return
  const buffer = editor.buffer
  const cursor = editor.cursor
  const result = await props.completer(buffer, cursor)
  // Nothing to do, or the line changed (or a command started) while we waited.
  if (!result || result.items.length === 0 || editor.buffer !== buffer || running.value) return
  if (result.items.length === 1) {
    const only = result.items[0]!
    editor.replaceRange(result.from, cursor, only.insert ?? only.label)
    return render()
  }
  term.value?.write(`${leave()}${writeSafe(result.items.map((i) => i.label).join('  '))}\r\n`)
  render()
}

/**
 * Whether anything was run in this session: a new one in place of an unused one (the server
 * restarted, say) loses nothing and is opened without a word (user report 2026-10-12).
 */
let used = false

/** Esc was the last key: the next Tab leaves the terminal instead of completing. */
let tabLeaves = false

/** Code typed before the session opened: it runs once the session opens. */
let pending: string | null = null

/**
 * Runs code from outside the terminal (the result pane's "it"): echoed after the prompt as typed code
 * is (each line after "... "), through writeSafe, and run the same way. The line being typed stays, drawn
 * again after it. Refused (false) while a command runs or after the session closed.
 */
function run(code: string): boolean {
  const term_ = term.value
  if (!term_ || !session || closed.value || running.value || !code.trim()) return false
  term_.write(line ? clearLine(line) : '\r\x1b[K')
  line = null
  term_.write(leaveLine(NOT_DRAWN, promptText(), writeSafe(code), term_.cols, '', highlight, lineOptions))
  atLineStart = true
  submit(code)
  return true
}

/**
 * Puts code in the line being typed, at the cursor (a filled snippet): read there, and run with Enter;
 * the terminal takes the focus. Not while a command runs, nor past the line's limit: the caller says
 * so (review 2026-10-12, minor 8: it was dropped without a word).
 */
function insert(code: string): 'inserted' | 'running' | 'tooLarge' {
  if (running.value) return 'running'
  if (editor.searching) editor.key('Escape')
  const text = pasted(code)
  if (!lineFits(editor.buffer + text)) return 'tooLarge'
  editor.input(text)
  render()
  term.value?.focus()
  return 'inserted'
}

/**
 * `exit` or `quit`: the shell ends, as in mongosh (review 2026-10-12, I12: they closed its MongoDB
 * client and left it so); a new one opens with Enter, or the button under it.
 */
function end(): void {
  pending = null
  running.value = false
  session?.close()
  isOpen.value = false
  closed.value = true
  term.value?.write(`${paint('warning', writeSafe(t('shell.closed', { reason: reasonText('exit') })))}\r\n`)
  atLineStart = true
}

/** What "Save as snippet" saves: the line being typed, else the last code run. */
const current = (): string => (editor.buffer.trim() ? editor.buffer : lastCode)

/**
 * Stops what runs (the shell leaves the rest of a script unrun). Code still waiting for the session is
 * forgotten; code waiting for a command still running after a reload is forgotten, and that command
 * stopped.
 */
function cancel(): void {
  if (pending !== null && !isOpen.value) {
    pending = null
    running.value = false
    term.value?.write(leave('^C'))
    render()
    return
  }
  pending = null
  session?.cancel()
}

function complete(code: string): Promise<string[]> {
  return session ? session.complete(code) : Promise.resolve([])
}

defineExpose({
  clearHistory,
  run,
  insert,
  current,
  cancel,
  complete,
  clear,
  restart,
  reopen,
  running: readonly(running),
  status,
  runningSince: readonly(runningSince),
})
</script>

<template>
  <section class="flex h-full min-h-0 flex-col bg-surface" data-shell :data-status="status">
    <!-- The padding is the wrapper's: fit sizes the terminal from its host's box (review I5). -->
    <div
      class="min-h-0 flex-1 py-2 pr-1 pl-3"
      :style="surface ? { backgroundColor: surface } : undefined"
      data-shell-surface
    >
      <div
        ref="host"
        class="h-full"
        role="group"
        :aria-label="terminalLabel"
        :aria-describedby="`${uid}-keys`"
      ></div>
      <!-- How to complete and how to leave, said to a screen reader (review M9). -->
      <p :id="`${uid}-keys`" class="sr-only">{{ t('shell.keysHint') }}</p>
    </div>
    <!-- In the flow, never over the terminal's last lines (where it says why it closed). -->
    <div
      v-if="closed"
      class="flex shrink-0 flex-wrap items-center gap-3 border-t border-line bg-subtle px-3 py-2 text-ui"
      role="status"
      data-shell-closed
    >
      <span class="text-fg-muted">{{ t('shell.closedShort') }}</span>
      <DsButton size="sm" variant="primary" :icon="RotateCcw" @click="reopen">{{
        t('shell.openNew')
      }}</DsButton>
    </div>
  </section>
</template>
