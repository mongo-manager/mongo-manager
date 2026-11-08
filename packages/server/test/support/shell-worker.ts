// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { spawn } from 'node:child_process'
import net from 'node:net'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { workerArgs, workerCommandArgs, workerEnv, supportsNetPermission } from '../../src/shell/spawn'
import { PipeWorker } from '../../src/shell/channel'
import type { ShellToWorker, WorkerToShell } from '../../src/shell/ipc'

const here = dirname(fileURLToPath(import.meta.url))
export const WORKER_BUNDLE = join(here, '..', '..', 'dist', 'shell-worker.cjs')

/**
 * A pass-through proxy for the shell tests: it reads the worker's preamble (32-byte token, then a
 * length-prefixed "host:port") and relays to that target with no auth. A real mongod behind it lets
 * the worker connect exactly as it would through the real proxy, without the auth machinery.
 */
export function passThroughProxy(
  expectedToken: string,
): Promise<{ port: number; close: () => void; connections: number }> {
  const state = { connections: 0 }
  const server = net.createServer((down) => {
    state.connections++
    let header: Buffer = Buffer.alloc(0)
    down.on('data', function onData(chunk: Buffer) {
      header = Buffer.concat([header, chunk])
      if (header.length < 34) return
      const token = header.subarray(0, 32).toString('hex')
      const len = header.readUInt16BE(32)
      if (header.length < 34 + len) return
      // Stop reading and pause: any further bytes (the driver's hello) are buffered by the socket
      // until the upstream connection is ready, so nothing is dropped between here and pipe().
      down.off('data', onData)
      down.pause()
      if (token !== expectedToken) return void down.destroy()
      const target = header.subarray(34, 34 + len).toString('utf8')
      const rest = header.subarray(34 + len)
      const [host, portStr] = target.split(':')
      const up = net.connect(Number(portStr), host, () => {
        if (rest.length) up.write(rest)
        down.pipe(up)
        up.pipe(down)
      })
      up.on('error', () => down.destroy())
      down.on('error', () => up.destroy())
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port
      resolve({
        port,
        close: () => server.close(),
        get connections() {
          return state.connections
        },
      })
    })
  })
}

export interface TestWorker {
  send: (m: ShellToWorker) => void
  next: (type: WorkerToShell['type'], timeoutMs?: number) => Promise<WorkerToShell>
  evaluate: (
    code: string,
  ) => Promise<{ ok: true; value: unknown; resultType: string | null } | { ok: false; message: string }>
  /** The worker with its message channel: 'message' for each message it sends. */
  child: PipeWorker
  stderr: () => string
  close: () => void
}

/**
 * Fork the built worker with the real sandbox flags. Does not create a proxy or send init; the
 * caller wires those (see startTestWorker for the pass-through case, or drive a real ShellProxy).
 * `env` overrides let tests probe environment scrubbing; `onClose` is run by close().
 */
export function forkShellWorker(options: { env?: NodeJS.ProcessEnv; onClose?: () => void } = {}): TestWorker {
  const execArgv = workerArgs(WORKER_BUNDLE, { netPermission: supportsNetPermission() })
  const child = new PipeWorker(
    spawn(process.execPath, workerCommandArgs(execArgv, WORKER_BUNDLE, []), {
      env: options.env ?? workerEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    }),
  )
  let stderr = ''
  child.stderr?.on('data', (b: Buffer) => (stderr += b.toString()))
  const queue: WorkerToShell[] = []
  const waiters: Array<{ types: string[]; resolve: (m: WorkerToShell) => void }> = []
  child.on('message', (raw: WorkerToShell) => {
    const waiter = waiters.findIndex((w) => w.types.includes(raw.type))
    if (waiter >= 0) waiters.splice(waiter, 1)[0]!.resolve(raw)
    else queue.push(raw)
  })

  const nextOneOf = (types: WorkerToShell['type'][], timeoutMs = 15_000): Promise<WorkerToShell> => {
    const found = queue.findIndex((m) => types.includes(m.type))
    if (found >= 0) return Promise.resolve(queue.splice(found, 1)[0]!)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timeout waiting for ${types.join('|')}; stderr: ${stderr.slice(0, 300)}`)),
        timeoutMs,
      )
      waiters.push({ types, resolve: (m) => (clearTimeout(timer), resolve(m)) })
    })
  }
  const next = (type: WorkerToShell['type'], timeoutMs = 15_000): Promise<WorkerToShell> =>
    nextOneOf([type], timeoutMs)

  const worker: TestWorker = {
    send: (m) => child.send(m),
    next,
    child,
    stderr: () => stderr,
    close: () => {
      child.kill()
      options.onClose?.()
    },
    evaluate: async (code) => {
      const id = Math.floor(Math.random() * 1e9) + 1
      child.send({ type: 'eval', id, code })
      const first = await nextOneOf(['result', 'error'])
      // Drain the matching `done`.
      await next('done').catch(() => undefined)
      if (first.type === 'result') return { ok: true, value: first.value, resultType: first.resultType }
      return { ok: false, message: (first as { message: string }).message }
    },
  }
  return worker
}

/**
 * Fork the built worker with a pass-through proxy and, unless `init: false`, send init with that
 * proxy's port and token so the caller only awaits `ready`.
 */
export async function startTestWorker(
  options: {
    uri?: string
    db?: string
    syncTimeoutMs?: number
    env?: NodeJS.ProcessEnv
    init?: boolean
  } = {},
): Promise<{ worker: TestWorker; proxy: Awaited<ReturnType<typeof passThroughProxy>>; token: string }> {
  const token = randomBytes(32).toString('hex')
  const proxy = await passThroughProxy(token)
  const worker = forkShellWorker({ env: options.env, onClose: () => proxy.close() })
  if (options.init !== false && options.uri) {
    worker.send({
      type: 'init',
      proxyPort: proxy.port,
      token,
      uri: options.uri,
      db: options.db ?? 'test',
      appName: 'mm-shell:test',
      syncTimeoutMs: options.syncTimeoutMs ?? 5_000,
    })
  }
  return { worker, proxy, token }
}
