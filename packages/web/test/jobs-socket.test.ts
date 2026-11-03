import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { JobView } from '@mongo-manager/shared'
import { useJobsStore } from '../src/jobs/store'
import { createJobsSocket, type SocketLike } from '../src/jobs/socket'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

export const job = (over: Partial<JobView> = {}): JobView => ({
  id: 'j1',
  kind: 'index.create',
  connectionId: 'c1',
  targetConnectionId: null,
  db: 'shop',
  coll: 'orders',
  target: 'n_1',
  state: 'running',
  progress: null,
  estimate: null,
  error: null,
  startedAt: 1_000,
  finishedAt: null,
  mine: true,
  cancellable: true,
  ...over,
})

class FakeSocket implements SocketLike {
  static all: FakeSocket[] = []
  sent: unknown[] = []
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onclose: ((e: { code: number }) => void) | null = null
  onerror: (() => void) | null = null
  closedWith: number | null = null
  constructor(readonly url: string) {
    FakeSocket.all.push(this)
  }
  send(data: string) {
    this.sent.push(JSON.parse(data))
  }
  close(code = 1000) {
    this.closedWith = code
  }
  // Test controls
  open() {
    this.onopen?.()
  }
  receive(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) })
  }
  drop(code = 1006) {
    this.onclose?.({ code })
  }
}

function setup() {
  FakeSocket.all = []
  const store = useJobsStore()
  const list = vi.fn(async () => ({ jobs: [] as JobView[] }))
  // What REST says about the session when the socket was refused (C1: a restart is not a sign-out).
  const checkSession = vi.fn(async (): Promise<'ok' | 'gone' | 'unknown'> => 'ok')
  const socket = createJobsSocket({
    store,
    open: (url) => new FakeSocket(url),
    url: () => 'ws://localhost:4321/ws',
    csrf: () => 'token',
    list,
    checkSession,
  })
  const last = () => FakeSocket.all.at(-1)!
  /** Opens the newest socket and completes the handshake. */
  const ready = () => {
    last().open()
    last().receive({ type: 'ready' })
  }
  return { store, list, checkSession, socket, last, ready }
}

