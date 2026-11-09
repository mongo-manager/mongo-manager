// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { ScramConversation, forgetScram, scramDerivations } from '../src/shell/proxy/scram'

const NONCE = Buffer.from('clientnonce0000000000000')
const CN = NONCE.toString('base64')

describe('SCRAM client messages (phase 3a-1 §5.2)', () => {
  it('builds a GS2 client-first with the escaped user and the client nonce', () => {
    const c = new ScramConversation('SCRAM-SHA-256', 'a,b=c', 'pw', Buffer.from('nonce-bytes-000000000000'))
    const first = c.start().toString('utf8')
    expect(first).toBe('n,,n=a=2Cb=3Dc,r=' + Buffer.from('nonce-bytes-000000000000').toString('base64'))
  })

  it('rejects a server-first whose nonce does not extend the client nonce', async () => {
    const c = new ScramConversation('SCRAM-SHA-256', 'user', 'pw', NONCE)
    c.start()
    await expect(c.clientFinal(Buffer.from('r=somethingelse,s=c2FsdA==,i=4096'))).rejects.toThrow(
      /nonce mismatch/,
    )
  })

  it('produces a client-final proof and rejects a wrong server signature', async () => {
    const c = new ScramConversation('SCRAM-SHA-256', 'user', 'pencil', NONCE)
    c.start()
    const final = (await c.clientFinal(Buffer.from(`r=${CN}server,s=c2FsdHNhbHQ=,i=4096`))).toString('utf8')
    expect(final).toMatch(/^c=biws,r=/)
    expect(final).toMatch(/,p=[A-Za-z0-9+/=]+$/)
    expect(() => c.verifyServerFinal(Buffer.from('v=AAAA'))).toThrow(/server signature mismatch/)
  })

  // Security review 2026-10-16 (I-4): each kill (and each worker connection) ran PBKDF2 on the main
  // thread; a salted password is kept per connection, salt and iteration count, as drivers do.
  it('derives a salted password once per connection, salt and iteration count', async () => {
    const before = scramDerivations()
    const finals: string[] = []
    for (let i = 0; i < 5; i++) {
      const c = new ScramConversation('SCRAM-SHA-256', 'cache-user', 'pw-cache', NONCE, 'conn-a')
      c.start()
      finals.push((await c.clientFinal(Buffer.from(`r=${CN}srv,s=Y2FjaGVzYWx0,i=15000`))).toString('utf8'))
    }
    expect(scramDerivations() - before).toBe(1)
    // The same proof each time: the cache changes nothing but the cost.
    expect(new Set(finals).size).toBe(1)
    const other = new ScramConversation('SCRAM-SHA-256', 'cache-user', 'another-pw', NONCE, 'conn-a')
    other.start()
    await other.clientFinal(Buffer.from(`r=${CN}srv,s=Y2FjaGVzYWx0,i=15000`))
    expect(scramDerivations() - before).toBe(2)
  })

  // Second review 2026-10-16 (minor): one cache for every connection let a server that replays a
  // salt learn, by timing, whether another connection uses the same password; entries outlived the
  // connection and its password.
  it('keeps each connection’s salted passwords apart, and forgets them with the connection', async () => {
    const before = scramDerivations()
    const derive = async (scope: string) => {
      const c = new ScramConversation('SCRAM-SHA-256', 'u', 'same-pw', NONCE, scope)
      c.start()
      await c.clientFinal(Buffer.from(`r=${CN}srv,s=c2NvcGVzYWx0,i=15000`))
    }
    await derive('conn-x')
    await derive('conn-y')
    expect(scramDerivations() - before).toBe(2)
    await derive('conn-x')
    expect(scramDerivations() - before).toBe(2)
    forgetScram('conn-x')
    await derive('conn-x')
    expect(scramDerivations() - before).toBe(3)
  })

  // Second review 2026-10-16 (minor): a hostile server could ask for 2 147 483 647 iterations and hold
  // the server's thread for hours. The Node driver refuses fewer than 4096; more than 1 000 000 too.
  it('refuses an iteration count out of bounds, without deriving anything', async () => {
    const before = scramDerivations()
    for (const i of [2147483647, 1_000_001, 4095, 0]) {
      const c = new ScramConversation('SCRAM-SHA-256', 'u', 'pw', NONCE)
      c.start()
      await expect(c.clientFinal(Buffer.from(`r=${CN}srv,s=c2FsdA==,i=${i}`)), String(i)).rejects.toThrow(
        /iteration count/,
      )
    }
    expect(scramDerivations()).toBe(before)
  })

  it('derives off the main thread', async () => {
    const c = new ScramConversation('SCRAM-SHA-256', 'u', 'thread-pw', NONCE, 'conn-thread')
    c.start()
    const order: string[] = []
    const final = c
      .clientFinal(Buffer.from(`r=${CN}srv,s=dGhyZWFkc2FsdA==,i=1000000`))
      .then(() => order.push('derived'))
    setImmediate(() => order.push('event loop turned'))
    await final
    // The event loop turned while the derivation ran: it did not hold the thread.
    expect(order).toEqual(['event loop turned', 'derived'])
  })

  it('surfaces a server error attribute', async () => {
    const c = new ScramConversation('SCRAM-SHA-1', 'user', 'pw', NONCE)
    c.start()
    await c.clientFinal(Buffer.from(`r=${CN}srv,s=c2FsdA==,i=4096`))
    expect(() => c.verifyServerFinal(Buffer.from('e=invalid-proof'))).toThrow(/invalid-proof/)
  })
})
