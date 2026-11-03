import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '../src/i18n'
import { useShellInbox } from '../src/stores/shellInbox'
import { mockApi, mountApp } from './support/app'

type Msg = { ch: string; type: string; payload: Record<string, unknown> }
interface FakeTerminal {
  options: Record<string, unknown>
  written: string[]
  osc: number[]
  dcs: number
  dcsIds: string[]
  textarea: HTMLTextAreaElement
  dataHandler: ((d: string) => void) | null
  keyHandler: ((e: KeyboardEvent) => boolean) | null
  /** How many times the terminal was given the focus. */
  focused: number
  /** Whether output is selected (Ctrl+C then copies). */
  selected: boolean
  /**
   * As xterm does: writes are parsed later, in order; clear() acts at once. Off by default (the
   * written text is then there at once).
   */
  asyncWrites: boolean
  /** Writes the queued output, running each write's callback after it. */
  flush(): void
}
interface FakeSocket {
  state: { value: string }
  sent: Array<Record<string, unknown>>
  emit(m: Msg): void
  /** The socket takes nothing (the link down): send answers false. */
  refuse: boolean
}

// Shared capture arrays, hoisted with the mocks (vi.mock is lifted to the top of the file).
const { terminals, sockets } = vi.hoisted(() => ({
  terminals: [] as FakeTerminal[],
  sockets: [] as FakeSocket[],
}))

/** Where the fake terminal's screen was cleared, among what it was given to write. */
const CLEARED = '\u0000cleared\u0000'

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options: Record<string, unknown>
    written: string[] = []
    osc: number[] = []
    dcs = 0
    dcsIds: string[] = []
    dataHandler: ((d: string) => void) | null = null
    textarea = document.createElement('textarea')
    keyHandler: ((e: KeyboardEvent) => boolean) | null = null
    parser = {
      registerOscHandler: (code: number) => this.osc.push(code),
      registerDcsHandler: (id: { intermediates?: string; final: string }) => {
        this.dcs += 1
        this.dcsIds.push((id.intermediates ?? '') + id.final)
      },
    }
    constructor(options: Record<string, unknown>) {
      this.options = options
      terminals.push(this as unknown as FakeTerminal)
    }
    loadAddon() {}
    selected = false
    open(host?: HTMLElement) {
      host?.appendChild(this.textarea)
    }
    hasSelection() {
      return this.selected
    }
    asyncWrites = false
    pending: Array<[string, (() => void) | undefined]> = []
    write(s: string, done?: () => void) {
      if (!this.asyncWrites) {
        this.written.push(s)
        done?.()
      } else this.pending.push([s, done])
    }
    flush() {
      while (this.pending.length) {
        const [s, done] = this.pending.shift()!
        this.written.push(s)
        done?.()
      }
    }
    focused = 0
    // As xterm: everything goes but the cursor's row, which becomes the first.
    clear() {
      if (!this.asyncWrites) return
      const all = this.written.join('')
      this.written.push(CLEARED + all.slice(all.lastIndexOf('\n') + 1))
    }
    dispose() {}
    focus() {
      this.focused += 1
      this.textarea.focus()
    }
    onData(fn: (d: string) => void) {
      this.dataHandler = fn
    }
    attachCustomKeyEventHandler(fn: (e: KeyboardEvent) => boolean) {
      this.keyHandler = fn
    }
  },
}))
vi.mock('@xterm/xterm/css/xterm.css', () => ({}))
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}))
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: class {} }))
const { historyMock } = vi.hoisted(() => ({
  historyMock: {
    entries: [] as Array<{ id: string; code: string; usedAt: number; count: number }>,
    /** Clearing the history fails (the server refused it). */
    clearFails: false,
    cleared: 0,
  },
}))
vi.mock('../src/api/shell', () => ({
  shellApi: {
    history: () => Promise.resolve(historyMock),
    clearHistory: () => {
      if (historyMock.clearFails) return Promise.reject(new Error('refused'))
      historyMock.cleared++
      return Promise.resolve()
    },
  },
}))
vi.mock('../src/jobs/live', async () => {
  const { ref } = await import('vue')
  return {
    realtimeSocket: () => {
      const s = {
        state: ref('open'),
        sent: [] as Array<Record<string, unknown>>,
        receivers: [] as Array<(m: Msg) => void>,
        receiver(_k: string, _ch: string, on: (m: Msg) => void) {
          s.receivers.push(on)
          return () => {}
        },
        refuse: false,
        send(m: Record<string, unknown>) {
          if (s.refuse) return false
          s.sent.push(m)
          return true
        },
        /** As the server tags them: the last open's ref on opened/failed, the session on the rest. */
        session: '',
        emit(m: Msg) {
          const open = [...s.sent].reverse().find((x) => x.type === 'open')
          const payload = { ...m.payload }
          if (m.type === 'opened' || (m.type === 'failed' && !('sessionId' in payload))) {
            if (!('ref' in payload) && open && !s.sent.some((x) => x.type === 'attach'))
              payload.ref = open.ref
            if (m.type === 'opened') s.session = String(payload.sessionId)
          } else if (!('sessionId' in payload)) payload.sessionId = s.session
          s.receivers.forEach((r) => r({ ...m, payload }))
        },
      }
      sockets.push(s as unknown as FakeSocket)
      return s
    },
  }
})

import ShellView from '../src/shell/ShellView.vue'
import { SGR } from '../src/shell/terminalTheme'
import { COLOR_CLASSES } from '../src/connections/colors'
import { usePreferencesStore } from '../src/stores/preferences'

/** What the terminal shows, without the app's own colours and cursor moves. */
const SGR_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, 'g')
const plain = (text: string) => text.replace(SGR_SEQUENCE, '')
import ShellWorkspace from '../src/shell/ShellWorkspace.vue'
import { useDialogStore } from '../src/stores/dialogs'

beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
  terminals.length = 0
  sockets.length = 0
  // The terminal label reads the connection list; answer it here so no test reaches the network.
  mockApi({ 'GET connections': () => [200, []] })
})
afterEach(() => {
  vi.clearAllMocks()
  document.body.innerHTML = ''
})

function mountShell(extra: Record<string, unknown> = {}) {
  return mountApp(ShellView, { props: { connectionId: 'c1', db: 'shop', ...extra } })
}
type ShellApi = {
  run(code: string): boolean
  cancel(): void
  complete(code: string): Promise<string[]>
}
const api = (wrapper: { vm: unknown }) => wrapper.vm as ShellApi
const socket = () => sockets.at(-1)!
const term = () => terminals.at(-1)!
const key = (init: KeyboardEventInit) =>
  term().keyHandler!(new KeyboardEvent('keydown', init) as KeyboardEvent)
/** A paste as xterm hands one over with bracketed paste on: its line ends as CR, between marks. */
const paste = (text: string) => term().dataHandler!(`\x1b[200~${text}\x1b[201~`)

describe('ShellView (phase 3a-1 §10)', () => {
  it('creates the terminal with the hardened options and swallows OSC/DCS', async () => {
    mountShell()
    await flushPromises()
    expect(term().options).toMatchObject({ allowProposedApi: false, scrollback: 5000, windowOptions: {} })
    for (const code of [52, 8, 0, 1337]) expect(term().osc).toContain(code)
    expect(term().dcs).toBeGreaterThan(0)
  })

  it('swallows every DCS sequence, not only sixel (review M3)', async () => {
    mountShell()
    await flushPromises()
    // sixel (q), DECRQSS ($q), XTGETTCAP (+q), and other finals with and without an intermediate.
    for (const id of ['q', '$q', '+q', 'p', '|', '$p', '!|']) expect(term().dcsIds, id).toContain(id)
  })

  it('opens a session and, once opened, runs a command on Enter', async () => {
    mountShell()
    await flushPromises()
    expect(socket().sent).toContainEqual({
      ch: 'shell',
      type: 'open',
      connectionId: 'c1',
      db: 'shop',
      ref: expect.stringMatching(/^[A-Za-z0-9_-]{1,64}$/),
    })
    socket().emit({ ch: 'shell', type: 'opened', payload: { sessionId: 's1', prompt: 'rs0>' } })
    // Type "1+1" then Enter.
    for (const ch of '1+1') term().dataHandler!(ch)
    key({ key: 'Enter' })
    expect(socket().sent.some((m) => m.type === 'eval' && m.code === '1+1')).toBe(true)
  })

  it('writes a result through writeSafe (control bytes escaped)', async () => {
    mountShell()
    await flushPromises()
    socket().emit({ ch: 'shell', type: 'opened', payload: { sessionId: 's1', prompt: 'rs0>' } })
    socket().emit({ ch: 'shell', type: 'print', payload: { text: 'a\u001b]52;c;x\u0007b' } })
    expect(plain(term().written.join(''))).toContain('\\x1b')
    expect(plain(term().written.join(''))).toContain('\\x07')
  })

  it('cancels a running command with Ctrl+C', async () => {
    mountShell()
    await flushPromises()
    socket().emit({ ch: 'shell', type: 'opened', payload: { sessionId: 's1', prompt: 'rs0>' } })
    for (const ch of 'sleep(9)') term().dataHandler!(ch)
    key({ key: 'Enter' })
    key({ key: 'c', ctrlKey: true })
    expect(socket().sent.some((m) => m.type === 'cancel')).toBe(true)
  })

  it('loads the server history so the Up arrow recalls the last command (phase 3a-1)', async () => {
    historyMock.entries = [
      { id: '2', code: 'db.b.find()', usedAt: 2, count: 1 },
      { id: '1', code: 'use shop', usedAt: 1, count: 1 },
    ]
    mountShell()
    await flushPromises()
    socket().emit({ ch: 'shell', type: 'opened', payload: { sessionId: 's1', prompt: 'rs0>' } })
    await flushPromises()
    key({ key: 'ArrowUp' })
    expect(plain(term().written.join(''))).toContain('db.b.find()')
    historyMock.entries = []
  })

  it('labels the terminal with the connection name and the database (spec §10, review M4)', async () => {
    mockApi({ 'GET connections': () => [200, [{ id: 'c1', name: 'Prod cluster', permissions: [] }]] })
    const { wrapper } = mountShell()
    await flushPromises()
    const label = wrapper.find('[data-shell] [role="group"]').attributes('aria-label') ?? ''
    expect(label).toContain('Prod cluster')
    expect(label).toContain('shop')
  })

  it('shows the reset notice and offers a new shell after it closes', async () => {
    const { wrapper } = mountShell()
    await flushPromises()
    socket().emit({ ch: 'shell', type: 'opened', payload: { sessionId: 's1', prompt: 'rs0>' } })
    socket().emit({ ch: 'shell', type: 'reset', payload: {} })
    expect(plain(term().written.join(''))).toContain('reset')
    socket().emit({ ch: 'shell', type: 'closed', payload: { reason: 'idle' } })
    await flushPromises()
    expect(wrapper.text()).toContain('Open a new shell')
  })
})

