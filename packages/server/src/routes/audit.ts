import { Readable } from 'node:stream'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { parseInput } from '../validate'
import { requirePermission } from '../http/guards'
import { AuditRetentionBody, type AuditEntry, type AuditFilter } from '../audit/audit'
import { Errors } from '../errors'
import { checkPassword, requireStepUp } from './auth'
import { startsLikeFormula } from '../transfer/formats/csv'

const Filters = {
  action: z.string().min(1).max(100).optional(),
  userId: z.string().min(1).max(100).optional(),
  connectionId: z.string().min(1).max(100).optional(),
  /** ISO 8601 instants, inclusive. */
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  /** B6: one assistant turn (its run's id). */
  run: z
    .string()
    .regex(/^[A-Za-z0-9-]{1,64}$/)
    .optional(),
}
const reversed = (q: { from?: string; to?: string }) =>
  !q.from || !q.to || Date.parse(q.from) <= Date.parse(q.to)
const AuditQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(500).default(100),
    beforeId: z.coerce.number().int().positive().optional(),
    ...Filters,
  })
  .refine(reversed, 'from must not be after to')
const SettingsQuery = z.strictObject({ preview: z.coerce.number().int().min(30).max(3650).optional() })
const ExportQuery = z
  .strictObject({ format: z.enum(['csv', 'ndjson']), ...Filters })
  .refine(reversed, 'from must not be after to')

const filterOf = (q: z.infer<typeof ExportQuery> | z.infer<typeof AuditQuery>): AuditFilter => ({
  ...(q.action !== undefined ? { action: q.action } : {}),
  ...(q.userId !== undefined ? { userId: q.userId } : {}),
  ...(q.connectionId !== undefined ? { connectionId: q.connectionId } : {}),
  ...(q.from !== undefined ? { from: Date.parse(q.from) } : {}),
  ...(q.to !== undefined ? { to: Date.parse(q.to) } : {}),
  ...(q.run !== undefined ? { run: q.run } : {}),
})

const CSV_COLUMNS = [
  'id',
  'at',
  'username',
  'userId',
  'ip',
  'action',
  'outcome',
  'connectionId',
  'namespace',
  'details',
] as const
/**
 * Phase 4c §1, review I2: a CSV cell — never a spreadsheet formula. Every cell is quoted, so a
 * spreadsheet splitting on ";" (Turkish and most European Excel) never splits one; a cell starting,
 * after any spaces, with =, +, -, @, a tab or a line break is prefixed with '.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '""'
  let text = typeof value === 'string' ? value : JSON.stringify(value)
  if (startsLikeFormula(text)) text = `'${text}`
  return `"${text.replace(/"/g, '""')}"`
}
const csvRow = (e: AuditEntry) =>
  [
    e.id,
    new Date(e.at).toISOString(),
    e.username,
    e.userId,
    e.ip,
    e.action,
    e.outcome,
    e.connectionId,
    e.namespace,
    e.details === null ? null : JSON.stringify(e.details),
  ]
    .map(csvCell)
    .join(',')

/** "20260109-120000", for a file name. */
const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)

export async function auditRoutes(app: FastifyInstance): Promise<void> {
  const { ctx } = app
  app.get('/audit', { preHandler: requirePermission('audit:read') }, async (request) => {
    const q = parseInput(AuditQuery, request.query)
    return ctx.audit.list({
      limit: q.limit,
      ...(q.beforeId !== undefined ? { beforeId: q.beforeId } : {}),
      ...filterOf(q),
    })
  })

  // Security audit 2026-10-16: whether the log's chain checks, and where it broke first.
  app.get('/audit/integrity', { preHandler: requirePermission('audit:read') }, async () => {
    const { ok, brokenAt, legacy } = await ctx.audit.verify()
    return { ok, brokenAt, legacy }
  })

  // Phase 4c §1: every matching entry, oldest first, streamed; the export is audited.
  app.get(
    '/audit/export',
    { preHandler: requirePermission('audit:read'), config: { audit: 'audit.export' } },
    async (request, reply) => {
      const q = parseInput(ExportQuery, request.query)
      const filter = filterOf(q)
      // Security audit 2026-10-16: the export says whether the chain checks — the shared, incremental
      // look (the whole chain at most hourly), never a walk of its own per export (review I5).
      const chain = await ctx.audit.verify()
      const chainState = chain.brokenAt ? `broken at ${chain.brokenAt.id}` : 'ok'
      request.auditInfo = { details: { format: q.format, ...filter, chain: chainState } }
      const entries = ctx.audit.each(filter)
      const lines =
        q.format === 'csv'
          ? (function* () {
              yield `${CSV_COLUMNS.map(csvCell).join(',')}\r\n`
              for (const e of entries) yield `${csvRow(e)}\r\n`
            })()
          : (function* () {
              for (const e of entries) yield `${JSON.stringify(e)}\n`
            })()
      return reply
        .header(
          'content-type',
          q.format === 'csv' ? 'text/csv; charset=utf-8' : 'application/x-ndjson; charset=utf-8',
        )
        .header('content-disposition', `attachment; filename="audit-${stamp(ctx.now())}.${q.format}"`)
        .header('cache-control', 'no-store')
        .header('x-audit-chain', chainState)
        .send(Readable.from(lines))
    },
  )

  // Phase 4c §2: how long the log is kept — read by its readers (with how many entries fewer days
  // would remove, asked before), changed by an administrator.
  app.get('/audit/settings', { preHandler: requirePermission('audit:read') }, async (request) => {
    const { preview } = parseInput(SettingsQuery, request.query)
    return {
      ...ctx.audit.retention(),
      ...(preview !== undefined ? { wouldRemove: ctx.audit.countOlderThan(preview) } : {}),
    }
  })
  app.put(
    '/audit/settings',
    { preHandler: requirePermission('settings:manage'), config: { audit: 'audit.settings' } },
    async (request) => {
      const body = parseInput(AuditRetentionBody, request.body)
      request.auditInfo = { details: { days: body.days } }
      // Review I4: fewer days than in force removes history — the administrator's password first
      // (team mode), and it waits a day (time to take it back, or export first).
      const principal = request.principal!
      if (ctx.audit.shortens(body.days) && principal.kind === 'user') {
        const record = ctx.users.findById(principal.userId)
        if (!record || !body.password || !(await checkPassword(ctx, record, body.password)))
          throw Errors.validation('Enter your password to shorten the audit log', {
            reason: 'wrong_password',
          })
        // Security audit 2026-10-16: removing history takes a second factor proved lately too.
        requireStepUp(request, record)
      }
      return ctx.audit.setRetention(body.days)
    },
  )
}
