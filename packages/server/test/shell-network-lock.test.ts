import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Security audit 2026-10-16 (Important 4): the worker's network lock left ways to open sockets that
 * do not go through net.connect — a UDP socket made with dgram's constructor (with its own lookup), a
 * listening server (net, http, https, tls, http2 all listen through net.Server), and the underscored
 * helpers that make server and UDP handles directly. The lock is run in a separate Node process, as
 * the worker runs it (it changes the process's own modules for good), and every path is tried there.
 */
const here = dirname(fileURLToPath(import.meta.url))
const NETWORK = pathToFileURL(join(here, '..', 'src', 'shell', 'worker', 'network.ts')).href

const PROBE = `
import net from 'node:net'
import tls from 'node:tls'
import dgram from 'node:dgram'
import http from 'node:http'
import https from 'node:https'
import http2 from 'node:http2'
import { lockNetwork } from '${NETWORK}'

// The real prototypes and constructor, kept as code that ran before the lock could have kept them.
const DgramSocket = dgram.Socket
const results = {}
const attempt = (name, run) => {
  try {
    const opened = run()
    results[name] = 'allowed'
    try { opened?.close?.() } catch {}
  } catch (e) {
    results[name] = e && e.code === 'ERR_MM_SHELL_NETWORK' ? 'refused' : 'error: ' + (e && e.message)
  }
}
lockNetwork(1, 'a'.repeat(64))
attempt('dgram.Socket constructor with its own lookup', () => {
  const s = new dgram.Socket({ type: 'udp4', lookup: (h, o, cb) => cb(null, '127.0.0.1', 4) })
  s.bind(0, '127.0.0.1')
  return s
})
attempt('a dgram socket made before the lock binds', () => {
  const s = new DgramSocket({ type: 'udp4' })
  s.bind(0, '127.0.0.1')
  return s
})
attempt('a dgram socket made before the lock sends', () => {
  const s = new DgramSocket({ type: 'udp4' })
  s.send(Buffer.from('x'), 9, '127.0.0.1')
  return s
})
attempt('a dgram socket made before the lock connects', () => {
  const s = new DgramSocket({ type: 'udp4' })
  s.connect(9, '127.0.0.1')
  return s
})
attempt('dgram._createSocketHandle', () => dgram._createSocketHandle('127.0.0.1', 0, 'udp4', 0))
attempt('net.createServer', () => net.createServer())
attempt('new net.Server().listen', () => new net.Server().listen(0))
attempt('net.Server _listen2', () => new net.Server()._listen2('127.0.0.1', 0, 4, 511))
attempt('net._createServerHandle', () => net._createServerHandle('127.0.0.1', 0, 4))
attempt('http.createServer', () => http.createServer())
attempt('new http.Server().listen', () => new http.Server().listen(0))
attempt('https.createServer', () => https.createServer())
attempt('tls.createServer', () => tls.createServer())
attempt('http2.createServer', () => http2.createServer())
attempt('http2.createSecureServer', () => http2.createSecureServer())
attempt('net.connect to a named pipe', () => net.connect({ path: '/tmp/x.sock' }))
attempt('dgram.createSocket', () => dgram.createSocket('udp4'))
process.stdout.write(JSON.stringify(results))
process.exit(0)
`

let dir = ''
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'mm-netlock-'))
  writeFileSync(join(dir, 'probe.mjs'), PROBE)
})
afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

describe('the worker network lock (security audit 2026-10-16, Important 4)', () => {
  it('refuses every other way to open a socket or listen', () => {
    const out = execFileSync(process.execPath, ['--no-warnings', join(dir, 'probe.mjs')], {
      encoding: 'utf8',
      timeout: 30_000,
    })
    const results = JSON.parse(out) as Record<string, string>
    expect(Object.keys(results).length).toBeGreaterThanOrEqual(17)
    for (const [name, outcome] of Object.entries(results)) expect(outcome, name).toBe('refused')
  })
})