describe('ShellView run(): code from outside the terminal, and code waiting for its session', () => {
  // User request 2026-10-10 (found by e2e): a tab opened again starts its session anew; code run from
  // before it opens waits for it, once, instead of being dropped without a word.
  it('runs code sent before the session opened once it opens, and only that one', async () => {
    const { wrapper } = mountShell()
    await flushPromises()
    expect(api(wrapper).run('db.a.insertOne({ v: 1 })')).toBe(true)
    expect(api(wrapper).run('print(2)')).toBe(false)
    expect(socket().sent.some((m) => m.type === 'eval')).toBe(false)
    socket().emit({ ch: 'shell', type: 'opened', payload: { sessionId: 's1', prompt: 'shop>' } })
    await flushPromises()
    expect(socket().sent.filter((m) => m.type === 'eval')).toEqual([
      { ch: 'shell', type: 'eval', sessionId: 's1', id: 1, code: 'db.a.insertOne({ v: 1 })' },
    ])
    expect(plain(term().written.join(''))).toContain('> db.a.insertOne({ v: 1 })')
  })

  // Review I1, I2: waiting code is shown and running at once, can be cancelled, and never outlives a
  // failed or closed session — it never runs later on its own.
  it('shows waiting code at once, as running, and Ctrl+C forgets it', async () => {
    const { wrapper } = mountShell()
    await flushPromises()
    expect(api(wrapper).run('db.x.deleteMany({})')).toBe(true)
    expect(plain(term().written.join(''))).toContain('db.x.deleteMany({})')
    expect((wrapper.vm as unknown as { running: boolean }).running).toBe(true)
    api(wrapper).cancel()
    expect((wrapper.vm as unknown as { running: boolean }).running).toBe(false)
    socket().emit({ ch: 'shell', type: 'opened', payload: { sessionId: 's1', prompt: 'shop>' } })
    await flushPromises()
    expect(socket().sent.some((m) => m.type === 'eval' || m.type === 'cancel')).toBe(false)
  })

  it('forgets waiting code when the session cannot open, so a later open runs nothing', async () => {
    const { wrapper } = mountShell()
    await flushPromises()
    expect(api(wrapper).run('db.x.deleteMany({})')).toBe(true)
    socket().emit({ ch: 'shell', type: 'failed', payload: { code: 'LIMIT', message: 'Too many shells' } })
    await flushPromises()
    expect((wrapper.vm as unknown as { running: boolean }).running).toBe(false)
    socket().emit({ ch: 'shell', type: 'opened', payload: { sessionId: 's1', prompt: 'shop>' } })
    await flushPromises()
    expect(socket().sent.some((m) => m.type === 'eval')).toBe(false)
  })

  it('waits for a new shell opened after one closed, as for the first', async () => {
    const { wrapper } = mountShell()
    await flushPromises()
    socket().emit({ ch: 'shell', type: 'opened', payload: { sessionId: 's1', prompt: 'shop>' } })
    socket().emit({ ch: 'shell', type: 'closed', payload: { reason: 'idle' } })
    await flushPromises()
    ;[...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((b) => b.textContent?.includes('Open a new shell'))!
      .click()
    await flushPromises()
    expect(api(wrapper).run('print(1)')).toBe(true)
    expect(socket().sent.some((m) => m.type === 'eval')).toBe(false)
    socket().emit({ ch: 'shell', type: 'opened', payload: { sessionId: 's2', prompt: 'shop>' } })
    await flushPromises()
    expect(socket().sent.filter((m) => m.type === 'eval')).toEqual([
      { ch: 'shell', type: 'eval', sessionId: 's2', id: 1, code: 'print(1)' },
    ])
  })

  // User report 2026-10-12: an aggregation pasted after `use shop` never ran — mongosh took the query
  // for `use`'s words. Code of many lines is one command: the shell runs it piece by piece.
  it('runs code of many lines as one command, echoed after "...", escaped, each result named by its piece', async () => {
    const results: Array<{ command?: string }> = []
    const { wrapper } = mountShell({ onResult: (r: { command?: string }) => results.push(r) })
    await flushPromises()
    socket().emit({ ch: 'shell', type: 'opened', payload: { sessionId: 's1', prompt: 'shop>' } })
    expect(api(wrapper).run('use shop\ndb.a.insertOne({})\nprint("\u0007")')).toBe(true)
    const written = plain(term().written.join(''))
    expect(written).toContain('shop> use shop')
    expect(written).toContain('... db.a.insertOne({})')
    expect(written).toContain('... print("\\x07")')
    const evals = () =>
      socket()
        .sent.filter((m) => m.type === 'eval')
        .map((m) => m.code)
    expect(evals()).toEqual(['use shop\ndb.a.insertOne({})\nprint("\u0007")'])
    // While it runs, another run is refused and sends nothing.
    expect(api(wrapper).run('print(2)')).toBe(false)
    socket().emit({
      ch: 'shell',
      type: 'result',
      payload: { id: 1, resultType: null, value: 'x', command: 'use shop' },
    })
    socket().emit({
      ch: 'shell',
      type: 'result',
      payload: { id: 1, resultType: null, value: 'y', command: 'db.a.insertOne({})' },
    })
    expect(results.map((r) => r.command)).toEqual(['use shop', 'db.a.insertOne({})'])
    socket().emit({ ch: 'shell', type: 'done', payload: { id: 1, prompt: 'shop>' } })
    expect((wrapper.vm as unknown as { running: boolean }).running).toBe(false)
    expect(evals()).toHaveLength(1)
  })

  // Review 2026-10-12 (I8): the statements an error left unrun were never mentioned.
  it('says how many statements an error left unrun', async () => {
    const { wrapper } = mountShell()
    await flushPromises()
    socket().emit({ ch: 'shell', type: 'opened', payload: { sessionId: 's1', prompt: '>' } })
    api(wrapper).run('a()\nb()\nc()')
    const before = term().written.length
    socket().emit({ ch: 'shell', type: 'error', payload: { id: 1, message: 'a is not defined', skipped: 2 } })
    socket().emit({ ch: 'shell', type: 'done', payload: { id: 1, prompt: '>' } })
    const shown = plain(term().written.slice(before).join(''))
    expect(shown).toContain('a is not defined')
    expect(shown).toContain(i18n.global.t('shell.skipped', 2))
    expect((wrapper.vm as unknown as { running: boolean }).running).toBe(false)
  })

  // User report 2026-10-12: "terminale direk yapıştıramıyorum… \x0d gibi terimler geliyor".
  it('takes a paste of many lines into the line, its CRs as newlines, run only on Enter', async () => {
    mountShell()
    await flushPromises()
    socket().emit({ ch: 'shell', type: 'opened', payload: { sessionId: 's1', prompt: 'shop>' } })
    const before = term().written.length
    paste('use shop\rdb.orders.aggregate([\r  { $match: {} },\r])\r')
    const shown = plain(term().written.slice(before).join(''))
    expect(shown).not.toContain('\\x0d')
    expect(shown).not.toContain('200~')
    expect(shown).toContain('shop> use shop')
    expect(shown).toContain('... db.orders.aggregate([')
    expect(shown).toContain('...   { $match: {} },')
    expect(socket().sent.some((m) => m.type === 'eval')).toBe(false)
    key({ key: 'Enter' })
    expect(
      socket()
        .sent.filter((m) => m.type === 'eval')
        .map((m) => m.code),
    ).toEqual(['use shop\ndb.orders.aggregate([\n  { $match: {} },\n])'])
  })

  it('says a paste too large for the line was not taken, and leaves the line as it was', async () => {
    mountShell()
    await flushPromises()
    socket().emit({ ch: 'shell', type: 'opened', payload: { sessionId: 's1', prompt: 'shop>' } })
    term().dataHandler!('db.x')
    const before = term().written.length
    paste(`db.x.insertOne({ a: '${'x'.repeat(70 * 1024)}' })`)
    const shown = plain(term().written.slice(before).join(''))
    expect(shown).toContain(i18n.global.t('shell.pasteTooLarge'))
    expect(shown).not.toContain('insertOne')
    expect(shown.endsWith('shop> db.x')).toBe(true)
  })

  it('runs nothing for a blank line, and gives a new prompt', async () => {
    const { wrapper } = mountShell()
    await flushPromises()
    socket().emit({ ch: 'shell', type: 'opened', payload: { sessionId: 's1', prompt: 'shop>' } })
    term().dataHandler!('   ')
    const before = term().written.length
    key({ key: 'Enter' })
    expect(socket().sent.some((m) => m.type === 'eval')).toBe(false)
    expect((wrapper.vm as unknown as { running: boolean }).running).toBe(false)
    expect(plain(term().written.slice(before).join(''))).toContain('shop> ')
  })

  // User report 2026-10-15: after cls the line it was typed on stayed on the screen. The terminal
  // writes later what it is given, while clear() acts at once: the line was written after the clear.
  it('leaves nothing of cls on the screen, its own line included', async () => {
    mountShell({ sessionKey: 'tab-cls' })
    await flushPromises()
    socket().emit({ ch: 'shell', type: 'opened', payload: { sessionId: 's1', prompt: 'shop>' } })
    const t = term()
    t.flush()
    t.asyncWrites = true
    t.dataHandler!('cls')
    key({ key: 'Enter' })
    t.flush()
    const all = t.written.join('')
    expect(all).toContain(CLEARED)
    const screen = plain(all.slice(all.lastIndexOf(CLEARED) + CLEARED.length))
    expect(screen).not.toContain('cls')
    expect(screen.match(/shop> /g)).toHaveLength(1)
  })

  // Review 2026-10-12 (I12): `exit` closed the shell's MongoDB client and left it so; `cls` did nothing.
  it('clears the screen for cls and ends the shell for exit or quit, running neither', async () => {
    const { wrapper } = mountShell({ sessionKey: 'tab-x' })
    await flushPromises()
    socket().emit({ ch: 'shell', type: 'opened', payload: { sessionId: 's1', prompt: 'shop>' } })
    const cleared = vi.spyOn(term() as unknown as { clear(): void }, 'clear')
    term().dataHandler!('cls')
    key({ key: 'Enter' })
    expect(cleared).toHaveBeenCalled()
    term().dataHandler!('exit')
    key({ key: 'Enter' })
    expect(socket().sent.some((m) => m.type === 'eval')).toBe(false)
    expect(socket().sent.at(-1)).toMatchObject({ type: 'close', sessionId: 's1' })
    await flushPromises()
    expect(wrapper.find('[data-shell-closed]').exists()).toBe(true)
    expect(plain(term().written.join(''))).toContain(i18n.global.t('shell.reasons.exit'))
    expect(sessionStorage.getItem('mm:shell-session:tab-x')).toBeNull()
    // Enter after it opens a new shell, as after any close.
    term().dataHandler!('db.x.find()')
    key({ key: 'Enter' })
    expect(socket().sent.at(-1)).toMatchObject({ type: 'open' })
  })

  // Review 2026-10-12 (minor 11): code that could not be sent stayed "running".
  it('says code that could not be sent did not run, the line free again', async () => {
    const { wrapper } = mountShell()
    await flushPromises()
    socket().emit({ ch: 'shell', type: 'opened', payload: { sessionId: 's1', prompt: 'shop>' } })
    socket().refuse = true
    term().dataHandler!('db.x.find()')
    key({ key: 'Enter' })
    expect((wrapper.vm as unknown as { running: boolean }).running).toBe(false)
    expect(plain(term().written.join(''))).toContain(i18n.global.t('shell.notSent'))
  })

  // Review 2026-10-12 (I2): code the reader takes for open could not run once the editor was gone.
  it('runs the line as it is with Ctrl+Enter', async () => {
    mountShell()
    await flushPromises()
    socket().emit({ ch: 'shell', type: 'opened', payload: { sessionId: 's1', prompt: 'shop>' } })
    term().dataHandler!('db.x.find({')
    key({ key: 'Enter' })
    expect(socket().sent.some((m) => m.type === 'eval')).toBe(false)
    key({ key: 'Enter', ctrlKey: true })
    expect(
      socket()
        .sent.filter((m) => m.type === 'eval')
        .map((m) => m.code),
    ).toEqual(['db.x.find({\n'])
  })

  it('asks the worker to complete and resolves on the matching reply', async () => {
    const { wrapper } = mountShell()
    await flushPromises()
    socket().emit({ ch: 'shell', type: 'opened', payload: { sessionId: 's1', prompt: '>' } })
    const pending = api(wrapper).complete('c.f')
    const sent = socket().sent.find((m) => m.type === 'complete')!
    expect(sent).toMatchObject({ ch: 'shell', type: 'complete', sessionId: 's1', code: 'c.f' })
    socket().emit({ ch: 'shell', type: 'completions', payload: { id: 999, items: ['wrong'] } })
    socket().emit({ ch: 'shell', type: 'completions', payload: { id: sent.id, items: ['c.find', 7] } })
    await expect(pending).resolves.toEqual(['c.find'])
  })

  it('answers no completion after 3 s without a reply', async () => {
    const { wrapper } = mountShell()
    await flushPromises()
    socket().emit({ ch: 'shell', type: 'opened', payload: { sessionId: 's1', prompt: '>' } })
    vi.useFakeTimers()
    const pending = api(wrapper).complete('db.')
    await vi.advanceTimersByTimeAsync(3000)
    await expect(pending).resolves.toEqual([])
    vi.useRealTimers()
  })

  it('completes in the terminal with Tab: one candidate is inserted, several are listed', async () => {
    const one = vi.fn(async () => ({
      from: 0,
      items: [{ label: 'db', kind: 'command' as const, insert: 'db' }],
    }))
    mountShell({ completer: one })
    await flushPromises()
    socket().emit({ ch: 'shell', type: 'opened', payload: { sessionId: 's1', prompt: '>' } })
    term().dataHandler!('d')
    key({ key: 'Tab' })
    await flushPromises()
    expect(one).toHaveBeenCalledWith('d', 1)
    expect(plain(term().written.at(-1) ?? '')).toContain('> db')
    document.body.innerHTML = ''
    const many = vi.fn(async () => ({
      from: 0,
      items: [
        { label: 'show', kind: 'command' as const, insert: 'show' },
        { label: 'sh\u001b[2J', kind: 'command' as const, insert: 'sh' },
      ],
    }))
    mountShell({ completer: many })
    await flushPromises()
    socket().emit({ ch: 'shell', type: 'opened', payload: { sessionId: 's2', prompt: '>' } })
    term().dataHandler!('s')
    key({ key: 'Tab' })
    await flushPromises()
    const written = plain(term().written.join(''))
    expect(written).toContain('show')
    expect(written).toContain('\\x1b[2J')
    expect(written).not.toContain('\u001b[2J')
  })
})

describe('ShellWorkspace: the terminal and its results (phase 3a-2)', () => {
  function mountWorkspace() {
    mockApi({
      'GET connections': () => [200, []],
      'GET connections/c1/databases/shop/collections': () => [200, [{ name: 'orders', type: 'collection' }]],
    })
    return mountApp(ShellWorkspace, { props: { connectionId: 'c1', db: 'shop' } })
  }

  // User report 2026-10-12: "sağ taraftaki sonuçlar kullanımın kullanışsız" — a narrow pane, its width
  // forgotten on every visit.
  it('gives the results the whole width when asked, the terminal kept running out of sight', async () => {
    const { wrapper } = mountWorkspace()
    await flushPromises()
    socket().emit({ ch: 'shell', type: 'opened', payload: { sessionId: 's1', prompt: '>' } })
    socket().emit({
      ch: 'shell',
      type: 'result',
      payload: { id: 1, resultType: 'Cursor', value: [{ a: 1 }], hasMore: false },
    })
    socket().emit({ ch: 'shell', type: 'done', payload: { id: 1, prompt: '>' } })
    await flushPromises()
    const terminal = () => wrapper.find('[data-shell-terminal-column]')
    const results = () => wrapper.find('[data-shell-results-column]')
    expect(terminal().classes()).not.toContain('lg:hidden')
    await wrapper.find('[data-result-wide]').trigger('click')
    expect(terminal().classes()).toContain('lg:hidden')
    expect(results().classes()).toContain('lg:flex-1')
    // Never wider than the page: it shrinks to fit, its table scrolling inside.
    expect(results().classes()).toContain('min-w-0')
    expect(results().classes()).not.toContain('shrink-0')
    // The terminal is hidden, never gone: its session stays.
    expect(wrapper.find('[data-shell]').exists()).toBe(true)
    await wrapper.find('[data-result-wide]').trigger('click')
    expect(terminal().classes()).not.toContain('lg:hidden')
  })

  it('remembers the results’ width once a drag ends, and lets them take all but the terminal’s least', async () => {
    localStorage.removeItem('mm:shell-results-width')
    const first = mountWorkspace().wrapper
    await flushPromises()
    const handle = () => first.find('[data-shell-results-column] [role="separator"]')
    for (let i = 0; i < 5; i++) await handle().trigger('keydown', { key: 'ArrowLeft' })
    const width = Number(handle().attributes('aria-valuenow'))
    expect(width).toBeGreaterThan(440)
    // Written once the moving stops, never on every step (review 2026-10-12, M16).
    expect(localStorage.getItem('mm:shell-results-width')).toBeNull()
    await vi.waitFor(() => expect(localStorage.getItem('mm:shell-results-width')).toBe(String(width)))
    first.unmount()
    const again = mountWorkspace().wrapper
    await flushPromises()
    expect(again.find('[data-shell-results-column]').attributes('style')).toContain(`--results-w: ${width}px`)
    again.unmount()
    // Before the page is measured, at most 900: the terminal's first fit never squeezed.
    localStorage.setItem('mm:shell-results-width', '1200')
    const unmeasured = mountWorkspace().wrapper
    await flushPromises()
    expect(unmeasured.find('[data-shell-results-column]').attributes('style')).toContain('--results-w: 900px')
    unmeasured.unmount()
    // Measured wide, no cap but the terminal's least.
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(private readonly on: (entries: Array<{ contentRect: { width: number } }>) => void) {}
        observe() {
          this.on([{ contentRect: { width: 2000 } }])
        }
        disconnect() {}
      },
    )
    const wide = mountWorkspace().wrapper
    await flushPromises()
    expect(wide.find('[data-shell-results-column]').attributes('style')).toContain('--results-w: 1200px')
    wide.unmount()
    vi.unstubAllGlobals()
    // A value tampered with is not taken.
    for (const bad of ['NaN', '-5', '1e9', 'abc', '']) {
      localStorage.setItem('mm:shell-results-width', bad)
      const w = mountWorkspace().wrapper
      await flushPromises()
      expect(w.find('[data-shell-results-column]').attributes('style')).toContain('--results-w: 440px')
      w.unmount()
    }
    localStorage.removeItem('mm:shell-results-width')
  })

  // User request 2026-10-12: the theme chosen where the terminal is; Tab's keys in the status bar.
  it('offers the terminal’s theme in its header, and names Tab’s keys', async () => {
    const { wrapper } = mountWorkspace()
    await flushPromises()
    const trigger = wrapper.find('[data-shell-theme] button')
    expect(trigger.attributes('aria-label')).toBe('Terminal theme')
    await trigger.trigger('click')
    await flushPromises()
    expect(document.querySelectorAll('[data-terminal-themes] [role="radio"]')).toHaveLength(9)
    const keys = wrapper.find('[data-shell-statusbar]').text()
    expect(keys).toContain('complete')
    expect(keys).toContain('leave the terminal')
  })

  // User request 2026-10-12 ("kod düzenleyici alanını kaldır"): the terminal is the one place to type.
  it('has no script editor: the terminal is all its column holds', async () => {
    const { wrapper } = mountWorkspace()
    await flushPromises()
    for (const gone of [
      '[data-shell-editor]',
      '[data-shell-script]',
      '[data-shell-run]',
      '[data-shell-editor-toggle]',
    ])
      expect(wrapper.find(gone).exists(), gone).toBe(false)
    expect(wrapper.find('[data-shell-terminal-column] [data-shell]').exists()).toBe(true)
  })

  // Found by e2e 2026-10-12: a collection made in the shell was never completed — the list was the one
  // read when the shell opened. It is read again once what was typed has run.
  it('completes a collection made in the shell, its list read again once a command ran', async () => {
    let names = ['orders']
    mockApi({
      'GET connections': () => [200, []],
      'GET connections/c1/databases/shop/collections': () => [
        200,
        names.map((name) => ({ name, type: 'collection' })),
      ],
    })
    mountApp(ShellWorkspace, { props: { connectionId: 'c1', db: 'shop' } })
    await flushPromises()
    socket().emit({ ch: 'shell', type: 'opened', payload: { sessionId: 's1', prompt: 'shop>' } })
    await flushPromises()
    term().dataHandler!('db.fresh.insertOne({})')
    key({ key: 'Enter' })
    names = ['orders', 'fresh']
    socket().emit({ ch: 'shell', type: 'done', payload: { id: 1, prompt: 'shop>' } })
    await flushPromises()
    term().dataHandler!('db.fr')
    key({ key: 'Tab' })
    await flushPromises()
    expect(plain(term().written.slice(-1).join(''))).toContain('db.fresh')
  })

  // Review 2026-10-12 (minor 6): after `use other`, only the first database's list was read again.
  it('reads again the collections of the database the shell is on once a command ran there', async () => {
    let names = ['archive']
    mockApi({
      'GET connections': () => [200, []],
      'GET connections/c1/databases/shop/collections': () => [200, []],
      'GET connections/c1/databases/other/collections': () => [
        200,
        names.map((name) => ({ name, type: 'collection' })),
      ],
    })
    mountApp(ShellWorkspace, { props: { connectionId: 'c1', db: 'shop' } })
    await flushPromises()
    socket().emit({ ch: 'shell', type: 'opened', payload: { sessionId: 's1', prompt: '>' } })
    socket().emit({ ch: 'shell', type: 'done', payload: { id: 1, prompt: 'other>', db: 'other' } })
    await flushPromises()
    term().dataHandler!('db.made.insertOne({})')
    key({ key: 'Enter' })
    names = ['archive', 'made']
    socket().emit({ ch: 'shell', type: 'done', payload: { id: 2, prompt: 'other>', db: 'other' } })
    await flushPromises()
    term().dataHandler!('db.ma')
    key({ key: 'Tab' })
    await flushPromises()
    expect(plain(term().written.slice(-1).join(''))).toContain('db.made')
  })

  it('completes the collections of the database the shell is on, after use (final review M6)', async () => {
    mockApi({
      'GET connections': () => [200, []],
      'GET connections/c1/databases/shop/collections': () => [200, [{ name: 'orders', type: 'collection' }]],
      'GET connections/c1/databases/other/collections': () => [
        200,
        [{ name: 'archive', type: 'collection' }],
      ],
    })
    mountApp(ShellWorkspace, { props: { connectionId: 'c1', db: 'shop' } })
    await flushPromises()
    socket().emit({ ch: 'shell', type: 'opened', payload: { sessionId: 's1', prompt: '>' } })
    socket().emit({ ch: 'shell', type: 'done', payload: { id: 1, prompt: 'other>', db: 'other' } })
    await flushPromises()
    term().dataHandler!('db.')
    const before = term().written.length
    key({ key: 'Tab' })
    await flushPromises()
    const listed = plain(term().written.slice(before).join(''))
    expect(listed).toContain('archive')
    expect(listed).not.toContain('orders')
  })
})