describe('the jobs socket (phase 1h spec §6)', () => {
  it('says hello with the CSRF token, subscribes, and fills the store from snapshot, update and gone', () => {
    const { store, socket, last, ready } = setup()
    socket.start()
    expect(socket.state.value).toBe('connecting')
    last().open()
    expect(last().sent).toEqual([{ type: 'hello', csrf: 'token' }])
    ready()
    expect(socket.state.value).toBe('open')
    expect(last().sent.at(-1)).toEqual({ ch: 'jobs', type: 'sub' })
    last().receive({ ch: 'jobs', type: 'snapshot', payload: { jobs: [job(), job({ id: 'j2' })] } })
    expect(store.list.map((j) => j.id).sort()).toEqual(['j1', 'j2'])
    last().receive({
      ch: 'jobs',
      type: 'update',
      payload: { job: job({ progress: { done: 5, total: 10 } }) },
    })
    expect(store.byId.j1!.progress).toEqual({ done: 5, total: 10 })
    last().receive({ ch: 'jobs', type: 'gone', payload: { id: 'j2' } })
    expect(Object.keys(store.byId)).toEqual(['j1'])
    // Minor 9: each message carries the server's clock.
    last().receive({ ch: 'jobs', type: 'update', payload: { job: job(), now: Date.now() + 60_000 } })
    expect(store.clockOffset).toBe(60_000)
  })

  it('reconnects with a growing delay, and a job that ended meanwhile shows as ended (Review Focus 2)', () => {
    const { store, socket, last, ready } = setup()
    const finished: JobView[] = []
    store.onFinished((j) => finished.push(j))
    socket.start()
    ready()
    last().receive({ ch: 'jobs', type: 'snapshot', payload: { jobs: [job()] } })
    last().drop()
    const count = () => FakeSocket.all.length
    vi.advanceTimersByTime(999)
    expect(count()).toBe(1)
    vi.advanceTimersByTime(1)
    expect(count()).toBe(2)
    last().drop()
    vi.advanceTimersByTime(2_000)
    expect(count()).toBe(3)
    ready()
    last().receive({
      ch: 'jobs',
      type: 'snapshot',
      payload: { jobs: [job({ state: 'done', finishedAt: 9 })] },
    })
    expect(store.byId.j1!.state).toBe('done')
    expect(finished.map((j) => j.state)).toEqual(['done'])
    // A successful open resets the delay.
    last().drop()
    vi.advanceTimersByTime(1_000)
    expect(count()).toBe(4)
  })

  it('caps the delay at 30 seconds', () => {
    const { socket, last } = setup()
    socket.start()
    for (let i = 0; i < 8; i++) {
      last().drop()
      vi.advanceTimersByTime(30_000)
    }
    const before = FakeSocket.all.length
    last().drop()
    vi.advanceTimersByTime(29_999)
    expect(FakeSocket.all.length).toBe(before)
    vi.advanceTimersByTime(1)
    expect(FakeSocket.all.length).toBe(before + 1)
  })

  it('polls while a job runs after three failed opens, and stops when a socket works again (Review Focus 5)', async () => {
    const { store, list, socket, last, ready } = setup()
    socket.start()
    for (let i = 0; i < 3; i++) {
      last().drop()
      vi.advanceTimersByTime(30_000)
    }
    expect(socket.state.value).toBe('polling')
    // Entering polling fetches once, so the tray is not empty.
    expect(list).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(list).toHaveBeenCalledTimes(1)
    store.upsert(job())
    list.mockResolvedValue({ jobs: [job({ state: 'done' })] })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(list).toHaveBeenCalledTimes(2)
    expect(store.byId.j1!.state).toBe('done')
    await vi.advanceTimersByTimeAsync(20_000)
    expect(list).toHaveBeenCalledTimes(2)
    store.upsert(job({ id: 'j3' }))
    await vi.advanceTimersByTimeAsync(30_000)
    const calls = list.mock.calls.length
    ready()
    expect(socket.state.value).toBe('open')
    await vi.advanceTimersByTimeAsync(20_000)
    expect(list.mock.calls.length).toBe(calls)
  })

  it('reconnects after other closes, and stops only when REST confirms the session ended', async () => {
    const { socket, last, ready, checkSession } = setup()
    socket.start()
    ready()
    last().drop(4429)
    vi.advanceTimersByTime(1_000)
    expect(FakeSocket.all).toHaveLength(2)
    expect(checkSession).not.toHaveBeenCalled()
    ready()
    checkSession.mockResolvedValueOnce('gone')
    last().drop(4401)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(FakeSocket.all).toHaveLength(2)
    expect(checkSession).toHaveBeenCalledOnce()
    expect(socket.state.value).toBe('closed')
  })

  it('treats a refused hello after a server restart as a stale token, not a sign-out (final review C1)', async () => {
    const { socket, last, ready, checkSession } = setup()
    socket.start()
    ready()
    // The server restarted: the old socket drops, the new one's hello carries a token it no longer knows.
    last().drop(1006)
    await vi.advanceTimersByTimeAsync(1_000)
    last().open()
    last().drop(4403)
    // The page asks REST (which refreshes the token) and reconnects instead of signing out.
    await vi.advanceTimersByTimeAsync(0)
    expect(checkSession).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(FakeSocket.all).toHaveLength(3)
    ready()
    expect(socket.state.value).toBe('open')
    // A 4401 whose session REST still accepts (or cannot reach) also just reconnects.
    checkSession.mockResolvedValueOnce('unknown')
    last().drop(4401)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(FakeSocket.all).toHaveLength(4)
    expect(socket.state.value).not.toBe('closed')
  })

  it('carries other channels: subscribes when ready, again after a reconnect, and unsubscribes (phase 1i)', () => {
    const { socket, last, ready } = setup()
    const got: unknown[] = []
    socket.start()
    const off = socket.watch(
      'monitor:c1',
      { ch: 'monitor', type: 'sub', connectionId: 'c1' },
      { ch: 'monitor', type: 'unsub', connectionId: 'c1' },
      (m) => (m.payload as { connectionId?: string }).connectionId === 'c1',
      (m) => got.push(m),
    )
    ready()
    expect(last().sent).toContainEqual({ ch: 'monitor', type: 'sub', connectionId: 'c1' })
    last().receive({ ch: 'monitor', type: 'sample', payload: { connectionId: 'c1', t: 1 } })
    last().receive({ ch: 'monitor', type: 'sample', payload: { connectionId: 'c2', t: 1 } })
    expect(got).toEqual([{ ch: 'monitor', type: 'sample', payload: { connectionId: 'c1', t: 1 } }])
    last().drop()
    vi.advanceTimersByTime(1_000)
    ready()
    expect(last().sent).toContainEqual({ ch: 'monitor', type: 'sub', connectionId: 'c1' })
    off()
    expect(last().sent.at(-1)).toEqual({ ch: 'monitor', type: 'unsub', connectionId: 'c1' })
    last().receive({ ch: 'monitor', type: 'sample', payload: { connectionId: 'c1', t: 2 } })
    expect(got).toHaveLength(1)
  })

  it('stop() closes the socket and leaves no timer behind', () => {
    const { socket, last, ready } = setup()
    socket.start()
    ready()
    socket.stop()
    expect(last().closedWith).toBe(1000)
    vi.advanceTimersByTime(60_000)
    expect(FakeSocket.all).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('ignores messages it cannot read', () => {
    const { store, socket, last, ready } = setup()
    socket.start()
    ready()
    last().onmessage?.({ data: '{nope' })
    last().receive({ ch: 'jobs', type: 'update', payload: {} })
    expect(store.list).toEqual([])
    expect(socket.state.value).toBe('open')
  })
})
