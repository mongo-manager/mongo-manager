// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { Io } from './io'

const MAX_SECRET = 4096

const SIGNALS = ['SIGTERM', 'SIGHUP'] as const

/**
 * Reads a line from a terminal with echo off. Ctrl+C cancels; end of input rejects. The terminal
 * is put back into normal mode however the prompt ends, including on exit or SIGTERM/SIGHUP.
 */
export function readSecret(io: Io, label: string): Promise<string> {
  const stdin = io.stdin
  if (!stdin.isTTY || !stdin.setRawMode)
    return Promise.reject(new Error('No terminal to read a password from'))
  io.stderr.write(label)
  return new Promise((resolve, reject) => {
    let value = ''
    let done = false
    const restore = () => stdin.setRawMode!(false)
    const onSignal = (signal: NodeJS.Signals) => {
      restore()
      // Re-raise with the default handler so the process still ends as it was asked to.
      for (const s of SIGNALS) process.removeListener(s, onSignal)
      process.kill(process.pid, signal)
    }
    const finish = (error?: Error) => {
      if (done) return
      done = true
      stdin.removeListener('data', onData)
      stdin.removeListener('end', onEnd)
      stdin.removeListener('error', onError)
      process.removeListener('exit', restore)
      for (const s of SIGNALS) process.removeListener(s, onSignal)
      restore()
      stdin.pause()
      io.stderr.write('\n')
      if (error) reject(error)
      else resolve(value)
    }
    const onEnd = () => finish(new Error('No password entered (input ended)'))
    const onError = (e: Error) => finish(e)
    const onData = (chunk: Buffer | string) => {
      for (const ch of chunk.toString('utf8')) {
        if (ch === '\r' || ch === '\n') return finish()
        if (ch === '\u0003') return finish(new Error('Cancelled'))
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1)
        else if (ch >= ' ') value += ch
        if (value.length > MAX_SECRET) return finish(new Error('Password is too long'))
      }
    }
    process.once('exit', restore)
    for (const s of SIGNALS) process.once(s, onSignal)
    stdin.setRawMode!(true)
    stdin.resume()
    stdin.on('data', onData)
    stdin.once('end', onEnd)
    stdin.once('error', onError)
  })
}

/** Reads the whole of stdin (a password piped in); strips one trailing newline. */
export async function readStdinSecret(io: Io): Promise<string> {
  let text = ''
  for await (const chunk of io.stdin) {
    text += chunk.toString()
    if (text.length > MAX_SECRET) throw new Error('Password is too long')
  }
  return text.replace(/\r?\n$/, '')
}