describe('ShellView results for the result pane (phase 3a-2)', () => {
  const origin = { kind: 'find', db: 'shop', coll: 'orders', filter: {} }

  it('emits each result with its origin, hasMore, documents and the command it came from', async () => {
    const { wrapper } = mountShell()
    await flushPromises()
    socket().emit({ ch: 'shell', type: 'opened', payload: { sessionId: 's1', prompt: '>' } })
    term().dataHandler!('db.a.find()')
    key({ key: 'Enter' })
    socket().emit({
      ch: 'shell',
      type: 'result',
      payload: { id: 1, resultType: 'Cursor', value: [{ a: 1 }], origin, hasMore: true },
    })
    expect(wrapper.emitted('result')![0]![0]).toMatchObject({
      id: 1,
      resultType: 'Cursor',
      origin,
      hasMore: true,
      documents: [{ a: 1 }],
      command: 'db.a.find()',
    })
  })

  it('reports a command whose output passed the cap as truncated', async () => {
    const { wrapper } = mountShell()
    await flushPromises()
    socket().emit({ ch: 'shell', type: 'opened', payload: { sessionId: 's1', prompt: '>' } })
    // Review 2026-10-12 (M2): named by its command, as any result.
    term().dataHandler!('db.big.find()')
    key({ key: 'Enter' })
    socket().emit({ ch: 'shell', type: 'print', payload: { id: 1, text: '\n[output truncated]' } })
    expect(wrapper.emitted('result')![0]![0]).toMatchObject({
      id: 1,
      truncated: true,
      documents: null,
      command: 'db.big.find()',
    })
  })
})

describe('ShellWorkspace with the result pane (phase 3a-2)', () => {
  it('shows results and runs "it" for More', async () => {
    mockApi({
      'GET connections': () => [200, []],
      'GET connections/c1/databases/shop/collections': () => [200, []],
    })
    const { wrapper } = mountApp(ShellWorkspace, { props: { connectionId: 'c1', db: 'shop' } })
    await flushPromises()
    socket().emit({ ch: 'shell', type: 'opened', payload: { sessionId: 's1', prompt: '>' } })
    socket().emit({
      ch: 'shell',
      type: 'result',
      payload: { id: 1, resultType: 'Cursor', value: [{ a: 1 }], hasMore: true },
    })
    socket().emit({ ch: 'shell', type: 'done', payload: { id: 1, prompt: '>' } })
    await flushPromises()
    await wrapper.find('[data-result-more]').trigger('click')
    expect(socket().sent.some((m) => m.type === 'eval' && m.code === 'it')).toBe(true)
  })

  it('switches between terminal and result as tabs on a narrow screen', async () => {
    mockApi({ 'GET connections': () => [200, []] })
    const { wrapper } = mountApp(ShellWorkspace, { props: { connectionId: 'c1', db: 'shop' } })
    await flushPromises()
    const tabs = wrapper.findAll('[role="tablist"] [role="tab"]')
    expect(tabs).toHaveLength(2)
    expect(tabs[0]!.attributes('aria-selected')).toBe('true')
    await tabs[1]!.trigger('click')
    expect(tabs[1]!.attributes('aria-selected')).toBe('true')
  })
})

