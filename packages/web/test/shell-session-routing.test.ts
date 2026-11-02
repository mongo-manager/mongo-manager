import { describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'

type Msg = { ch: string; type: string; payload: Record<string, unknown> }
const { shared } = vi.hoisted(() => {
  const receivers = new Map<string, (m: Msg) => void>()
  const shared = {
    state: { value: 'open' } as { value: string },
    sent: [] as Array<Record<string, unknown>>,
    receivers,
    // As the app's socket: one receiver per key, a second under the same key replaces the first.
    receiver(key: string, _ch: string, on: (m: Msg) => void) {
      receivers.set(key, on)
      return () => {
        if (receivers.get(key) === on) receivers.delete(key)
      }
    },
    send(m: Record<string, unknown>) {
      shared.sent.push(m)
      return true
    },
    emit(m: Msg) {
      for (const on of [...receivers.values()]) on(m)
    },
  }
  return { shared }
})
vi.mock('../src/jobs/live', () => ({ realtimeSocket: () => shared }))

import { createShellSession } from '../src/shell/session'

// The shell's redesign (2026-10-11): shell tabs stay open together and share one socket. Each takes
// only its own session's messages — before, the newest tab took them all and the others went dead.
describe('shell sessions sharing one socket', () => {
  function session() {
    const seen = {
      opened: [] as string[],
      running: [] as boolean[],
      parts: [] as unknown[],
      closed: [] as string[],
      failed: [] as string[],
      openFailed: [] as boolean[],
      how: [] as string[],
      ids: [] as Array<string | null>,
    }
    const s = createShellSession({
      onOpened: (prompt, _db, running, how) => {
        seen.opened.push(prompt)
        seen.running.push(running)
        seen.how.push(how)
      },
      onSessionId: (id) => seen.ids.push(id),
      onPart: (part) => seen.parts.push(part.payload),
      onClosed: (reason) => seen.closed.push(reason),
      onFailed: (_code, message, open) => {
        seen.failed.push(message)
        seen.openFailed.push(open)
      },
    })
    return { s, seen }
  }
  const refOf = (i: number) => shared.sent.filter((m) => m.type === 'open').at(i)!.ref as string

  it('each takes its own open, parts, completions and close — never another’s', async () => {
    const a = session()
    const b = session()
    a.s.open('c1', 'shop')
    b.s.open('c1', 'crm')
    expect(refOf(0)).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
    expect(refOf(0)).not.toBe(refOf(1))
    shared.emit({ ch: 'shell', type: 'opened', payload: { sessionId: 'sb', prompt: 'crm>', ref: refOf(1) } })
    shared.emit({ ch: 'shell', type: 'opened', payload: { sessionId: 'sa', prompt: 'shop>', ref: refOf(0) } })
    expect(a.seen.opened).toEqual(['shop>'])
    expect(b.seen.opened).toEqual(['crm>'])
    shared.emit({ ch: 'shell', type: 'print', payload: { sessionId: 'sa', text: 'for a' } })
    shared.emit({ ch: 'shell', type: 'print', payload: { sessionId: 'sb', text: 'for b' } })
    expect(a.seen.parts).toEqual([{ sessionId: 'sa', text: 'for a' }])
    expect(b.seen.parts).toEqual([{ sessionId: 'sb', text: 'for b' }])
    const done = b.s.complete('db.')
    const id = shared.sent.at(-1)!.id
    shared.emit({ ch: 'shell', type: 'completions', payload: { sessionId: 'sa', id, items: ['wrong'] } })
    shared.emit({ ch: 'shell', type: 'completions', payload: { sessionId: 'sb', id, items: ['db.leads'] } })
    await expect(done).resolves.toEqual(['db.leads'])
    shared.emit({ ch: 'shell', type: 'closed', payload: { sessionId: 'sb', reason: 'closed' } })
    expect(b.seen.closed).toEqual(['closed'])
    expect(a.seen.closed).toEqual([])
    // A failure belongs to the open (its ref) or the session it names; one naming neither is no one's.
    shared.emit({ ch: 'shell', type: 'failed', payload: { code: 'X', message: 'other' } })
    shared.emit({ ch: 'shell', type: 'failed', payload: { code: 'X', message: 'mine', sessionId: 'sa' } })
    expect(a.seen.failed).toEqual(['mine'])
    expect(b.seen.failed).toEqual([])
    a.s.dispose()
    b.s.dispose()
  })

  it('a session closed and opened again ignores what its old session still says', () => {
    const a = session()
    a.s.open('c1', 'shop')
    shared.emit({ ch: 'shell', type: 'opened', payload: { sessionId: 'old', prompt: '>', ref: refOf(2) } })
    a.s.close()
    a.s.open('c1', 'shop')
    expect(refOf(3)).not.toBe(refOf(2))
    // The old session's close arrives after the new open: not this session's any more.
    shared.emit({ ch: 'shell', type: 'closed', payload: { sessionId: 'old', reason: 'closed' } })
    shared.emit({ ch: 'shell', type: 'opened', payload: { sessionId: 'new', prompt: '>', ref: refOf(3) } })
    expect(a.seen.closed).toEqual([])
    expect(a.seen.opened).toHaveLength(2)
    a.s.dispose()
  })

  // Review 2026-10-11 (I1): an open that failed is said as such (the page offers a new shell).
  it('says when the failure is its open’s', () => {
    const a = session()
    a.s.open('c1', 'shop')
    const ref = shared.sent.filter((m) => m.type === 'open').at(-1)!.ref
    shared.emit({ ch: 'shell', type: 'failed', payload: { code: 'TOO_MANY', message: 'too many', ref } })
    expect(a.seen.openFailed).toEqual([true])
    a.s.dispose()
  })

  // Review I2: a session the server no longer knows is closed, not "Connected" for ever.
  it('takes its session unknown to the server as closed', () => {
    const a = session()
    a.s.open('c1', 'shop')
    const ref = shared.sent.filter((m) => m.type === 'open').at(-1)!.ref
    shared.emit({ ch: 'shell', type: 'opened', payload: { sessionId: 'gone1', prompt: '>', ref } })
    shared.emit({
      ch: 'shell',
      type: 'failed',
      payload: { code: 'NOT_FOUND', message: 'x', sessionId: 'gone1' },
    })
    expect(a.seen.closed).toEqual(['ended'])
    expect(a.seen.openFailed).toEqual([])
    a.s.dispose()
  })

  // Review I3: an open given up before its answer (a restart, a tab closed) is closed when it comes.
  it('closes a session it gave up on as soon as the server opens it', () => {
    const a = session()
    a.s.open('c1', 'shop')
    const first = shared.sent.filter((m) => m.type === 'open').at(-1)!.ref
    a.s.close()
    a.s.open('c1', 'shop')
    shared.emit({ ch: 'shell', type: 'opened', payload: { sessionId: 'late', prompt: '>', ref: first } })
    expect(shared.sent.at(-1)).toEqual({ ch: 'shell', type: 'close', sessionId: 'late' })
    expect(a.seen.opened).toEqual([])
    // A tab closed while its shell connects: its receiver waits for the answer, then closes it.
    const b = session()
    b.s.open('c1', 'crm')
    const pending = shared.sent.filter((m) => m.type === 'open').at(-1)!.ref
    b.s.close()
    b.s.dispose()
    shared.emit({ ch: 'shell', type: 'opened', payload: { sessionId: 'orphan', prompt: '>', ref: pending } })
    expect(shared.sent.at(-1)).toEqual({ ch: 'shell', type: 'close', sessionId: 'orphan' })
    expect(b.seen.opened).toEqual([])
    a.s.dispose()
  })

  // Review I4: a reattach says whether a command still runs; minor 4: a close answers completions.
  it('passes on whether a command runs after a reattach, and answers completions on close', async () => {
    const a = session()
    a.s.open('c1', 'shop')
    const ref = shared.sent.filter((m) => m.type === 'open').at(-1)!.ref
    shared.emit({ ch: 'shell', type: 'opened', payload: { sessionId: 'r1', prompt: '>', ref } })
    shared.emit({ ch: 'shell', type: 'opened', payload: { sessionId: 'r1', prompt: '>', running: true } })
    expect(a.seen.running).toEqual([false, true])
    const waiting = a.s.complete('db.')
    a.s.close()
    // At once, not after the 3 s a completion waits for its answer.
    const late = new Promise((resolve) => setTimeout(() => resolve('late'), 100))
    await expect(Promise.race([waiting, late])).resolves.toEqual([])
    a.s.dispose()
  })

  it('closes what its open brings after it was closed, and stops listening at once after a failed open', () => {
    const a = session()
    a.s.open('c1', 'shop')
    const ref = shared.sent.filter((m) => m.type === 'open').at(-1)!.ref
    a.s.close()
    shared.emit({ ch: 'shell', type: 'opened', payload: { sessionId: 'after', prompt: '>', ref } })
    expect(shared.sent.at(-1)).toEqual({ ch: 'shell', type: 'close', sessionId: 'after' })
    expect(a.seen.opened).toEqual([])
    a.s.dispose()
    // A failed open leaves nothing to wait for: its receiver goes with it.
    const before = shared.receivers.size
    const b = session()
    b.s.open('c1', 'shop')
    const bRef = shared.sent.filter((m) => m.type === 'open').at(-1)!.ref
    shared.emit({ ch: 'shell', type: 'failed', payload: { code: 'TOO_MANY', message: 'x', ref: bRef } })
    b.s.dispose()
    expect(shared.receivers.size).toBe(before)
  })

  // User report 2026-10-12: a reloaded page opened new shells while its old ones waited, until "too
  // many shells open"; its shell and its variables were lost on every reload.
  it('attaches to the session it is given, and says so', () => {
    const a = session()
    a.s.open('c1', 'shop', 'kept')
    expect(shared.sent.at(-1)).toEqual({ ch: 'shell', type: 'attach', sessionId: 'kept' })
    shared.emit({ ch: 'shell', type: 'opened', payload: { sessionId: 'kept', prompt: 'shop>', db: 'shop' } })
    expect(a.seen.how).toEqual(['resumed'])
    expect(a.seen.ids).toEqual(['kept'])
    a.s.dispose()
  })

  // User report 2026-10-12: "Shell kapandı: oturumu sona erdi. Bağlandı." over and over — the page
  // said closed for a session the server no longer had, then opened one on the next reconnect.
  it('opens a new session, never saying closed, when the one it attaches to is gone', () => {
    const a = session()
    a.s.open('c1', 'shop', 'gone')
    shared.emit({ ch: 'shell', type: 'closed', payload: { sessionId: 'gone', reason: 'ended' } })
    expect(a.seen.closed).toEqual([])
    const open = shared.sent.at(-1)!
    expect(open).toMatchObject({ ch: 'shell', type: 'open', connectionId: 'c1', db: 'shop' })
    shared.emit({ ch: 'shell', type: 'opened', payload: { sessionId: 'fresh', prompt: '>', ref: open.ref } })
    expect(a.seen.how).toEqual(['replaced'])
    expect(a.seen.ids).toEqual([null, 'fresh'])
    // A fresh open is said as one.
    const b = session()
    b.s.open('c1', 'shop')
    shared.emit({ ch: 'shell', type: 'opened', payload: { sessionId: 'b1', prompt: '>', ref: refOf(-1) } })
    expect(b.seen.how).toEqual(['new'])
    a.s.dispose()
    b.s.dispose()
  })

  it('reattaches after a reconnect, opens anew if the server lost it, and never reopens one it ended', async () => {
    const state = ref('open')
    shared.state = state as never
    const a = session()
    a.s.open('c1', 'shop')
    shared.emit({ ch: 'shell', type: 'opened', payload: { sessionId: 'r1', prompt: '>', ref: refOf(-1) } })
    // The link drops and comes back: the same session.
    state.value = 'connecting'
    await nextTick()
    state.value = 'open'
    await nextTick()
    expect(shared.sent.at(-1)).toEqual({ ch: 'shell', type: 'attach', sessionId: 'r1' })
    // The server restarted meanwhile: a new one, said as such.
    shared.emit({ ch: 'shell', type: 'closed', payload: { sessionId: 'r1', reason: 'ended' } })
    shared.emit({ ch: 'shell', type: 'opened', payload: { sessionId: 'r2', prompt: '>', ref: refOf(-1) } })
    expect(a.seen.how).toEqual(['new', 'replaced'])
    expect(a.seen.closed).toEqual([])
    // Ended by the server (idle): said once, and no reconnect opens it again.
    shared.emit({ ch: 'shell', type: 'closed', payload: { sessionId: 'r2', reason: 'idle' } })
    expect(a.seen.closed).toEqual(['idle'])
    const sent = shared.sent.length
    state.value = 'connecting'
    await nextTick()
    state.value = 'open'
    await nextTick()
    expect(shared.sent.slice(sent)).toEqual([])
    // Asked for again, it opens.
    a.s.open('c1', 'shop')
    expect(shared.sent.at(-1)).toMatchObject({ type: 'open' })
    a.s.dispose()
    // An attach the link dropped before its answer: the same attach again, never a new shell.
    const b = session()
    b.s.open('c1', 'shop', 'kept')
    state.value = 'connecting'
    await nextTick()
    state.value = 'open'
    await nextTick()
    expect(shared.sent.at(-1)).toEqual({ ch: 'shell', type: 'attach', sessionId: 'kept' })
    b.s.dispose()
    shared.state = { value: 'open' }
  })

  // Review 2026-10-12 (M9): a tab closed (or restarted) while its attach waited left that session held
  // on the server and its id kept, so the same tab opened again took the session just closed.
  it('closes the session it was attaching to when closed meanwhile, and lets its id go', () => {
    const a = session()
    a.s.open('c1', 'shop', 'kept')
    a.s.close()
    expect(shared.sent.at(-1)).toEqual({ ch: 'shell', type: 'close', sessionId: 'kept' })
    expect(a.seen.ids).toEqual([null])
    // Its late answer is no longer this session's.
    shared.emit({ ch: 'shell', type: 'opened', payload: { sessionId: 'kept', prompt: '>' } })
    expect(a.seen.opened).toEqual([])
    a.s.dispose()
  })

  // Review 2026-10-12 (M8, I5): an attach refused for access is closed, never replaced; a session
  // taken over by another browser tab is said as such.
  it('replaces only a session the server no longer has, and says when another tab took it', () => {
    const a = session()
    a.s.open('c1', 'shop', 'kept')
    const before = shared.sent.length
    shared.emit({ ch: 'shell', type: 'closed', payload: { sessionId: 'kept', reason: 'access' } })
    expect(a.seen.closed).toEqual(['access'])
    expect(shared.sent.slice(before)).toEqual([])
    a.s.dispose()
    const b = session()
    b.s.open('c1', 'shop')
    shared.emit({ ch: 'shell', type: 'opened', payload: { sessionId: 'b1', prompt: '>', ref: refOf(-1) } })
    shared.emit({ ch: 'shell', type: 'closed', payload: { sessionId: 'b1', reason: 'moved' } })
    expect(b.seen.closed).toEqual(['moved'])
    expect(b.seen.ids).toEqual(['b1', null])
    b.s.dispose()
  })
})
