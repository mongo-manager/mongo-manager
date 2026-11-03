import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { ByteBudget, LineSplitter, PipeWorker, encodeLine, jsonDepthWithin } from '../src/shell/channel'
import { MAX_IPC_MESSAGE_BYTES } from '../src/shell/ipc'
import { slow } from './support/slowness'

/**
 * Security audit 2026-10-16 (minor): Node's IPC channel parsed whatever the worker wrote, however
 * large, before the parent could look at its size. The worker now talks over plain pipes, a JSON
 * message a line, and a line is refused the moment it passes the cap — before it is parsed, and
 * without holding more than the cap in memory.
 */
describe('LineSplitter', () => {
  it('hands over each line, across chunks and several in one chunk', () => {
    const lines: string[] = []
    const s = new LineSplitter(
      100,
      (l) => lines.push(l),
      () => lines.push('OVERSIZE'),
    )
    s.push(Buffer.from('{"a"'))
    s.push(Buffer.from(':1}\n{"b":2}\n{"c"'))
    s.push(Buffer.from(':3}\n'))
    expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}'])
  })

  it('keeps multi-byte characters cut between chunks whole', () => {
    const lines: string[] = []
    const s = new LineSplitter(
      100,
      (l) => lines.push(l),
      () => undefined,
    )
    const bytes = Buffer.from('"ğüş"\n')
    s.push(bytes.subarray(0, 2))
    s.push(bytes.subarray(2))
    expect(lines).toEqual(['"ğüş"'])
  })

  it('refuses a line the moment it passes the cap, before its end, and reads nothing after', () => {
    const lines: string[] = []
    const oversize = vi.fn()
    const s = new LineSplitter(1000, (l) => lines.push(l), oversize)
    s.push(Buffer.from('{"ok":1}\n'))
    s.push(Buffer.alloc(600, 0x61))
    expect(oversize).not.toHaveBeenCalled()
    s.push(Buffer.alloc(600, 0x61))
    expect(oversize).toHaveBeenCalledTimes(1)
    s.push(Buffer.from('\n{"late":1}\n'))
    expect(lines).toEqual(['{"ok":1}'])
    expect(oversize).toHaveBeenCalledTimes(1)
  })

  it('refuses a line over the cap that comes in one chunk with its end', () => {
    const lines: string[] = []
    const oversize = vi.fn()
    const s = new LineSplitter(10, (l) => lines.push(l), oversize)
    s.push(Buffer.from('12345678901\n'))
    expect(lines).toEqual([])
    expect(oversize).toHaveBeenCalledTimes(1)
  })
})

/** A child process with pipes, as spawn gives it. */
function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough
    stdout: PassThrough
    stderr: PassThrough
    pid: number
    kill: (signal?: string) => boolean
  }
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.pid = 4321
  child.kill = vi.fn(() => true)
  return child
}

const tick = () => new Promise((r) => setImmediate(r))