describe('ShellWorkspace with snippets (phase 3a-2 §3.5)', () => {
  it('opens a delivered snippet, fills it safely and puts it in the terminal without running it', async () => {
    mockApi({
      'GET connections': () => [200, []],
      'GET connections/c1/databases/shop/collections': () => [200, []],
      // One snippet by id, not the whole list (final review M8).
      'GET connections/c1/snippets/s1': () => [
        200,
        {
          id: 's1',
          name: 'Tagged',
          tags: [],
          code: 'db.t.insertOne({ v: {{v}} })',
          params: [{ name: 'v', type: 'string' }],
          shared: true,
          mine: false,
          owner: 'ada',
          updatedAt: '2026-09-29T00:00:00.000Z',
        },
      ],
    })
    useShellInbox().deliver('c1', 's1')
    mountApp(ShellWorkspace, { props: { connectionId: 'c1', db: 'shop' } })
    await flushPromises()
    socket().emit({ ch: 'shell', type: 'opened', payload: { sessionId: 's1', prompt: '>' } })
    await flushPromises()
    expect(document.body.textContent).toContain('by ada')
    const value = [...document.querySelectorAll('label')].find((l) => l.textContent?.trim().startsWith('v'))!
    const field = document.getElementById(value.htmlFor) as HTMLInputElement
    field.value = '"}); db.dropDatabase(); ({"'
    field.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()
    ;[...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((b) => b.textContent?.trim() === 'Insert')!
      .click()
    await flushPromises()
    const filled = `db.t.insertOne({ v: ${JSON.stringify('"}); db.dropDatabase(); ({"')} })`
    // In the terminal's line, the terminal focused; nothing runs until Enter.
    expect(plain(term().written.join(''))).toContain(filled)
    // The terminal has the focus once the form is gone (its closing gives it back to what opened it
    // first — review 2026-10-12, I13).
    expect(document.activeElement).toBe(term().textarea)
    expect(socket().sent.some((m) => m.type === 'eval')).toBe(false)
    key({ key: 'Enter' })
    expect(
      socket()
        .sent.filter((m) => m.type === 'eval')
        .map((m) => m.code),
    ).toEqual([filled])
    expect(useShellInbox().take('c1')).toBeNull()
  })

  // Review 2026-10-12 (minor 8): a snippet inserted while a command ran was dropped without a word.
  it('says a snippet was not put in while a command runs', async () => {
    mockApi({
      'GET connections': () => [200, []],
      'GET connections/c1/databases/shop/collections': () => [200, []],
      'GET connections/c1/snippets/s2': () => [
        200,
        {
          id: 's2',
          name: 'Plain',
          tags: [],
          code: 'db.t.find()',
          params: [],
          shared: false,
          mine: true,
          owner: 'me',
          updatedAt: '2026-10-12T00:00:00.000Z',
        },
      ],
    })
    mountApp(ShellWorkspace, { props: { connectionId: 'c1', db: 'shop' } })
    await flushPromises()
    socket().emit({ ch: 'shell', type: 'opened', payload: { sessionId: 's1', prompt: '>' } })
    term().dataHandler!('sleep(9000)')
    key({ key: 'Enter' })
    useShellInbox().deliver('c1', 's2')
    await flushPromises()
    ;[...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((b) => b.textContent?.trim() === 'Insert')!
      .click()
    await flushPromises()
    const { useToastStore } = await import('../src/stores/toasts')
    expect(useToastStore().toasts.map((t) => t.message)).toContain(
      i18n.global.t('shell.snippets.notInsertedRunning'),
    )
  })

  it('says a delivered snippet is gone when it no longer exists (final review M8)', async () => {
    mockApi({
      'GET connections': () => [200, []],
      'GET connections/c1/databases/shop/collections': () => [200, []],
      'GET connections/c1/snippets/s9': () => [404, { code: 'NOT_FOUND', message: 'Snippet not found' }],
    })
    useShellInbox().deliver('c1', 's9')
    mountApp(ShellWorkspace, { props: { connectionId: 'c1', db: 'shop' } })
    await flushPromises()
    const { useToastStore } = await import('../src/stores/toasts')
    expect(useToastStore().toasts.map((t) => t.message)).toContain(i18n.global.t('shell.snippets.gone'))
  })

  it('saves the line being typed as a snippet, else the last code run, and says when there is none', async () => {
    mockApi({ 'GET connections': () => [200, []] })
    mountApp(ShellWorkspace, { props: { connectionId: 'c1', db: 'shop' } })
    await flushPromises()
    socket().emit({ ch: 'shell', type: 'opened', payload: { sessionId: 's1', prompt: '>' } })
    const save = async () => {
      document.querySelector<HTMLButtonElement>('[data-shell-menu] button, button[data-shell-menu]')!.click()
      await flushPromises()
      ;[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
        .find((i) => i.textContent?.trim() === 'Save as snippet')!
        .click()
      await flushPromises()
    }
    const { useToastStore } = await import('../src/stores/toasts')
    await save()
    expect(useToastStore().toasts.map((t) => t.message)).toContain(i18n.global.t('shell.snippets.nothing'))
    expect(document.querySelector('[data-param-row]')).toBeNull()
    term().dataHandler!('db.a.find({ x: {{x}} })')
    await save()
    expect(document.querySelector('[data-param-row="x"]')).not.toBeNull()
  })

  it('saves the last code run when nothing is typed', async () => {
    mockApi({ 'GET connections': () => [200, []] })
    mountApp(ShellWorkspace, { props: { connectionId: 'c1', db: 'shop' } })
    await flushPromises()
    socket().emit({ ch: 'shell', type: 'opened', payload: { sessionId: 's1', prompt: '>' } })
    term().dataHandler!('db.b.find({ y: {{y}} })')
    key({ key: 'Enter' })
    socket().emit({ ch: 'shell', type: 'done', payload: { id: 1, prompt: '>' } })
    await flushPromises()
    document.querySelector<HTMLButtonElement>('[data-shell-menu] button, button[data-shell-menu]')!.click()
    await flushPromises()
    ;[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((i) => i.textContent?.trim() === 'Save as snippet')!
      .click()
    await flushPromises()
    expect(document.querySelector('[data-param-row="y"]')).not.toBeNull()
  })
})

// User request 2026-10-11: the terminal redesigned — the app's look, its state in sight, Clear and
// Restart; colours only the app's own, around text made safe.
describe('the redesigned terminal', () => {
  type Api = { status: string; clear(): void; restart(): void; reopen(): void }
  const api2 = (w: { vm: unknown }) => w.vm as unknown as Api

  it('takes the app’s theme, a calm font and a bar cursor, and follows light and dark', async () => {
    const { wrapper } = mountShell()
    await flushPromises()
    const options = term().options as {
      theme: { background: string }
      fontSize: number
      cursorStyle: string
      lineHeight: number
    }
    expect(options.fontSize).toBe(13)
    expect(options.cursorStyle).toBe('bar')
    expect(options.lineHeight).toBeGreaterThan(1)
    expect(options.theme.background).toBe('#ffffff')
    usePreferencesStore().setTheme('dark')
    await flushPromises()
    expect((term().options as { theme: { background: string } }).theme.background).toBe('#111317')
    wrapper.unmount()
  })

  // W5 (spec 3a-1 §10.6): screen-reader mode, on by default, switched in Preferences, at once.
  it('follows the screen-reader preference, also while open', async () => {
    const { wrapper } = mountShell()
    await flushPromises()
    expect(term().options.screenReaderMode).toBe(true)
    usePreferencesStore().setScreenReader(false)
    await flushPromises()
    const off = term().options.screenReaderMode
    usePreferencesStore().setScreenReader(true)
    await flushPromises()
    expect(off).toBe(false)
    expect(term().options.screenReaderMode).toBe(true)
    wrapper.unmount()
  })

  // User request 2026-10-12: the terminal's theme, chosen in the shell, its surface around it too.
  it('takes the terminal theme chosen, the padding around it in its background', async () => {
    const { wrapper } = mountShell()
    await flushPromises()
    usePreferencesStore().setTerminalTheme('dracula')
    await flushPromises()
    const background = (term().options as { theme: { background: string } }).theme.background
    const style = wrapper.find('[data-shell-surface]').attributes('style') ?? ''
    // Back to the app's before anything is checked: the choice is kept for the next tests.
    usePreferencesStore().setTerminalTheme('app')
    await flushPromises()
    expect(background).toBe('#282a36')
    expect(style).toContain('background-color: #282a36')
    expect((term().options as { theme: { background: string } }).theme.background).not.toBe('#282a36')
    expect(wrapper.find('[data-shell-surface]').attributes('style') ?? '').not.toContain('background-color')
    wrapper.unmount()
  })

  // User report 2026-10-12: "tab olarak tamamlama kullandığımda terminalden çıkıyor".
  it('completes with Tab and keeps the focus, Shift+Tab or Esc then Tab leaving the terminal', async () => {
    const completer = vi.fn(async () => ({ from: 3, items: [{ label: 'orders', insert: 'orders' }] }))
    mountShell({ completer })
    await flushPromises()
    socket().emit({ ch: 'shell', type: 'opened', payload: { sessionId: 's1', prompt: '>' } })
    term().dataHandler!('db.or')
    const press = (init: KeyboardEventInit) => {
      const event = new KeyboardEvent('keydown', { cancelable: true, ...init })
      const passOn = term().keyHandler!(event)
      return { event, passOn }
    }
    const tab = press({ key: 'Tab' })
    expect(tab.event.defaultPrevented).toBe(true)
    expect(tab.passOn).toBe(false)
    await flushPromises()
    expect(completer).toHaveBeenCalledTimes(1)
    // Shift+Tab leaves, as anywhere on the page.
    const back = press({ key: 'Tab', shiftKey: true })
    expect(back.event.defaultPrevented).toBe(false)
    expect(completer).toHaveBeenCalledTimes(1)
    // Esc, then Tab: the way out forwards; the next Tab completes again.
    press({ key: 'Escape' })
    const out = press({ key: 'Tab' })
    expect(out.event.defaultPrevented).toBe(false)
    expect(completer).toHaveBeenCalledTimes(1)
    expect(press({ key: 'Tab' }).event.defaultPrevented).toBe(true)
  })

  // User request 2026-10-12: "kodları renklendir".
  it('colours the code typed and the results, never what a command prints', async () => {
    mountShell()
    await flushPromises()
    socket().emit({ ch: 'shell', type: 'opened', payload: { sessionId: 's1', prompt: '>' } })
    const before = term().written.length
    term().dataHandler!('db')
    expect(term().written.slice(before).join('')).toContain(`${String.fromCharCode(27)}[36mdb`)
    key({ key: 'Enter' })
    socket().emit({
      ch: 'shell',
      type: 'result',
      payload: { id: 1, resultType: null, value: { n: 1, s: 'x' } },
    })
    socket().emit({ ch: 'shell', type: 'print', payload: { id: 1, text: 'true 42 "plain"' } })
    const out = term().written.join('')
    expect(out).toContain(`${String.fromCharCode(27)}[33m1`)
    expect(out).toContain(`${String.fromCharCode(27)}[32m"x"`)
    expect(out).toContain('true 42 "plain"')
  })

  // Review 2026-10-12 (M7, M8, M9): the way out is said; Esc's Tab lasts only while the terminal
  // keeps the focus; a Tab with nothing to complete moves on.
  it('says how to leave the terminal, forgets Esc once it loses the focus, and lets Tab go with nothing to do', async () => {
    const completer = vi.fn(async () => null)
    const { wrapper } = mountShell({ completer })
    await flushPromises()
    socket().emit({ ch: 'shell', type: 'opened', payload: { sessionId: 's1', prompt: '>' } })
    const group = wrapper.find('[role="group"]')
    const hint = document.getElementById(group.attributes('aria-describedby')!)!
    expect(hint.textContent).toContain('Shift+Tab')
    expect(hint.textContent).toContain('Esc')
    const press = (init: KeyboardEventInit) => {
      const event = new KeyboardEvent('keydown', { cancelable: true, ...init })
      term().keyHandler!(event)
      return event
    }
    press({ key: 'Escape' })
    term().textarea.dispatchEvent(new Event('blur'))
    expect(press({ key: 'Tab' }).defaultPrevented).toBe(true)
    // Closed: Tab completes nothing, and goes on to the button to open a new shell.
    socket().emit({ ch: 'shell', type: 'closed', payload: { sessionId: 's1', reason: 'idle' } })
    await flushPromises()
    expect(press({ key: 'Tab' }).defaultPrevented).toBe(false)
  })

  it('lets Tab go on in a terminal with no completion', async () => {
    mountShell()
    await flushPromises()
    socket().emit({ ch: 'shell', type: 'opened', payload: { sessionId: 's1', prompt: '>' } })
    const event = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true })
    term().keyHandler!(event)
    expect(event.defaultPrevented).toBe(false)
  })

  // Review 2026-10-12 (M6): mongosh's "Type "it" for more" is plain; code run from outside keeps a
  // comment's colour across its lines.
  it('writes "Type "it" for more" plain, and colours code run from outside as one', async () => {
    const { wrapper } = mountShell()
    await flushPromises()
    socket().emit({ ch: 'shell', type: 'opened', payload: { sessionId: 's1', prompt: '>' } })
    socket().emit({
      ch: 'shell',
      type: 'result',
      payload: { id: 1, resultType: 'Cursor', value: [{ a: 1 }], hasMore: true },
    })
    socket().emit({ ch: 'shell', type: 'done', payload: { id: 1, prompt: '>' } })
    await flushPromises()
    expect(term().written.join('')).toContain('Type "it" for more')
    api(wrapper).run('/* one\ntwo */ 1')
    const echo = term().written.join('')
    expect(echo).toContain(`${String.fromCharCode(27)}[90mtwo */`)
  })

  // User report 2026-10-12: "Önceki shell sona ermişti … yenisi açıldı" over and over (the preview
  // server restarted), for a shell nothing had been run in: nothing was lost, nothing is said.
  it('takes a new shell in place of an unused one without a word, and says so once something was run', async () => {
    const replace = (gone: string, next: string) => {
      socket().emit({ ch: 'shell', type: 'closed', payload: { sessionId: gone, reason: 'ended' } })
      const ref = [...socket().sent].reverse().find((m) => m.type === 'open')!.ref
      socket().emit({ ch: 'shell', type: 'opened', payload: { sessionId: next, prompt: 'test>', ref } })
    }
    const state = (socket_: unknown) => (socket_ as { state: { value: string } }).state
    mountShell({ sessionKey: 'tab-q' })
    await flushPromises()
    const first = socket().sent.find((m) => m.type === 'open')!.ref
    socket().emit({ ch: 'shell', type: 'opened', payload: { sessionId: 'a1', prompt: 'test>', ref: first } })
    const shown = term().written.length
    const reconnect = async () => {
      state(socket()).value = 'connecting'
      await flushPromises()
      state(socket()).value = 'open'
      await flushPromises()
    }
    await reconnect()
    replace('a1', 'a2')
    await reconnect()
    replace('a2', 'a3')
    await flushPromises()
    let out = plain(term().written.join(''))
    expect(out).not.toContain('The earlier shell had ended')
    // The prompt drawn again where it was: never a line more per new shell.
    expect(term().written.slice(shown).join('')).not.toContain('\n')
    // Something run: its variables are what a new shell loses, said once.
    term().dataHandler!('x = 1')
    key({ key: 'Enter' })
    socket().emit({ ch: 'shell', type: 'done', payload: { id: 1, prompt: 'test>' } })
    await reconnect()
    replace('a3', 'a4')
    await flushPromises()
    out = plain(term().written.join(''))
    expect(out.match(/The earlier shell had ended/g) ?? []).toHaveLength(1)
    // The new one unused in turn: its own replacement is quiet again.
    await reconnect()
    replace('a4', 'a5')
    await flushPromises()
    expect(plain(term().written.join('')).match(/The earlier shell had ended/g) ?? []).toHaveLength(1)
    // Run from outside the terminal, the same.
    const { wrapper } = mountShell()
    await flushPromises()
    const ref = socket().sent.find((m) => m.type === 'open')!.ref
    socket().emit({ ch: 'shell', type: 'opened', payload: { sessionId: 'b1', prompt: 'test>', ref } })
    api(wrapper).run('y = 2')
    socket().emit({ ch: 'shell', type: 'done', payload: { id: 1, prompt: 'test>' } })
    await reconnect()
    replace('b1', 'b2')
    await flushPromises()
    expect(plain(term().written.join(''))).toContain('The earlier shell had ended')
    sessionStorage.clear()
  })

  // User report 2026-10-12: "Shell kapandı: uzun süre kullanılmadı" — a command typed then opens a new one.
  it('opens a new shell for a command typed after it closed, and runs it there', async () => {
    const { wrapper } = mountShell()
    await flushPromises()
    socket().emit({ ch: 'shell', type: 'opened', payload: { sessionId: 's1', prompt: '>' } })
    socket().emit({ ch: 'shell', type: 'closed', payload: { sessionId: 's1', reason: 'idle' } })
    await flushPromises()
    expect(wrapper.find('[data-shell-closed]').text()).toContain('Type a command')
    const opens = () => socket().sent.filter((m) => m.type === 'open').length
    const before = opens()
    term().dataHandler!('db.getName()')
    expect(plain(term().written.join(''))).toContain('db.getName()')
    key({ key: 'Enter' })
    await flushPromises()
    expect(opens()).toBe(before + 1)
    expect(wrapper.find('[data-shell-closed]').exists()).toBe(false)
    const ref = [...socket().sent].reverse().find((m) => m.type === 'open')!.ref
    socket().emit({ ch: 'shell', type: 'opened', payload: { sessionId: 's2', prompt: '>', ref } })
    await flushPromises()
    expect(socket().sent.at(-1)).toMatchObject({ type: 'eval', sessionId: 's2', code: 'db.getName()' })
  })

  it('says its state: connecting, ready, running, closed', async () => {
    const { wrapper } = mountShell()
    await flushPromises()
    expect(api2(wrapper).status).toBe('connecting')
    socket().emit({ ch: 'shell', type: 'opened', payload: { sessionId: 's1', prompt: 'shop>' } })
    await flushPromises()
    expect(api2(wrapper).status).toBe('ready')
    api(wrapper).run('db.a.find()')
    expect(api2(wrapper).status).toBe('running')
    socket().emit({ ch: 'shell', type: 'done', payload: { id: 1, prompt: 'shop>' } })
    await flushPromises()
    expect(api2(wrapper).status).toBe('ready')
    socket().emit({ ch: 'shell', type: 'closed', payload: { sessionId: 's1', reason: 'idle' } })
    await flushPromises()
    expect(api2(wrapper).status).toBe('closed')
  })

  it('paints the prompt and errors in the app’s colours, never what the server sends', async () => {
    mountShell()
    await flushPromises()
    socket().emit({ ch: 'shell', type: 'opened', payload: { sessionId: 's1', prompt: 'shop>' } })
    socket().emit({ ch: 'shell', type: 'error', payload: { message: 'bad \u001b[31mred' } })
    const written = term().written.join('')
    expect(written).toContain(`${SGR.prompt}shop>${SGR.reset}`)
    expect(written).toContain(`${SGR.error}bad \\x1b[31mred${SGR.reset}`)
  })

  // Seen in the redesign's preview (2026-10-11): the prompt was drawn over the output's last line
  // (240 of a count, the "]" closing a list), and a blank line came before every output.
  it('keeps the output’s last line: the prompt comes on the next, with no blank line before it', async () => {
    const { wrapper } = mountShell()
    await flushPromises()
    socket().emit({ ch: 'shell', type: 'opened', payload: { sessionId: 's1', prompt: 'shop>' } })
    api(wrapper).run('db.a.countDocuments()')
    socket().emit({ ch: 'shell', type: 'result', payload: { id: 1, resultType: null, value: 240 } })
    socket().emit({ ch: 'shell', type: 'print', payload: { id: 1, text: 'a\nb' } })
    socket().emit({ ch: 'shell', type: 'done', payload: { id: 1, prompt: 'shop>' } })
    await flushPromises()
    const out = plain(term().written.join(''))
    expect(out).toContain('shop> db.a.countDocuments()\r\n240\r\na\r\nb\r\n\rshop> ')
    // A command with no output: the prompt right under it.
    api(wrapper).run('x = 1')
    socket().emit({ ch: 'shell', type: 'done', payload: { id: 2, prompt: 'shop>' } })
    await flushPromises()
    expect(plain(term().written.join(''))).toContain('shop> x = 1\r\n\rshop> ')
  })

  // Review 2026-10-11 (I1): an open that failed is closed (a new shell offered), not "Connecting".
  it('takes a failed open as closed, offering a new shell, and never runs waiting code', async () => {
    const { wrapper } = mountShell()
    await flushPromises()
    api(wrapper).run('db.a.find()')
    expect(api2(wrapper).status).toBe('connecting')
    socket().emit({ ch: 'shell', type: 'failed', payload: { code: 'TOO_MANY', message: 'Too many shells' } })
    await flushPromises()
    expect(api2(wrapper).status).toBe('closed')
    expect(document.querySelector('[data-shell-closed]')).toBeTruthy()
    expect((wrapper.vm as unknown as { running: boolean }).running).toBe(false)
  })

  // Review I2: the server ending the session is said in the user's language.
  it('words why the shell closed', async () => {
    i18n.global.locale.value = 'tr'
    const { wrapper } = mountShell()
    await flushPromises()
    socket().emit({ ch: 'shell', type: 'opened', payload: { sessionId: 's1', prompt: '>' } })
    socket().emit({ ch: 'shell', type: 'closed', payload: { sessionId: 's1', reason: 'idle' } })
    await flushPromises()
    const out = plain(term().written.join(''))
    expect(out).toContain('Shell kapandı: uzun süre kullanılmadı.')
    expect(out).not.toContain('idle')
    expect(api2(wrapper).status).toBe('closed')
    i18n.global.locale.value = 'en'
  })

  // Review I4: a reattach while a command runs keeps it running; one that ended meanwhile is said.
  it('keeps a command running across a reattach, and says one ended while the link was down', async () => {
    const { wrapper } = mountShell()
    await flushPromises()
    socket().emit({ ch: 'shell', type: 'opened', payload: { sessionId: 's1', prompt: '>' } })
    api(wrapper).run('sleep(1000)')
    const before = term().written.length
    // A reattach's answer names the session, never an open's ref.
    socket().emit({
      ch: 'shell',
      type: 'opened',
      payload: { sessionId: 's1', prompt: '>', running: true, ref: undefined },
    })
    await flushPromises()
    expect(api2(wrapper).status).toBe('running')
    expect(plain(term().written.slice(before).join(''))).not.toContain('> ')
    socket().emit({
      ch: 'shell',
      type: 'opened',
      payload: { sessionId: 's1', prompt: '>', running: false, ref: undefined },
    })
    await flushPromises()
    expect(api2(wrapper).status).toBe('ready')
    expect(plain(term().written.join(''))).toContain('The command ended while the connection was down')
  })

  // Review minors 1, 2: Clear draws the prompt only when one may type; "Connected" on its own line.
  it('clears without a prompt while a command runs, and says connected on a line of its own', async () => {
    const { wrapper } = mountShell()
    await flushPromises()
    socket().emit({ ch: 'shell', type: 'opened', payload: { sessionId: 's1', prompt: '>' } })
    // The first line is the shell's, no blank line before it.
    expect(plain(term().written.join(''))).toMatch(/^Connected\./)
    term().dataHandler!('db.foo')
    socket().emit({ ch: 'shell', type: 'opened', payload: { sessionId: 's1', prompt: '>', ref: undefined } })
    // The same session again after the link came back: said as such, its variables kept.
    expect(plain(term().written.join(''))).toContain('> db.foo\r\nReconnected: the same shell')
    api(wrapper).run('sleep(1000)')
    const before = term().written.length
    api2(wrapper).clear()
    expect(term().written.slice(before).join('')).toBe('')
  })

  // User report 2026-10-12: a reload opened new shells while the old ones waited on the server, until
  // "too many shells open"; the shell and its variables were lost on every reload.
  it('takes its tab’s shell again after a reload, and keeps it for that tab only', async () => {
    sessionStorage.clear()
    const S1 = '11111111-2222-4333-8444-555555555555'
    const { wrapper } = mountShell({ sessionKey: 'tab-1' })
    await flushPromises()
    const ref = socket().sent.find((m) => m.type === 'open')!.ref
    socket().emit({ ch: 'shell', type: 'opened', payload: { sessionId: S1, prompt: '>', ref } })
    expect(sessionStorage.getItem('mm:shell-session:tab-1')).toBe(S1)
    wrapper.unmount()
    // Closed with its tab: nothing kept for it.
    expect(sessionStorage.getItem('mm:shell-session:tab-1')).toBeNull()
    // A reload (nothing unmounted): the page built again attaches to it.
    sessionStorage.setItem('mm:shell-session:tab-1', S1)
    mountShell({ sessionKey: 'tab-1' })
    await flushPromises()
    expect(socket().sent).toContainEqual({ ch: 'shell', type: 'attach', sessionId: S1 })
    expect(socket().sent.some((m) => m.type === 'open')).toBe(false)
    socket().emit({
      ch: 'shell',
      type: 'opened',
      payload: { sessionId: S1, prompt: 'shop>', ref: undefined },
    })
    expect(plain(term().written.join(''))).toContain('Reconnected: the same shell')
    // Without a tab, nothing is kept.
    mountShell()
    await flushPromises()
    expect(socket().sent.some((m) => m.type === 'attach')).toBe(false)
  })

  // Review 2026-10-12 (M10): a tampered value would have the server drop the whole socket, again on
  // every reconnect: only a session id as the server makes them is sent.
  it('never sends a kept value that is not a session id, and lets it go', async () => {
    for (const bad of ['x'.repeat(200), 's1', '"><img>', '11111111-2222-4333-8444-55555555555Z']) {
      sessionStorage.setItem('mm:shell-session:tab-3', bad)
      mountShell({ sessionKey: 'tab-3' })
      await flushPromises()
      expect(socket().sent.some((m) => m.type === 'attach')).toBe(false)
      expect(socket().sent.some((m) => m.type === 'open')).toBe(true)
      expect(sessionStorage.getItem('mm:shell-session:tab-3')).toBeNull()
    }
  })

  // Review 2026-10-12 (I2): a reload while a command ran showed the prompt, and a second command could
  // be sent while the first still ran.
  it('says a command still runs after a reload, taking only Ctrl+C until it ends', async () => {
    const S2 = '22222222-2222-4333-8444-555555555555'
    sessionStorage.setItem('mm:shell-session:tab-4', S2)
    const { wrapper } = mountShell({ sessionKey: 'tab-4' })
    await flushPromises()
    socket().emit({
      ch: 'shell',
      type: 'opened',
      payload: { sessionId: S2, prompt: '>', running: true, ref: undefined },
    })
    await flushPromises()
    expect(api2(wrapper).status).toBe('running')
    expect(plain(term().written.join(''))).toContain('a command is still running')
    expect(plain(term().written.join(''))).not.toContain('> ')
    term().dataHandler!('db.other()')
    key({ key: 'Enter' })
    expect(socket().sent.some((m) => m.type === 'eval')).toBe(false)
    key({ key: 'c', ctrlKey: true })
    expect(socket().sent.at(-1)).toMatchObject({ type: 'cancel', sessionId: S2 })
    socket().emit({ ch: 'shell', type: 'done', payload: { id: 9, prompt: '>' } })
    await flushPromises()
    expect(api2(wrapper).status).toBe('ready')
    sessionStorage.clear()
  })

  it('opens again after it closed, the closed bar gone', async () => {
    const { wrapper } = mountShell()
    await flushPromises()
    socket().emit({ ch: 'shell', type: 'opened', payload: { sessionId: 's1', prompt: '>' } })
    socket().emit({ ch: 'shell', type: 'closed', payload: { sessionId: 's1', reason: 'idle' } })
    await flushPromises()
    expect(wrapper.find('[data-shell-closed]').exists()).toBe(true)
    api2(wrapper).reopen()
    const ref = [...socket().sent].reverse().find((m) => m.type === 'open')!.ref
    socket().emit({ ch: 'shell', type: 'opened', payload: { sessionId: 's2', prompt: '>', ref } })
    await flushPromises()
    expect(wrapper.find('[data-shell-closed]').exists()).toBe(false)
    expect(api2(wrapper).status).toBe('ready')
  })

  it('takes a shell opened by a reconnect after a failed open as open, the closed bar gone', async () => {
    const { wrapper } = mountShell()
    await flushPromises()
    const first = socket().sent.find((m) => m.type === 'open')!.ref
    socket().emit({
      ch: 'shell',
      type: 'failed',
      payload: { code: 'TOO_MANY', message: 'Too many', ref: first },
    })
    await flushPromises()
    expect(wrapper.find('[data-shell-closed]').exists()).toBe(true)
    // The link drops and comes back: the open is asked again, and this time it opens.
    const state = (socket() as unknown as { state: { value: string } }).state
    state.value = 'connecting'
    await flushPromises()
    state.value = 'open'
    await flushPromises()
    const again = [...socket().sent].reverse().find((m) => m.type === 'open')!.ref
    expect(again).not.toBe(first)
    socket().emit({ ch: 'shell', type: 'opened', payload: { sessionId: 's2', prompt: '>', ref: again } })
    await flushPromises()
    expect(wrapper.find('[data-shell-closed]').exists()).toBe(false)
    expect(api2(wrapper).status).toBe('ready')
  })

  it('leaves the line from its end on Enter, the cursor anywhere on it', async () => {
    mountShell()
    await flushPromises()
    socket().emit({ ch: 'shell', type: 'opened', payload: { sessionId: 's1', prompt: '>' } })
    term().dataHandler!('abc')
    key({ key: 'ArrowLeft' })
    key({ key: 'ArrowLeft' })
    const before = term().written.length
    key({ key: 'Enter' })
    // Drawn again with the cursor after "> abc" (column 6), then the new line.
    expect(term().written.slice(before).join('')).toMatch(
      new RegExp(`${String.fromCharCode(27)}\\[6G\\r\\n$`),
    )
    expect(socket().sent.at(-1)).toMatchObject({ type: 'eval', code: 'abc' })
  })

  // User report 2026-10-12: the arrows moved the cursor on the line, never on the screen.
  it('shows the cursor where the arrows put it', async () => {
    mountShell()
    await flushPromises()
    socket().emit({ ch: 'shell', type: 'opened', payload: { sessionId: 's1', prompt: '>' } })
    term().dataHandler!('abc')
    const before = term().written.length
    key({ key: 'ArrowLeft' })
    key({ key: 'ArrowLeft' })
    const moves = term().written.slice(before).join('')
    // The prompt ("> ") and "a": the cursor in the 4th column, then the 3rd... after "> a".
    expect(moves).toContain(`${String.fromCharCode(27)}[5G`)
    expect(moves.endsWith(`${String.fromCharCode(27)}[4G`)).toBe(true)
  })

  // Review minor 12: code waiting for the session is not "Running" yet.
  it('says connecting while code waits for the session', async () => {
    const { wrapper } = mountShell()
    await flushPromises()
    api(wrapper).run('db.a.find()')
    expect(api2(wrapper).status).toBe('connecting')
    expect((wrapper.vm as unknown as { running: boolean }).running).toBe(true)
  })

  it('clears the screen, keeping the line being typed', async () => {
    const { wrapper } = mountShell()
    await flushPromises()
    socket().emit({ ch: 'shell', type: 'opened', payload: { sessionId: 's1', prompt: '>' } })
    term().dataHandler!('db')
    const cleared = vi.spyOn(term() as unknown as { clear(): void }, 'clear')
    api2(wrapper).clear()
    expect(cleared).toHaveBeenCalled()
    expect(plain(term().written.at(-1) ?? '')).toContain('> db')
  })

  it('restarts: closes its session and opens a new one, connecting again', async () => {
    const { wrapper } = mountShell()
    await flushPromises()
    socket().emit({ ch: 'shell', type: 'opened', payload: { sessionId: 's1', prompt: '>' } })
    await flushPromises()
    api2(wrapper).restart()
    await flushPromises()
    const sent = socket().sent.map((m) => m.type)
    expect(sent.slice(-2)).toEqual(['close', 'open'])
    expect(api2(wrapper).status).toBe('connecting')
    // The old session's close arriving late is not this shell's any more.
    socket().emit({ ch: 'shell', type: 'closed', payload: { sessionId: 's1', reason: 'closed' } })
    await flushPromises()
    expect(api2(wrapper).status).toBe('connecting')
    socket().emit({ ch: 'shell', type: 'opened', payload: { sessionId: 's2', prompt: '>' } })
    await flushPromises()
    expect(api2(wrapper).status).toBe('ready')
  })
})

// User request 2026-10-11: the shell page redesigned — where it runs and its state in sight, its
// actions in one header, the keys in a status bar.
describe('the redesigned shell page', () => {
  function mountPage() {
    mockApi({
      'GET connections': () => [
        200,
        [{ id: 'c1', name: 'Prod', color: 'amber', permissions: [], export: true, shell: true }],
      ],
      'GET connections/c1/databases/shop/collections': () => [200, [{ name: 'orders', type: 'collection' }]],
      'GET connections/c1/databases/other/collections': () => [200, []],
    })
    return mountApp(ShellWorkspace, { props: { connectionId: 'c1', db: 'shop' } })
  }
  const header = () => document.querySelector<HTMLElement>('[data-shell-header]')!
  const status = () => document.querySelector<HTMLElement>('[data-shell-status]')!.textContent ?? ''
  async function type(code: string) {
    term().dataHandler!(code)
    await flushPromises()
  }

  it('names where it runs and its state', async () => {
    mountPage()
    await flushPromises()
    expect(header().textContent).toContain('Prod')
    expect(header().textContent).toContain('shop')
    // The connection's colour as the app draws it (review I6), not its name as a CSS colour.
    const dot = header().querySelector<HTMLElement>('[data-shell-connection-dot]')!
    expect(dot.className).toContain(COLOR_CLASSES.amber)
    expect(dot.getAttribute('style') ?? '').not.toContain('amber')
    expect(status()).toContain('Connecting')
    socket().emit({ ch: 'shell', type: 'opened', payload: { sessionId: 's1', prompt: 'shop>' } })
    await flushPromises()
    expect(status()).toContain('Connected')
    socket().emit({ ch: 'shell', type: 'done', payload: { id: 1, prompt: 'other>', db: 'other' } })
    await flushPromises()
    expect(header().textContent).toContain('other')
  })

  it('runs what is typed in the terminal, and stops what runs from the header', async () => {
    mountPage()
    await flushPromises()
    socket().emit({ ch: 'shell', type: 'opened', payload: { sessionId: 's1', prompt: '>' } })
    await type('db.orders.countDocuments()')
    expect(document.querySelector('[data-shell-stop]')).toBeNull()
    key({ key: 'Enter' })
    await flushPromises()
    expect(socket().sent.some((m) => m.type === 'eval' && m.code === 'db.orders.countDocuments()')).toBe(true)
    expect(status()).toContain('Running')
    // The seconds counted are not read out each second (review I7).
    const elapsed = document.querySelector('[data-shell-elapsed]')
    if (elapsed) expect(elapsed.getAttribute('aria-hidden')).toBe('true')
    document.querySelector<HTMLButtonElement>('[data-shell-stop]')!.click()
    expect(socket().sent.at(-1)).toMatchObject({ type: 'cancel', sessionId: 's1' })
  })

  // User request 2026-10-13: "ekranı temizle sonuçlarıda temizlesin". Clear the screen, Ctrl+L and cls
  // all clear the results too, said with an Undo; a screen with no results says nothing.
  async function clearsPage() {
    mountPage()
    await flushPromises()
    socket().emit({ ch: 'shell', type: 'opened', payload: { sessionId: 's1', prompt: '>' } })
    let n = 0
    const result = () => {
      n++
      socket().emit({
        ch: 'shell',
        type: 'result',
        payload: { id: n, resultType: 'Cursor', value: [{ a: n }] },
      })
      socket().emit({ ch: 'shell', type: 'done', payload: { id: n, prompt: '>' } })
    }
    const shown = () => document.querySelector('[data-result-history]') !== null
    const { useToastStore } = await import('../src/stores/toasts')
    const toasts = useToastStore()
    const said = () => toasts.toasts.filter((x) => x.message === i18n.global.t('shell.results.cleared'))
    const picks = async () => {
      document.querySelector<HTMLButtonElement>('[data-result-history] button')!.click()
      await flushPromises()
      const keys = [...document.querySelectorAll('[data-result-pick]')].map((o) =>
        o.getAttribute('data-result-pick'),
      )
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await flushPromises()
      return keys
    }
    const menu = async (label: string) => {
      document.querySelector<HTMLButtonElement>('[data-shell-menu] button, button[data-shell-menu]')!.click()
      await flushPromises()
      ;[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
        .find((i) => i.textContent?.trim() === label)!
        .click()
      await flushPromises()
      useDialogStore().settle(true)
      await flushPromises()
    }
    return { result, shown, toasts, said, picks, menu }
  }

  it('clears the results with the screen, by the button, Ctrl+L and cls, one Undo for them all', async () => {
    const { result, shown, toasts, said, picks } = await clearsPage()
    const button = document.querySelector<HTMLButtonElement>('[data-shell-clear]')!
    // The button says what it clears (review 2026-10-13, M5).
    expect(button.getAttribute('aria-label')).toBe(i18n.global.t('shell.actions.clear'))
    expect(i18n.global.t('shell.actions.clear')).toBe('Clear the screen and the results')
    const clears: Array<() => void> = [
      () => button.click(),
      () => key({ key: 'l', ctrlKey: true }),
      () => {
        term().dataHandler!('cls')
        key({ key: 'Enter' })
      },
    ]
    const ids: number[] = []
    for (const clear of clears) {
      result()
      await flushPromises()
      expect(shown()).toBe(true)
      clear()
      await flushPromises()
      expect(shown()).toBe(false)
      // Each clear says so anew, the Undo before it folded into this one (review 2026-10-13, M3, M7).
      expect(said()).toHaveLength(1)
      expect(said()[0]).toMatchObject({ kind: 'info' })
      expect(ids).not.toContain(said()[0]!.id)
      ids.push(said()[0]!.id)
    }
    result()
    await flushPromises()
    toasts.runAction(ids.at(-1)!, 0)
    await flushPromises()
    // All three back, behind the one that came since, newest first.
    expect(await picks()).toEqual(['4', '3', '2', '1'])
    expect(said()).toEqual([])
    // Nothing left to clear: the screen is cleared without a word.
    document.querySelector<HTMLButtonElement>('[data-result-clear]')!.click()
    await flushPromises()
    for (const x of [...toasts.toasts]) toasts.dismiss(x.id)
    button.click()
    await flushPromises()
    expect(toasts.toasts).toEqual([])
  })

  // Review 2026-10-13 (I1, M2, M4): the results cleared come back from the empty pane too, with no time
  // limit, shown as they were; a restart or a cleared history forgets them for good.
  it('brings the cleared results back from the empty pane as they were, until the shell restarts', async () => {
    const { result, shown, said, menu } = await clearsPage()
    result()
    result()
    await flushPromises()
    const terminal = () => document.querySelector('[data-shell-terminal-column]')!
    const mark = () => document.querySelector('[data-shell-new-results]')
    const restore = () => document.querySelector<HTMLButtonElement>('[data-result-restore]')
    expect(restore()).toBeNull()
    document.querySelector<HTMLButtonElement>('[data-result-wide]')!.click()
    await flushPromises()
    expect(mark()).not.toBeNull()
    key({ key: 'l', ctrlKey: true })
    await flushPromises()
    expect(terminal().classList).not.toContain('lg:hidden')
    expect(mark()).toBeNull()
    expect(restore()!.textContent?.trim()).toBe(i18n.global.t('shell.results.restore'))
    restore()!.focus()
    restore()!.click()
    await flushPromises()
    expect(shown()).toBe(true)
    // The button went with the empty pane: the focus stays in the pane.
    expect(document.activeElement).toBe(document.querySelector('[data-result-pane]'))
    expect(terminal().classList).toContain('lg:hidden')
    expect(mark()).not.toBeNull()
    expect(said()).toEqual([])
    for (const forget of ['Restart the shell', 'Clear shell history']) {
      // The shell is open (again, once restarted).
      socket().emit({ ch: 'shell', type: 'opened', payload: { sessionId: 's1', prompt: '>' } })
      await flushPromises()
      result()
      await flushPromises()
      key({ key: 'l', ctrlKey: true })
      await flushPromises()
      expect(restore()).not.toBeNull()
      await menu(forget)
      expect(restore()).toBeNull()
      expect(said()).toEqual([])
    }
  })

  // Review 2026-10-13 (M6): Ctrl+L clears while a command runs, as the button does.
  it('clears the screen and the results with Ctrl+L while a command runs', async () => {
    const { result, shown } = await clearsPage()
    result()
    await flushPromises()
    const cleared = vi.spyOn(term() as unknown as { clear(): void }, 'clear')
    term().dataHandler!('sleep(1000)')
    key({ key: 'Enter' })
    await flushPromises()
    expect(socket().sent.at(-1)).toMatchObject({ type: 'eval' })
    key({ key: 'l', ctrlKey: true })
    await flushPromises()
    expect(cleared).toHaveBeenCalled()
    expect(shown()).toBe(false)
  })

  it('clears the screen, and asks before restarting the shell from its menu', async () => {
    mountPage()
    await flushPromises()
    socket().emit({ ch: 'shell', type: 'opened', payload: { sessionId: 's1', prompt: '>' } })
    await flushPromises()
    const cleared = vi.spyOn(term() as unknown as { clear(): void }, 'clear')
    document.querySelector<HTMLButtonElement>('[data-shell-clear]')!.click()
    expect(cleared).toHaveBeenCalled()
    document.querySelector<HTMLButtonElement>('[data-shell-menu] button, button[data-shell-menu]')!.click()
    await flushPromises()
    const items = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    expect(items().map((i) => i.textContent?.trim())).toEqual(
      expect.arrayContaining(['Clear shell history', 'Restart the shell']),
    )
    items()
      .find((i) => i.textContent?.trim() === 'Restart the shell')!
      .click()
    await flushPromises()
    const dialogs = useDialogStore()
    expect(dialogs.current?.title).toBe('Restart the shell?')
    dialogs.settle(true)
    await flushPromises()
    expect(
      socket()
        .sent.slice(-2)
        .map((m) => m.type),
    ).toEqual(['close', 'open'])
  })

  // User report 2026-10-12: "Shell geçmişini temizle çalışmıyor … Sonuçlar alanındaki geçmiş duruyor".
  // Clearing the history clears the results too, and says so; a refusal is said, nothing lost.
  it('clears the command history and the results with Clear shell history, saying so', async () => {
    mountPage()
    await flushPromises()
    socket().emit({ ch: 'shell', type: 'opened', payload: { sessionId: 's1', prompt: '>' } })
    socket().emit({
      ch: 'shell',
      type: 'result',
      payload: { id: 1, resultType: 'Cursor', value: [{ a: 1 }] },
    })
    socket().emit({ ch: 'shell', type: 'done', payload: { id: 1, prompt: '>' } })
    await flushPromises()
    const pane = () => document.querySelector<HTMLElement>('[data-result-pane]')!
    expect(pane().querySelector('[data-result-history]')).not.toBeNull()
    const clearHistory = async () => {
      document.querySelector<HTMLButtonElement>('[data-shell-menu] button, button[data-shell-menu]')!.click()
      await flushPromises()
      ;[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
        .find((i) => i.textContent?.trim() === 'Clear shell history')!
        .click()
      await flushPromises()
      useDialogStore().settle(true)
      await flushPromises()
    }
    const { useToastStore } = await import('../src/stores/toasts')
    historyMock.clearFails = true
    await clearHistory()
    expect(useToastStore().toasts.at(-1)).toMatchObject({ kind: 'error' })
    expect(pane().querySelector('[data-result-history]')).not.toBeNull()
    historyMock.clearFails = false
    const before = historyMock.cleared
    await clearHistory()
    expect(historyMock.cleared).toBe(before + 1)
    expect(useToastStore().toasts.at(-1)).toMatchObject({
      kind: 'success',
      message: i18n.global.t('shell.historyCleared'),
    })
    expect(pane().querySelector('[data-result-history]')).toBeNull()
    expect(pane().textContent).toContain(i18n.global.t('shell.results.emptyTitle'))
  })

  it('clears the results with their own button, and when the shell restarts', async () => {
    mountPage()
    await flushPromises()
    socket().emit({ ch: 'shell', type: 'opened', payload: { sessionId: 's1', prompt: '>' } })
    const result = (id: number) => {
      socket().emit({
        ch: 'shell',
        type: 'result',
        payload: { id, resultType: 'Cursor', value: [{ a: id }] },
      })
      socket().emit({ ch: 'shell', type: 'done', payload: { id, prompt: '>' } })
    }
    result(1)
    await flushPromises()
    document.querySelector<HTMLButtonElement>('[data-result-clear]')!.click()
    await flushPromises()
    expect(document.querySelector('[data-result-history]')).toBeNull()
    result(2)
    await flushPromises()
    expect(document.querySelector('[data-result-history]')).not.toBeNull()
    document.querySelector<HTMLButtonElement>('[data-shell-menu] button, button[data-shell-menu]')!.click()
    await flushPromises()
    ;[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((i) => i.textContent?.trim() === 'Restart the shell')!
      .click()
    await flushPromises()
    useDialogStore().settle(true)
    await flushPromises()
    expect(document.querySelector('[data-result-history]')).toBeNull()
  })

  // Review 2026-10-12 (I2, M3, M4): clearing the results in full width brings the terminal back, keeps
  // the focus in the pane, says so with an Undo, and forgets the new-results mark.
  it('clears the results in full width back to the terminal, focus kept, with an Undo', async () => {
    mountPage()
    await flushPromises()
    socket().emit({ ch: 'shell', type: 'opened', payload: { sessionId: 's1', prompt: '>' } })
    const result = (id: number) => {
      socket().emit({
        ch: 'shell',
        type: 'result',
        payload: { id, resultType: 'Cursor', value: [{ a: id }] },
      })
      socket().emit({ ch: 'shell', type: 'done', payload: { id, prompt: '>' } })
    }
    result(1)
    result(2)
    await flushPromises()
    const terminal = () => document.querySelector('[data-shell-terminal-column]')!
    const mark = () => document.querySelector('[data-shell-new-results]')
    expect(mark()).not.toBeNull()
    document.querySelector<HTMLButtonElement>('[data-result-wide]')!.click()
    await flushPromises()
    expect(terminal().classList).toContain('lg:hidden')
    const clear = document.querySelector<HTMLButtonElement>('[data-result-clear]')!
    clear.focus()
    clear.click()
    await flushPromises()
    expect(document.querySelector('[data-result-history]')).toBeNull()
    expect(terminal().classList).not.toContain('lg:hidden')
    expect(mark()).toBeNull()
    expect(document.activeElement).toBe(document.querySelector('[data-result-pane]'))
    const { useToastStore } = await import('../src/stores/toasts')
    const toast = useToastStore().toasts.at(-1)!
    expect(toast).toMatchObject({ kind: 'info', message: i18n.global.t('shell.results.cleared') })
    // A result that came meanwhile stays the newest.
    result(3)
    await flushPromises()
    useToastStore().runAction(toast.id, 0)
    await flushPromises()
    document.querySelector<HTMLButtonElement>('[data-result-history] button')!.click()
    await flushPromises()
    const picks = [...document.querySelectorAll('[data-result-pick]')].map((o) =>
      o.getAttribute('data-result-pick'),
    )
    expect(picks).toEqual(['3', '2', '1'])
  })

  it('shows the keys: Enter runs, Shift+Enter starts a new line', async () => {
    mountPage()
    await flushPromises()
    const bar = document.querySelector('[data-shell-statusbar]')!.textContent ?? ''
    for (const key of ['Enter', 'run', 'Shift', 'new line', 'stop', 'clear', 'history'])
      expect(bar).toContain(key)
    expect(bar).not.toContain('Ctrl+Enter')
  })
})

describe('the redesigned shell page, second review', () => {
  function mountPage() {
    mockApi({
      'GET connections': () => [200, [{ id: 'c1', name: 'Prod', color: null, permissions: [], shell: true }]],
      'GET connections/c1/databases/shop/collections': () => [200, []],
    })
    return mountApp(ShellWorkspace, { props: { connectionId: 'c1', db: 'shop' } })
  }

  // Review minor 10: the narrow tabs are tabs (arrows move between them), and say new results.
  it('moves between the narrow tabs with the arrows, and marks results that came meanwhile', async () => {
    mountPage()
    await flushPromises()
    const tabs = () => [...document.querySelectorAll<HTMLButtonElement>('[data-shell-narrow-tab]')]
    expect(tabs().map((t) => t.getAttribute('aria-controls'))).toEqual([
      expect.stringContaining('terminal'),
      expect.stringContaining('results'),
    ])
    socket().emit({ ch: 'shell', type: 'opened', payload: { sessionId: 's1', prompt: '>' } })
    socket().emit({ ch: 'shell', type: 'result', payload: { id: 1, resultType: null, value: 1 } })
    await flushPromises()
    expect(tabs()[1]!.querySelector('[data-shell-new-results]')).toBeTruthy()
    tabs()[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    await flushPromises()
    expect(tabs()[1]!.getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(tabs()[1])
    expect(tabs()[1]!.querySelector('[data-shell-new-results]')).toBeNull()
  })

  // Review minor 14: the terminal follows the accent too, not only light and dark.
  it('follows the app’s accent', async () => {
    vi.spyOn(window, 'getComputedStyle').mockImplementation(
      () =>
        ({
          getPropertyValue: (name: string) =>
            name === '--ds-accent'
              ? document.documentElement.dataset.accent === 'indigo'
                ? '#4f46e5'
                : '#047a4d'
              : '',
        }) as never,
    )
    mountShell()
    await flushPromises()
    usePreferencesStore().setAccent('indigo')
    await flushPromises()
    expect((term().options as { theme: { cursor: string } }).theme.cursor).toBe('#4f46e5')
    vi.restoreAllMocks()
  })

  // Review minor 9: the results never squeeze the terminal below a usable width.
  it('keeps the terminal a usable width beside the results', async () => {
    let report!: (width: number) => void
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(private readonly cb: (entries: Array<{ contentRect: { width: number } }>) => void) {}
        observe() {
          report = (width) => this.cb([{ contentRect: { width } }])
        }
        disconnect() {}
      },
    )
    mountPage()
    await flushPromises()
    const handle = () =>
      [...document.querySelectorAll<HTMLElement>('[role="separator"][aria-orientation="vertical"]')].at(-1)!
    report(1000)
    await flushPromises()
    expect(handle().getAttribute('aria-valuemax')).toBe('580')
    expect(handle().getAttribute('aria-valuenow')).toBe('440')
    report(700)
    await flushPromises()
    expect(handle().getAttribute('aria-valuemax')).toBe('320')
    expect(handle().getAttribute('aria-valuenow')).toBe('320')
  })
})

// Review 2026-10-12: the terminal as the one place code is typed — its keys as a terminal's.
describe('the terminal’s keys and lines, second review', () => {
  type Api = { status: string; running: boolean; run(code: string): boolean }
  const view = (w: { vm: unknown }) => w.vm as unknown as Api
  async function opened(extra: Record<string, unknown> = {}) {
    const mounted = mountShell(extra)
    await flushPromises()
    socket().emit({ ch: 'shell', type: 'opened', payload: { sessionId: 's1', prompt: 'shop>' } })
    await flushPromises()
    return mounted
  }
  const shownAfter = (from: number) => plain(term().written.slice(from).join(''))

  // I9: Ctrl+C on selected output cleared the line or stopped the command.
  it('copies with Ctrl+C when output is selected, never clearing the line or stopping a command', async () => {
    await opened()
    term().dataHandler!('half typed')
    term().selected = true
    const event = new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, cancelable: true })
    expect(term().keyHandler!(event)).toBe(false)
    expect(event.defaultPrevented).toBe(false)
    const before = term().written.length
    term().selected = false
    key({ key: 'Home' })
    expect(shownAfter(before)).toContain('shop> half typed')
    key({ key: 'Enter' })
    term().selected = true
    term().keyHandler!(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true }))
    expect(socket().sent.some((m) => m.type === 'cancel')).toBe(false)
  })

  // Found 2026-10-12: AltGr (Ctrl+Alt) types `{`, `[`, `@`, `$` on a Turkish keyboard; it was taken
  // for a shortcut and nothing was typed.
  it('lets AltGr type, never taking it for a Ctrl shortcut', async () => {
    await opened()
    for (const ch of ['{', '[', '@', '$']) {
      const altGr = new KeyboardEvent('keydown', { key: ch, ctrlKey: true, altKey: true })
      expect(term().keyHandler!(altGr), ch).toBe(true)
      term().dataHandler!(ch)
    }
    const before = term().written.length
    key({ key: 'End' })
    key({ key: 'ArrowLeft' })
    expect(shownAfter(before)).toContain('{[@$')
  })

  it('moves by word with Alt+B and Alt+F, and drops escape sequences of other keys', async () => {
    await opened()
    term().dataHandler!('db.orders find')
    expect(term().keyHandler!(new KeyboardEvent('keydown', { key: 'b', altKey: true }))).toBe(false)
    term().dataHandler!('\x1b[5~') // PageUp
    term().dataHandler!('\x1bb') // Alt+B as text
    term().dataHandler!('X')
    const before = term().written.length
    key({ key: 'End' })
    expect(shownAfter(before)).toContain('shop> db.orders Xfind')
    expect(shownAfter(0)).not.toContain('[5~')
  })

  // I10: Ctrl+A and Ctrl+E moved the cursor, but nothing was drawn.
  it('draws the line again when only the cursor moved (Ctrl+A, Ctrl+E)', async () => {
    await opened()
    term().dataHandler!('abc')
    for (const name of ['a', 'e']) {
      const before = term().written.length
      key({ key: name, ctrlKey: true })
      expect(term().written.length, name).toBeGreaterThan(before)
    }
  })

  // Minor 9: a paste while searching was added to the entry found.
  it('takes a paste while searching as what is searched for', async () => {
    historyMock.entries = [{ id: '1', code: 'db.orders.find()', usedAt: 1, count: 1 }]
    await opened()
    await flushPromises()
    key({ key: 'r', ctrlKey: true })
    paste('orders\r')
    const before = term().written.length
    key({ key: 'End' })
    expect(shownAfter(before)).toContain('shop> db.orders.find()')
    historyMock.entries = []
  })

  it('takes keys typed while searching as what is searched for', async () => {
    historyMock.entries = [
      { id: '2', code: 'db.items.find()', usedAt: 2, count: 1 },
      { id: '1', code: 'db.orders.find()', usedAt: 1, count: 1 },
    ]
    await opened()
    await flushPromises()
    key({ key: 'r', ctrlKey: true })
    for (const ch of 'orders') term().dataHandler!(ch)
    const before = term().written.length
    key({ key: 'Home' })
    expect(shownAfter(before)).toContain('shop> db.orders.find()')
    historyMock.entries = []
  })

  it('writes a string result plain, as mongosh does', async () => {
    await opened()
    const before = term().written.length
    socket().emit({
      ch: 'shell',
      type: 'result',
      payload: { id: 1, resultType: null, value: 'switched to db shop' },
    })
    const out = term().written.slice(before).join('')
    expect(out).toContain('switched to db shop')
    expect(out).not.toMatch(
      new RegExp(`${String.fromCharCode(27)}\\[3[0-9]mswitched|${String.fromCharCode(27)}\\[3[0-9]mdb`),
    )
  })

  it('drops control characters from typed text, keeping its tabs', async () => {
    await opened()
    term().dataHandler!('a\x01\x7fb\tc')
    const before = term().written.length
    key({ key: 'Home' })
    expect(shownAfter(before)).toContain('shop> ab\tc')
  })

  it('says a snippet too large for the line is not put in', async () => {
    const { wrapper } = await opened()
    const api = wrapper.vm as unknown as { insert(code: string): string }
    expect(api.insert(`x = '${'y'.repeat(70 * 1024)}'`)).toBe('tooLarge')
    expect(api.insert('db.ok()')).toBe('inserted')
  })

  // Minor 11: code typed while a command still ran after a reload was sent at once, and refused.
  it('runs code that waited for a command still running after a reload once it has ended', async () => {
    const S3 = '33333333-3333-4333-8444-555555555555'
    sessionStorage.setItem('mm:shell-session:tab-5', S3)
    const { wrapper } = mountShell({ sessionKey: 'tab-5' })
    await flushPromises()
    expect(view(wrapper).run('db.later()')).toBe(true)
    socket().emit({ ch: 'shell', type: 'opened', payload: { sessionId: S3, prompt: '>', running: true } })
    await flushPromises()
    expect(socket().sent.some((m) => m.type === 'eval')).toBe(false)
    expect(plain(term().written.join(''))).toContain('a command is still running')
    socket().emit({ ch: 'shell', type: 'done', payload: { id: 9, prompt: '>' } })
    expect(
      socket()
        .sent.filter((m) => m.type === 'eval')
        .map((m) => m.code),
    ).toEqual(['db.later()'])
    expect(view(wrapper).running).toBe(true)
    sessionStorage.clear()
  })

  // Minor 6: collections were read again only after a run that ended well.
  it('says what was typed has run, however it ended, and when the shell closed under a command', async () => {
    const ran = vi.fn()
    await opened({ onRan: ran })
    term().dataHandler!('nope()')
    key({ key: 'Enter' })
    socket().emit({ ch: 'shell', type: 'error', payload: { id: 1, message: 'nope is not defined' } })
    socket().emit({ ch: 'shell', type: 'done', payload: { id: 1, prompt: 'shop>' } })
    expect(ran).toHaveBeenCalledTimes(1)
    term().dataHandler!('db.slow()')
    key({ key: 'Enter' })
    socket().emit({ ch: 'shell', type: 'closed', payload: { reason: 'crash' } })
    expect(ran).toHaveBeenCalledTimes(2)
  })

  // M4: a zero-width character could hide in a name typed or put in by a snippet.
  it('shows a character that shows nothing as its escape in the line', async () => {
    await opened()
    paste('db.users\u200b.find()')
    expect(shownAfter(0)).toContain('db.users\\u200b.find()')
  })

  // M5: colouring a very long line on every key took tens of milliseconds.
  it('draws a very long line without colours', async () => {
    await opened()
    const before = term().written.length
    paste(`db.x.insertOne({ a: '${'x'.repeat(25_000)}' })`)
    const out = term().written.slice(before).join('')
    expect(out).not.toContain(`${String.fromCharCode(27)}[36mdb`)
    term().dataHandler!('')
  })
})

// Second review 2026-10-12, the page's side.
describe('the terminal, second review', () => {
  async function opened(extra: Record<string, unknown> = {}) {
    const mounted = mountShell(extra)
    await flushPromises()
    socket().emit({ ch: 'shell', type: 'opened', payload: { sessionId: 's1', prompt: 'shop>' } })
    await flushPromises()
    return mounted
  }
  const shownAfter = (from: number) => plain(term().written.slice(from).join(''))
  const press = (init: KeyboardEventInit) => {
    const event = new KeyboardEvent('keydown', { cancelable: true, bubbles: true, ...init })
    const stopped = vi.spyOn(event, 'stopPropagation')
    const passOn = term().keyHandler!(event)
    return { event, passOn, stopped }
  }

  // I4: Ctrl+R reloaded the page, Ctrl+L went to the address bar, Ctrl+K opened the palette.
  it('keeps the keys it takes from the browser and the page, and leaves it paste and copy', async () => {
    await opened()
    for (const init of [
      { key: 'r', ctrlKey: true },
      { key: 'l', ctrlKey: true },
      { key: 'k', ctrlKey: true },
      { key: 'u', ctrlKey: true },
      { key: 'Enter', ctrlKey: true },
      { key: 'ArrowUp' },
      { key: 'b', code: 'KeyB', altKey: true },
    ]) {
      const { event, passOn, stopped } = press(init)
      expect([init.key, event.defaultPrevented, passOn]).toEqual([init.key, true, false])
      expect(stopped).toHaveBeenCalled()
      press({ key: 'Escape' })
    }
    const paste = press({ key: 'v', ctrlKey: true })
    expect([paste.event.defaultPrevented, paste.passOn]).toEqual([false, false])
    // The page's shortcuts with Shift (Ctrl+Shift+L opens the Library) go on to the page (found by e2e).
    const library = press({ key: 'L', ctrlKey: true, shiftKey: true })
    expect([library.event.defaultPrevented, library.passOn]).toEqual([false, false])
    expect(library.stopped).not.toHaveBeenCalled()
  })

  // Minor 20: Enter picking an input method's candidate ran the line.
  it('leaves keys to an input method while it composes', async () => {
    await opened()
    term().dataHandler!('db.x')
    const { event, passOn } = press({ key: 'Enter', isComposing: true })
    expect([event.defaultPrevented, passOn]).toEqual([false, true])
    expect(socket().sent.some((m) => m.type === 'eval')).toBe(false)
  })

  // Minor 19: Option+B typed ∫ on macOS; Ctrl+Backspace did nothing.
  it('moves by word with Option+B on a Mac, and deletes a word with Ctrl+Backspace', async () => {
    await opened()
    term().dataHandler!('db.orders.find')
    press({ key: '∫', code: 'KeyB', altKey: true })
    const typed = term().written.length
    term().dataHandler!('X')
    expect(shownAfter(typed)).toContain('shop> db.orders.Xfind')
    press({ key: 'End' })
    press({ key: 'Backspace', ctrlKey: true })
    const before = term().written.length
    press({ key: 'Home' })
    expect(shownAfter(before)).toContain('shop> db.orders.')
    expect(shownAfter(before)).not.toContain('find')
  })

  // Minor 15: the worker's own words were English in a Turkish page.
  it('words the errors the page knows in the user’s language', async () => {
    await opened()
    i18n.global.locale.value = 'tr'
    const before = term().written.length
    socket().emit({ ch: 'shell', type: 'error', payload: { id: 1, code: 'NOT_AVAILABLE', message: 'cls' } })
    socket().emit({ ch: 'shell', type: 'error', payload: { id: 1, code: 'STOPPED', message: 'Stopped.' } })
    socket().emit({
      ch: 'shell',
      type: 'error',
      payload: { id: 1, code: 'DISCONNECTED', message: 'Client must be connected' },
    })
    socket().emit({ ch: 'shell', type: 'error', payload: { id: 1, message: 'a is not defined' } })
    const shown = shownAfter(before)
    expect(shown).toContain(i18n.global.t('shell.errors.notAvailable.cls'))
    expect(shown).toContain(i18n.global.t('shell.errors.stopped'))
    expect(shown).toContain(i18n.global.t('shell.errors.disconnected'))
    expect(shown).toContain('a is not defined')
    i18n.global.locale.value = 'en'
  })

  // Security audit 2026-10-16 (Important 1): server JavaScript refused by the proxy is worded by the
  // page, in the user's language.
  it('words a refusal of server JavaScript in the user’s language', async () => {
    await opened()
    i18n.global.locale.value = 'tr'
    const before = term().written.length
    socket().emit({
      ch: 'shell',
      type: 'error',
      payload: { id: 1, code: 'SERVER_JS', message: 'Refused by Mongo Manager: $where runs JavaScript' },
    })
    const shown = shownAfter(before)
    expect(shown).toContain(i18n.global.t('shell.errors.serverJs'))
    expect(shown).not.toContain('Refused by Mongo Manager')
    i18n.global.locale.value = 'en'
  })

  // Minor 18: Up and Down kept a column of the text, not where the terminal shows it.
  it('moves between lines at the column the terminal shows, the prompt counted', async () => {
    await opened()
    term().dataHandler!('abcdef')
    press({ key: 'Enter', shiftKey: true })
    term().dataHandler!('xy')
    press({ key: 'ArrowUp' }) // "... xy|" is column 6; "shop> |abcdef" is column 6 too
    term().dataHandler!('Q')
    const before = term().written.length
    press({ key: 'End' })
    expect(shownAfter(before)).toContain('shop> Qabcdef')
  })

  // Minor 6: an empty print was lost.
  it('writes an empty print as an empty line', async () => {
    await opened()
    const before = term().written.length
    socket().emit({ ch: 'shell', type: 'print', payload: { id: 1, text: 'a' } })
    socket().emit({ ch: 'shell', type: 'print', payload: { id: 1, text: '' } })
    socket().emit({ ch: 'shell', type: 'print', payload: { id: 1, text: 'b' } })
    expect(shownAfter(before)).toMatch(/a\r\n\r\nb/)
  })

  // Minor 24: a paste while a command ran was dropped without a word; `cls` after Shift+Enter was
  // sent to the shell, and refused there.
  it('says a paste was not taken while a command runs, and clears for cls with a blank line after it', async () => {
    await opened()
    term().dataHandler!('sleep(9000)')
    press({ key: 'Enter' })
    const before = term().written.length
    paste('db.x.find()')
    expect(shownAfter(before)).toContain(i18n.global.t('shell.pasteWhileRunning'))
    socket().emit({ ch: 'shell', type: 'done', payload: { id: 1, prompt: 'shop>' } })
    const cleared = vi.spyOn(term() as unknown as { clear(): void }, 'clear')
    term().dataHandler!('cls')
    press({ key: 'Enter', shiftKey: true })
    press({ key: 'Enter' })
    expect(cleared).toHaveBeenCalled()
    expect(socket().sent.filter((m) => m.type === 'eval')).toHaveLength(1)
  })

  // Minor 17: the search's line showed a character that shows nothing as nothing.
  it('shows a character that shows nothing as its escape while searching', async () => {
    historyMock.entries = [{ id: '1', code: 'db.users\u200b.find()', usedAt: 1, count: 1 }]
    await opened()
    await flushPromises()
    press({ key: 'r', ctrlKey: true })
    const before = term().written.length
    term().dataHandler!('users')
    expect(shownAfter(before)).toContain('db.users\\u200b.find()')
    historyMock.entries = []
  })
})
