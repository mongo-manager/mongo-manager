// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { agentSystemPrompt, chatSystemPrompt } from '../src/ai/prompts'

/**
 * User report 2026-10-24: "Sales Mongo bağlantısına yeni bir collection ekle adı users olsun ve bir demo
 * kullanıcısı ekle". The general chat said the connection was not found (it was named nowhere: no
 * collection yet) and cannot change anything anyway; the agent, on a server with no database, asked
 * which database instead of proposing one.
 */
describe('what the assistant is told of connections and databases', () => {
  it('tells the general chat the connections are named apart, and that changes are the agent’s', () => {
    const p = chatSystemPrompt('tr')
    expect(p).toContain('"connections"')
    expect(p).toMatch(/never say .*not found/i)
    expect(p).toMatch(/agent mode/i)
  })

  // Second review (M-2): collections are listed for the connections used last only.
  it('says collections are listed for the connections used last only', () => {
    expect(chatSystemPrompt('tr')).toMatch(/used most recently/i)
    // Third review (M-3): it cannot tell which were listed, so it never concludes a server is empty.
    expect(chatSystemPrompt('tr')).toMatch(/never conclude .*empty/i)
    // Fifth review (M5): a turn about a collection names the connections in their own block.
    expect(chatSystemPrompt('tr')).toMatch(/<connections>/)
    // Sixth review (nit 5): the collection's own connection may be missing from that list.
    expect(chatSystemPrompt('tr')).toMatch(/own connection .* missing/i)
  })

  // Review of fa862922 (minor 4): index suggestions and validators are blocks the chat applies.
  it('keeps index suggestions and validators as blocks, applied with their buttons', () => {
    expect(chatSystemPrompt('tr')).toMatch(/index suggestions and validators/i)
  })

  // Minor 5: the agent's fallback is in agent mode already — the model in use cannot call tools.
  it("tells the agent's fallback that the model cannot call tools, not to turn agent mode on", () => {
    expect(chatSystemPrompt('tr', true)).toMatch(/cannot call tools/i)
    expect(chatSystemPrompt('tr')).not.toMatch(/cannot call tools/i)
  })

  // Minor 6: only a change asks for a database to make; a list that failed is not an empty server.
  it('proposes a database only for a change, and never for a list that failed', () => {
    const p = agentSystemPrompt('tr')
    expect(p).toMatch(/to create or insert/i)
    expect(p).toMatch(/failed .* not an empty server/i)
  })

  it('tells the agent to use the one database, and to propose one where there is none', () => {
    const p = agentSystemPrompt('tr')
    expect(p).toMatch(/exactly one database/i)
    expect(p).toMatch(/no database/i)
    expect(p).toMatch(/propose/i)
    // Never silently: the card shows it, the person confirms or names another.
    expect(p).toMatch(/never pick a database silently/i)
  })
})

// User report 2026-10-30: "add a user" to the users collection became a MongoDB account, tried three
// ways at once and refused each time.
describe('what the agent is told of users and refusals', () => {
  it('reads a user to add as a document of the person’s data, unless they name MongoDB’s', () => {
    const p = agentSystemPrompt('tr')
    expect(p).toMatch(/“user”[^.]*is a document of their data/)
    expect(p).toMatch(/unless they say a MongoDB, database or login user/)
    expect(p).toMatch(/ask which one they mean/)
    expect(p).toMatch(/Never create a MongoDB user for a document/)
  })

  it('stops at a refusal for the rest of the turn, and never proposes a change with its reads', () => {
    const p = agentSystemPrompt('en')
    expect(p).toMatch(/holds for the rest of this turn/)
    expect(p).toMatch(/do not try other tools for the same purpose/)
    expect(p).toMatch(/Never propose a change in the same round as the reads it depends on/)
  })
})
