// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { AiAgentStep } from '@mongo-manager/shared'
import AgentSteps from '../src/ai/chat/AgentSteps.vue'
import { mockApi, mountApp } from './support/app'

/**
 * Design 2026-10-25 (B5): a page of what happened (the AI history) reads nothing — a step there offers
 * no documents, whatever it carries; a live step that was refused or failed offers none either.
 */
const FIND: AiAgentStep = {
  id: '1.1',
  tool: 'find_documents',
  kind: 'read',
  place: { connectionId: 'c1', connection: 'Sales Mongo', db: 'sales', coll: 'orders' },
  state: 'done',
  sent: 'counts',
  summary: { returned: 2, more: false },
  results: { kind: 'find', filter: {}, limit: 5 },
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('a read step’s documents', () => {
  it('are offered live, never on a record, nor for a step that did not end well', async () => {
    setActivePinia(createPinia())
    const api = mockApi({ 'GET connections': () => [200, []] })
    const at = (props: Record<string, unknown>) =>
      mountApp(AgentSteps, { props: { live: true, connectionName: () => 'Sales Mongo', ...props } })
    at({ steps: [FIND] })
    await flushPromises()
    expect(document.querySelectorAll('[data-agent-results]')).toHaveLength(1)
    document.body.innerHTML = ''
    at({ steps: [FIND], record: true, listed: () => true })
    await flushPromises()
    expect(document.querySelector('[data-agent-results]')).toBeNull()
    document.body.innerHTML = ''
    at({ steps: [{ ...FIND, state: 'error', reason: 'mongo_timeout' }] })
    await flushPromises()
    expect(document.querySelector('[data-agent-results]')).toBeNull()
    // Nothing was read for any of them.
    expect(api.calls.filter((c) => c.path.endsWith('/find'))).toEqual([])
  })
})

// User report 2026-10-30: three tools refused for one reason on one connection read as three failures.
describe('steps refused for one reason on one connection', () => {
  const refused = (id: string, tool: string, reason = 'users_restricted'): AiAgentStep => ({
    id,
    tool: tool as AiAgentStep['tool'],
    kind: tool === 'create_user' ? 'write' : 'read',
    place: { connectionId: 'c1', connection: 'Sales Mongo', db: 'sales' },
    state: 'refused',
    reason,
  })

  it('read as one, naming each tool, with the reason once', async () => {
    setActivePinia(createPinia())
    mockApi({ 'GET connections': () => [200, []] })
    mountApp(AgentSteps, {
      props: {
        live: true,
        connectionName: () => 'Sales Mongo',
        steps: [
          refused('1.1', 'list_roles'),
          refused('1.2', 'list_users'),
          refused('1.3', 'create_user'),
          refused('2.1', 'list_users', 'forbidden'),
          { ...FIND, id: '2.2' },
        ],
      },
    })
    await flushPromises()
    const rows = [...document.querySelectorAll('[data-agent-steps] > li')]
    expect(rows).toHaveLength(3)
    expect(rows[0]!.textContent).toContain('List custom roles, List MongoDB users, Create a MongoDB user')
    expect(rows[0]!.textContent!.split('MongoDB’s users are not managed').length - 1).toBe(1)
    expect(rows[1]!.textContent).not.toContain('Create a MongoDB user')
  })
})
