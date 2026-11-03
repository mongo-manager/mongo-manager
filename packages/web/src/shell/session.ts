import { ref, watch, type Ref } from 'vue'
import { realtimeSocket } from '@/jobs/live'
import type { ChannelMessage } from '@/jobs/socket'

/**
 * Phase 3a-1 spec §6: the browser side of one shell session over the shared /ws socket. It opens a
 * session, sends evals, streams the parts back, and reattaches after a reconnect. The terminal view
 * consumes its callbacks; nothing here touches xterm directly.
 */
/**
 * How a session came to be: a new one asked for; the same one again (a reattach after a reconnect or
 * a reload — its variables kept); or a new one in place of one the server no longer had.
 */
export type OpenedHow = 'new' | 'resumed' | 'replaced'

export interface ShellSessionHandlers {
  /**
   * `db`: on a reattach, the database the shell is on (it may differ from the one opened);
   * `running`: whether a command still runs on the server (a reattach while one ran).
   */
  onOpened: (prompt: string, db: string | undefined, running: boolean, how: OpenedHow) => void
  /** The session's id once it has one, null once it has none: a page keeps it for a reload. */
  onSessionId?: (id: string | null) => void
  onPart: (part: ChannelMessage) => void
  /** `reason`: a code (idle, lifetime, closed, access, ended, …) the view words. */
  onClosed: (reason: string) => void
  /** `open`: the failure is the open's (the session never started). */
  onFailed: (
    code: string,
    message: string,
    open: boolean,
    about?: { kind?: string; remembered?: boolean },
  ) => void
}

export interface ShellSession {
  /** Opens a session — or, given the id of one kept from before a reload, attaches to it. */
  open: (connectionId: string, db: string, resume?: string | null) => void
  /** Sends code to run: its id, or null when it could not be sent (no session yet, the socket down). */
  evaluate: (code: string) => number | null
  /** Phase 3a-2: ask the worker to complete the code; [] with no session, on error or after 3 s. */
  complete: (code: string) => Promise<string[]>
  cancel: () => void
  close: () => void
  dispose: () => void
}

const COMPLETE_TIMEOUT_MS = 3000
/** How long a disposed session still waits for the answer to an open it gave up on. */
const ABANDONED_WAIT_MS = 60_000

/** A tag unique to this page: a session's own receiver, an open's own ref. */
let tags = 0
const newTag = () =>
  `s${Date.now().toString(36)}${(tags++).toString(36)}${Math.random().toString(36).slice(2, 10)}`

