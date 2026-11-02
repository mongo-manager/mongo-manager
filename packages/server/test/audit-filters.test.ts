import { afterEach, describe, expect, it } from 'vitest'
import type { AuditAction } from '@mongo-manager/shared'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore } from '../src/store/db'
import { H, makeApp, type TestApp } from './helpers'

const apps: TestApp[] = []
afterEach(async () => {
  for (const t of apps.splice(0)) await t.close()
})

describe('audit log filters (audit minor: connection and date range)', () => {
  it('filters by connection and by a time range, and refuses a reversed range', async () => {
    const t = await makeApp()
    apps.push(t)
    const at = (iso: string) => (t.clock.now = Date.parse(iso))
    const add = (connectionId: string | null) =>
      t.app.ctx.audit.append({
        userId: null,
        username: 'owner',
        ip: '127.0.0.1',
        action: 'x.test' as AuditAction,
        connectionId,
        namespace: null,
        outcome: 'success',
        details: {},
      })
    at('2026-01-01T00:00:00Z')
    add('c1')
    at('2026-02-01T00:00:00Z')
    add('c2')
    at('2026-03-01T00:00:00Z')
    add('c1')
    const get = async (query: string) =>
      t.app.inject({
        method: 'GET',
        url: `/api/audit?${query}`,
        headers: { ...H, 'x-csrf-token': t.app.ctx.localCsrfToken },
      })
    const byConnection = (await get('connectionId=c1')).json() as Array<{ connectionId: string }>
    expect(byConnection.map((e) => e.connectionId)).toEqual(['c1', 'c1'])
    const range = (
      await get(
        `from=${encodeURIComponent('2026-01-15T00:00:00Z')}&to=${encodeURIComponent('2026-02-15T00:00:00Z')}`,
      )
    ).json() as Array<{ connectionId: string }>
    expect(range.map((e) => e.connectionId)).toEqual(['c2'])
    expect((await get('from=2026-03-01T00:00:00Z&to=2026-01-01T00:00:00Z')).statusCode).toBe(400)
    expect((await get('from=yesterday')).statusCode).toBe(400)
  })
})

describe('audit log indexes (final review 1g-3, Minor 7)', () => {
  it('filters by connection through an index, newest first, without scanning the whole log', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mm-audit-'))
    const store = await openStore(dir)
    try {
      const plan = store.db
        .prepare(
          'EXPLAIN QUERY PLAN SELECT * FROM audit_log WHERE connection_id = ? ORDER BY id DESC LIMIT ?',
        )
        .all('c1', 100) as Array<{ detail: string }>
      const details = plan.map((p) => p.detail).join(' | ')
      expect(details).toMatch(/USING (COVERING )?INDEX audit_log_connection/)
      expect(details).not.toMatch(/TEMP B-TREE/)
      // Review of B6 (M3): one assistant turn's rows, never by reading the whole log.
      const turn = store.db
        .prepare(
          "EXPLAIN QUERY PLAN SELECT * FROM audit_log WHERE (json_extract(details, '$.agent.run') = ? OR (action LIKE 'ai.%' AND json_extract(details, '$.run') = ?)) ORDER BY id DESC LIMIT ?",
        )
        .all('r1', 'r1', 100) as Array<{ detail: string }>
      const turnPlan = turn.map((p) => p.detail).join(' | ')
      expect(turnPlan).toMatch(/INDEX audit_log_agent_run\b/)
      expect(turnPlan).toMatch(/INDEX audit_log_ai_run\b/)
      expect(turnPlan).not.toMatch(/^SCAN audit_log$|SCAN audit_log(?! USING)/)
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
