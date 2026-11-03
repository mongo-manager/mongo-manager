import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { AI_AGENT_READ_TOOLS, AI_AGENT_WRITE_TOOLS, ERROR_CODES } from '@mongo-manager/shared/browser'
import { i18n } from '../src/i18n'
import { connectionReason } from '../src/ai/chat/agentWords'
import en from '../src/i18n/locales/en.json'

/**
 * The AI database manager (design 2026-10-25, B8): every reason a step of the agent can meet has its
 * words — the agent's own refusals, the reasons of the routes it calls (and of what they call) and
 * their error codes — in both languages. The server's sources are read for them, so one added later
 * without words fails here.
 */
const SERVER = join(import.meta.dirname, '..', '..', 'server', 'src')
const ROUTES = [
  'routes/data/aggregate.ts',
  'routes/data/bulk.ts',
  'routes/data/collections.ts',
  'routes/data/database-access.ts',
  'routes/data/databases.ts',
  'routes/data/documents.ts',
  'routes/data/explain.ts',
  'routes/data/index-advice.ts',
  'routes/data/indexes.ts',
  'routes/data/schema.ts',
  'routes/data/server.ts',
  'routes/data/slow-queries.ts',
  'routes/data/params.ts',
  'routes/data/shell-gate.ts',
  'routes/backup-schedules.ts',
  'routes/backup.ts',
  'routes/connections.ts',
  'routes/destinations.ts',
  'routes/jobs.ts',
  'routes/ai-agent.ts',
  'routes/connection-health.ts',
  // Design 2026-10-25 (C1, C3): the export, the copy, validation rules and search indexes.
  // (Not the transfer routes' files whole: they hold the imports' too, which the agent never starts.)
  'routes/data/copy.ts',
  // Review of C7b (I4): the alerts routes the agent's alert tools call, and what they call.
  'routes/alerts.ts',
  'routes/data/validation.ts',
  'routes/data/search-indexes.ts',
  'transfer/copy-plan.ts',
  'transfer/copy-start.ts',
  'transfer/copy-access.ts',
  'transfer/copy-job.ts',
  'transfer/source-plan.ts',
  'transfer/export-job.ts',
  // The server's own answers (a 500 is INTERNAL).
  'http/app.ts',
]
const DIRS = [
  'ai/agent',
  'data',
  'masking',
  'dbaccess',
  'backup',
  'aggregation',
  'explain',
  'jobs',
  'monitor',
  'connections',
  'encryption',
  'alerts',
]
/** The route errors' codes, as the agent says one with no reason (lower case; review of B8, I1). */
const CODES = [...ERROR_CODES.map((c) => c.toLowerCase()), 'route_error', 'tool_failed']

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : path.endsWith('.ts') ? [path] : []
  })
}

/** A reason an error thrown carries (Errors.x / new AppError, within its call), or a refusal's code. */
export function thrownReasons(source: string): string[] {
  // Review of B8 (I1, M1): a refusal written over lines too, the turn's own refusals, a busy read's
  // reason (passed by position), and a change's own end.
  const out = [
    /new Refusal\(\s*'([a-z0-9_.-]+)'/g,
    /\brefuse\('([a-z0-9_.-]+)'/g,
    /Errors\.rateLimited\([^,()]+,\s*'([a-z0-9_.-]+)'/g,
    /state: 'error',[^}]*?reason: '([a-z0-9_.-]+)'/g,
  ].flatMap((re) => [...source.matchAll(re)].map((m) => m[1]!))
  for (const m of source.matchAll(/reason: '([a-z0-9_.-]+)'/g)) {
    const before = source.slice(Math.max(0, m.index - 400), m.index)
    const at = Math.max(before.lastIndexOf('Errors.'), before.lastIndexOf('AppError('))
    // Inside that call's parentheses still (the codebase writes no semicolons).
    const call = at >= 0 ? before.slice(at) : ''
    if (at >= 0 && call.split('(').length > call.split(')').length) out.push(m[1]!)
  }
  return out
}

describe('the agent’s reasons in words (B8)', () => {
  const files = [...ROUTES.map((r) => join(SERVER, r)), ...DIRS.flatMap((d) => walk(join(SERVER, d)))]
  // The reasons written from a template, by their parts' own lists (review of B8, M1).
  const restorePlan = readFileSync(join(SERVER, 'backup', 'restore-plan.ts'), 'utf8')
  const execute = readFileSync(join(SERVER, 'ai', 'agent', 'execute.ts'), 'utf8')
  const templated = [
    ...Object.keys(en.mongo.kinds).map(connectionReason),
    ...['cron', 'never', 'min_gap'].map((r) => `cadence_${r}`),
    ...[...restorePlan.matchAll(/refusals\.add\('([a-z0-9_]+)'\)/g)].map((m) => `restore_${m[1]!}`),
    ...['off', 'read'].map((p) => `agent_policy_${p}`),
    // C3: a search index where the server has none.
    ...['not_enabled', 'unsupported'].map((r) => `search_${r}`),
    // C3: a copy plan's refusals the agent says by their own words (COPY_REFUSALS, read from it).
    ...[...(execute.match(/COPY_REFUSALS = new Set\(\[([^\]]*)\]/)?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map(
      (m) => `copy_${m[1]!}`,
    ),
    // C7: a report's refusals, by their codes (the runner's own).
    ...[
      'personal_field',
      'measure_view',
      'system_namespace',
      'server_js',
      'per_person',
      'unreachable',
      'not_supported',
      'failed',
      'encrypted_filter',
    ].flatMap((r) => [`report_${r}`, r]),
    // The export and copy start routes' own (their file holds the imports' too).
    'transfer_busy',
    'system_db',
  ]
  const reasons = new Set([
    ...files.flatMap((f) => thrownReasons(readFileSync(f, 'utf8'))),
    ...CODES,
    ...templated,
  ])

  it('reads the sources it should (a good many reasons)', () => {
    expect(reasons.size).toBeGreaterThan(150)
    for (const r of [
      'broad_role',
      'operation_unconfirmed',
      'reads_busy',
      'backup_read_busy',
      'internal',
      'restore_confirm_ttl',
      'connection_auth',
      'calls_limit',
      'plan_changed',
      'copy_confirm_personal',
    ])
      expect(reasons, r).toContain(r)
  })

  for (const lang of ['en', 'tr'] as const)
    it(`words every reason (${lang})`, () => {
      const missing = [...reasons].filter((r) => !i18n.global.te(`ai.agent.reason.${r}`, lang)).sort()
      expect(missing).toEqual([])
    })

  // Every tool by its name, in both languages (C2: a new tool cannot go without words either).
  for (const lang of ['en', 'tr'] as const)
    it(`names every tool (${lang})`, () => {
      const missing = [...AI_AGENT_READ_TOOLS, ...AI_AGENT_WRITE_TOOLS].filter(
        (tool) => !i18n.global.te(`ai.agent.tool.${tool}`, lang),
      )
      expect(missing).toEqual([])
    })

  it('finds a thrown reason, not a reason that is only data', () => {
    expect(
      thrownReasons(
        "throw Errors.conflict('x', { reason: 'a' })\nconst kinds = [{ reason: 'b' }]\nthrow new Refusal(\n  'c',\n)\nthrow Errors.rateLimited(2_000, 'd')",
      ),
    ).toEqual(['c', 'd', 'a'])
  })
})