export function createShellSession(handlers: ShellSessionHandlers): ShellSession {
  const socket = realtimeSocket()
  const sessionId: Ref<string | null> = ref(null)
  let target: { connectionId: string; db: string } | null = null
  let nextId = 1
  let nextCompleteId = 1
  /** Completion replies awaited, by request id. */
  const completions = new Map<number, (items: string[]) => void>()
  let stopReceiving: (() => void) | null = null
  let stopState: (() => void) | null = null
  /** The last open's tag, echoed on its opened or failed (shell tabs share one socket: 2026-10-11). */
  let openTag = ''
  /**
   * Opens given up on before their answer (a restart, a tab closed while connecting): the session the
   * server opens for one is closed at once, never left holding a slot (review 2026-10-11, I3).
   */
  const abandoned = new Set<string>()
  /**
   * The session an attach was sent for, until its answer: a gone one is replaced by a new session,
   * never said as closed (user report 2026-10-12: "Shell kapandı … Bağlandı" over and over).
   */
  let attaching: string | null = null
  /** The open in flight replaces a session the server no longer had. */
  let replacing = false
  let disposed = false
  let lingering: ReturnType<typeof setTimeout> | undefined

  /** The open in flight, if any, is given up on. */
  function giveUpOpen(): void {
    if (openTag && !sessionId.value) abandoned.add(openTag)
    openTag = ''
  }

  function stopListening(): void {
    clearTimeout(lingering)
    stopReceiving?.()
    stopReceiving = null
  }

  /** The answer to an open given up on: its session is closed; nothing else is done with it. */
  function settleAbandoned(m: ChannelMessage, ref: string): void {
    abandoned.delete(ref)
    if (m.type === 'opened' && typeof m.payload.sessionId === 'string')
      socket?.send({ ch: 'shell', type: 'close', sessionId: m.payload.sessionId })
    if (disposed && abandoned.size === 0) stopListening()
  }

  /** Whether a message is this session's: its open's ref, or the session it names (or attaches to). */
  function mine(m: ChannelMessage): boolean {
    const p = m.payload
    if (typeof p.ref === 'string') return p.ref === openTag && openTag !== ''
    return typeof p.sessionId === 'string' && (p.sessionId === sessionId.value || p.sessionId === attaching)
  }

  function setSession(id: string | null): void {
    if (sessionId.value === id) return
    sessionId.value = id
    handlers.onSessionId?.(id)
  }

  function sendAttach(id: string): void {
    attaching = id
    socket?.send({ ch: 'shell', type: 'attach', sessionId: id })
  }

  function sendOpen(): void {
    if (!target) return
    giveUpOpen()
    openTag = newTag()
    socket?.send({
      ch: 'shell',
      type: 'open',
      connectionId: target.connectionId,
      db: target.db,
      ref: openTag,
    })
  }

  if (socket) {
    // Its own receiver: several shell tabs live at once, each hearing only its session.
    stopReceiving = socket.receiver(`shell:${newTag()}`, 'shell', (m) => {
      const ref = m.payload.ref
      if (typeof ref === 'string' && abandoned.has(ref)) return settleAbandoned(m, ref)
      if (!disposed && mine(m)) dispatch(m)
    })
    // After a reconnect, reattach to the existing session so its worker is not lost.
    stopState = watch(socket.state, (state) => {
      if (state !== 'open') return
      if (sessionId.value) sendAttach(sessionId.value)
      else if (attaching) sendAttach(attaching)
      else sendOpen()
    })
  }

  function ended(reason: string): void {
    setSession(null)
    // Ended for good: no reconnect opens it again (a new shell is asked for).
    target = null
    attaching = null
    for (const resolve of [...completions.values()]) resolve([])
    handlers.onClosed(reason)
  }

  function dispatch(m: ChannelMessage): void {
    switch (m.type) {
      case 'opened': {
        const how: OpenedHow =
          typeof m.payload.ref === 'string' ? (replacing ? 'replaced' : 'new') : 'resumed'
        openTag = ''
        attaching = null
        replacing = false
        setSession(String(m.payload.sessionId))
        handlers.onOpened(
          String(m.payload.prompt ?? '>'),
          typeof m.payload.db === 'string' && m.payload.db ? m.payload.db : undefined,
          m.payload.running === true,
          how,
        )
        break
      }
      case 'closed':
        // The answer to an attach: the server no longer has it (it restarted, or the session waited
        // too long). A new one takes its place, said once, if a session is still wanted.
        if (
          attaching !== null &&
          m.payload.sessionId === attaching &&
          m.payload.reason === 'ended' &&
          target
        ) {
          attaching = null
          // Whatever kept its id lets it go (a reload's id, even one never attached here).
          sessionId.value = null
          handlers.onSessionId?.(null)
          replacing = true
          for (const resolve of [...completions.values()]) resolve([])
          return sendOpen()
        }
        ended(String(m.payload.reason ?? 'closed'))
        break
      case 'failed': {
        const code = String(m.payload.code ?? 'INTERNAL')
        const open = typeof m.payload.ref === 'string'
        if (open) openTag = ''
        // A session the server no longer knows has ended (review I2): never "Connected" for ever.
        if (!open && code === 'NOT_FOUND') return ended('ended')
        handlers.onFailed(code, String(m.payload.message ?? 'Shell error'), open, {
          ...(typeof m.payload.kind === 'string' ? { kind: m.payload.kind } : {}),
          ...(m.payload.remembered === true ? { remembered: true } : {}),
        })
        break
      }
      case 'completions': {
        const resolve = completions.get(Number(m.payload.id))
        const items = Array.isArray(m.payload.items) ? m.payload.items : []
        resolve?.(items.filter((i): i is string => typeof i === 'string'))
        break
      }
      default:
        handlers.onPart(m)
    }
  }

  return {
    open(connectionId, db, resume) {
      target = { connectionId, db }
      replacing = false
      // A session kept from before a reload: the same one again, its variables kept.
      if (resume) {
        giveUpOpen()
        return sendAttach(resume)
      }
      // If the socket is not open yet, the state watch sends open once it connects.
      sendOpen()
    },
    evaluate(code) {
      const id = nextId++
      const sent =
        !!sessionId.value &&
        socket?.send({ ch: 'shell', type: 'eval', sessionId: sessionId.value, id, code }) === true
      return sent ? id : null
    },
    complete(code) {
      const current = sessionId.value
      if (!socket || !current) return Promise.resolve([])
      const id = nextCompleteId++
      return new Promise<string[]>((resolve) => {
        const timer = setTimeout(() => {
          completions.delete(id)
          resolve([])
        }, COMPLETE_TIMEOUT_MS)
        completions.set(id, (items) => {
          clearTimeout(timer)
          completions.delete(id)
          resolve(items)
        })
        socket.send({ ch: 'shell', type: 'complete', sessionId: current, id, code })
      })
    },
    cancel() {
      if (sessionId.value) socket?.send({ ch: 'shell', type: 'cancel', sessionId: sessionId.value })
    },
    close() {
      // The session open, or the one being attached to (review 2026-10-12, M9): closed on the server,
      // its id let go wherever it was kept.
      const held = sessionId.value ?? attaching
      if (held) socket?.send({ ch: 'shell', type: 'close', sessionId: held })
      giveUpOpen()
      sessionId.value = null
      attaching = null
      target = null
      handlers.onSessionId?.(null)
      // Completions waiting for this session have no answer coming (review minor 4).
      for (const resolve of [...completions.values()]) resolve([])
    },
    dispose() {
      disposed = true
      stopState?.()
      // An open still in flight is answered later: its receiver waits to close what it opened.
      giveUpOpen()
      if (abandoned.size === 0) stopListening()
      else lingering = setTimeout(stopListening, ABANDONED_WAIT_MS)
    },
  }
}