describe('PipeWorker', () => {
  it('sends each message as one marked JSON line and emits each parsed line', async () => {
    const child = fakeChild()
    const worker = new PipeWorker(child as unknown as ChildProcess)
    const written: string[] = []
    child.stdin.on('data', (b: Buffer) => written.push(b.toString()))
    const got: unknown[] = []
    worker.on('message', (m) => got.push(m))
    worker.send({ type: 'eval', id: 1, code: 'a\nb' })
    child.stdout.write(encodeLine({ type: 'pong', rss: 1, heapUsed: 1 }))
    await tick()
    expect(written.join('')).toBe(encodeLine({ type: 'eval', id: 1, code: 'a\nb' }))
    expect(written.join('')).toBe('\u001e{"type":"eval","id":1,"code":"a\\nb"}\n')
    expect(got).toEqual([{ type: 'pong', rss: 1, heapUsed: 1 }])
    expect(worker.pid).toBe(4321)
  })

  it('reports a message past the cap as a violation without parsing it', async () => {
    const child = fakeChild()
    const worker = new PipeWorker(child as unknown as ChildProcess)
    const violation = vi.fn()
    const message = vi.fn()
    worker.on('violation', violation)
    worker.on('message', message)
    const parse = vi.spyOn(JSON, 'parse')
    try {
      // 64 KiB pieces of one line that never ends, well past the 1 MiB cap.
      const piece = Buffer.alloc(64 * 1024, 0x61)
      child.stdout.write('\u001e')
      for (let sent = 0; sent < 3 * MAX_IPC_MESSAGE_BYTES; sent += piece.length) child.stdout.write(piece)
      await tick()
      expect(violation).toHaveBeenCalledTimes(1)
      expect(message).not.toHaveBeenCalled()
      expect(parse).not.toHaveBeenCalled()
    } finally {
      parse.mockRestore()
    }
  })

  it('reports a marked line that is not JSON as a violation', async () => {
    const child = fakeChild()
    const worker = new PipeWorker(child as unknown as ChildProcess)
    const violation = vi.fn()
    worker.on('violation', violation)
    child.stdout.write('\u001enot json\n')
    await tick()
    expect(violation).toHaveBeenCalledTimes(1)
  })

  // Review 2026-10-16 (minor): a library writing to stdout corrupted the protocol. Only lines with
  // the protocol's mark are messages; anything else is noise, set aside and never parsed.
  it('sets aside a line without the protocol mark, a library’s console.log, without a violation', async () => {
    const child = fakeChild()
    const worker = new PipeWorker(child as unknown as ChildProcess)
    const violation = vi.fn()
    const noise = vi.fn()
    const got: unknown[] = []
    worker.on('violation', violation)
    worker.on('noise', noise)
    worker.on('message', (m) => got.push(m))
    child.stdout.write('{ a: 1 }\nsome library said this\n')
    child.stdout.write(encodeLine({ type: 'pong', rss: 1, heapUsed: 1 }))
    await tick()
    expect(violation).not.toHaveBeenCalled()
    expect(noise).toHaveBeenCalledTimes(2)
    expect(got).toEqual([{ type: 'pong', rss: 1, heapUsed: 1 }])
  })

  // Security review 2026-10-16 (I-6): a line under 1 MiB nested 400 000 deep parsed fine, then threw
  // out of JSON.stringify in the server's data handler — uncaught, the server went down.
  it('refuses a message nested deeper than a document can be, before parsing it', async () => {
    const child = fakeChild()
    const worker = new PipeWorker(child as unknown as ChildProcess)
    const violation = vi.fn()
    const message = vi.fn()
    worker.on('violation', violation)
    worker.on('message', message)
    const deep = `${'['.repeat(20_000)}${']'.repeat(20_000)}`
    child.stdout.write(`\u001e{"type":"result","id":1,"resultType":null,"value":${deep}}\n`)
    await tick()
    expect(violation).toHaveBeenCalledTimes(1)
    expect(message).not.toHaveBeenCalled()
  })

  it('reports a violation, never throws, when a listener cannot take a message', async () => {
    const child = fakeChild()
    const worker = new PipeWorker(child as unknown as ChildProcess)
    const violation = vi.fn()
    worker.on('violation', violation)
    worker.on('message', () => {
      throw new RangeError('Maximum call stack size exceeded')
    })
    child.stdout.write(encodeLine({ type: 'pong', rss: 1, heapUsed: 1 }))
    await tick()
    expect(violation).toHaveBeenCalledTimes(1)
  })

  // Security review 2026-10-16 (I-7): no byte rate: a worker could have the server parse and validate
  // about 1 GiB a second. Past the budget the pipe is not read until the next second: the worker waits.
  it('reads at most its byte budget a second, the rest the next second', async () => {
    const child = fakeChild()
    const worker = new PipeWorker(child as unknown as ChildProcess, { bytesPerSecond: 4096 })
    const got: unknown[] = []
    worker.on('message', (m) => got.push(m))
    const line = encodeLine({ type: 'print', id: 1, text: 'x'.repeat(1000) })
    for (let i = 0; i < 12; i++) child.stdout.write(line)
    await new Promise((r) => setTimeout(r, 100))
    expect(got.length).toBeGreaterThan(0)
    expect(got.length).toBeLessThanOrEqual(5)
    await vi.waitFor(() => expect(got).toHaveLength(12), { timeout: 5000 })
  })

  // Second review 2026-10-16 (minor): a stray write with no line end ran into the next message, which
  // was then set aside whole. A message starts at its line's last mark (JSON never holds a raw one).
  it('finds a message after a stray write that had no line end', async () => {
    const child = fakeChild()
    const worker = new PipeWorker(child as unknown as ChildProcess)
    const got: unknown[] = []
    const noise = vi.fn()
    worker.on('message', (m) => got.push(m))
    worker.on('noise', noise)
    child.stdout.write('a library wrote this, no line end')
    child.stdout.write(encodeLine({ type: 'pong', rss: 1, heapUsed: 1 }))
    await tick()
    expect(got).toEqual([{ type: 'pong', rss: 1, heapUsed: 1 }])
    expect(noise).toHaveBeenCalledWith('a library wrote this, no line end')
  })

  // Second review 2026-10-16 (minor): the byte budget was per worker; twenty workers made twenty.
  it(
    'shares one byte budget among all workers too',
    async () => {
      const shared = new ByteBudget(4096)
      const workers = [fakeChild(), fakeChild()].map(
        (child) =>
          [child, new PipeWorker(child as unknown as ChildProcess, { bytesPerSecond: 1e9, shared })] as const,
      )
      const got: unknown[] = []
      const line = encodeLine({ type: 'print', id: 1, text: 'x'.repeat(1000) })
      for (const [child, worker] of workers) {
        worker.on('message', (m) => got.push(m))
        for (let i = 0; i < 12; i++) child.stdout.write(line)
      }
      await new Promise((r) => setTimeout(r, 100))
      expect(got.length).toBeGreaterThan(0)
      expect(got.length).toBeLessThanOrEqual(6)
      await vi.waitFor(() => expect(got).toHaveLength(24), { timeout: 10_000 })
    },
    slow(15_000),
  )

  it('survives writing to a worker that is gone, and reports its exit once', async () => {
    const child = fakeChild()
    const worker = new PipeWorker(child as unknown as ChildProcess)
    const exit = vi.fn()
    worker.on('exit', exit)
    child.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
    child.stdout.emit('error', new Error('read ECONNRESET'))
    child.emit('error', new Error('spawn failed'))
    child.emit('exit', null, 'SIGKILL')
    expect(exit).toHaveBeenCalledTimes(1)
    child.stdin.destroy()
    expect(worker.send({ type: 'ping' })).toBe(false)
  })
})

describe('jsonDepthWithin', () => {
  it('measures nesting outside strings only', () => {
    expect(jsonDepthWithin('{"a":[1,{"b":2}]}', 3)).toBe(true)
    expect(jsonDepthWithin('{"a":[1,{"b":2}]}', 2)).toBe(false)
    expect(jsonDepthWithin('{"a":"[[[[[[\\"[[[["}', 1)).toBe(true)
    expect(jsonDepthWithin('[[[[[]]]]]', 4)).toBe(false)
  })
})
