import type { FastifyInstance } from 'fastify'
import { MAX_PERSONAL_RULES, PersonalRuleSchema, PersonalRulesBodySchema } from '@mongo-manager/shared'
import { parseInput } from '../../validate'
import { requireConnection } from '../../connections/access'
import { Errors } from '../../errors'
import { maskerFor } from '../../masking/request'
import { viewAwareMaskerFor } from '../../masking/restricted'
import { BucketNameSchema, CollectionNameSchema, DatabaseNameSchema } from '@mongo-manager/shared'
import { bucketLocked } from '../../masking/modes'
import { z } from 'zod'

const AppliedQuery = z.object({
  db: DatabaseNameSchema.optional(),
  coll: CollectionNameSchema.optional(),
  bucket: BucketNameSchema.optional(),
})
const SelfBody = z.strictObject({ hidden: z.boolean() })
/**
 * User request 2026-10-24: each change is saved at once, made on the rules as read (`base`). Rules
 * changed meanwhile (another tab, another admin) refuse it, so no rule is lost unseen: the page reads
 * them again and makes its change on those.
 */
const PutBody = z.strictObject({
  rules: z.unknown(),
  base: z.array(PersonalRuleSchema).max(MAX_PERSONAL_RULES).optional(),
})
const parts = (rules: ReadonlyArray<{ db: string; coll: string; field: string }>) =>
  JSON.stringify(rules.map((r) => [r.db, r.coll, r.field]))

/**
 * Phase 3b spec §2.1: the connection's personal-field rules, for its admins. The audit row holds
 * how many rules there were and are, never the rules themselves.
 */
export async function personalFieldRoutes(app: FastifyInstance): Promise<void> {
  const base = '/connections/:id/personal-fields'
  const admin = requireConnection('connections:manage')

  app.get(base, { preHandler: admin, config: { masking: 'names-only' } }, async (request) => ({
    rules: app.ctx.personalFields.stored(request.connection!.id).rules,
    // Team mode: whether this member said to hide the values the rules name from themselves too.
    ...(request.principal!.kind === 'user'
      ? {
          hiddenFromMe: app.ctx.personalFields.hidesFromSelf(
            request.connection!.id,
            request.principal!.userId,
          ),
        }
      : {}),
  }))

  // User request 2026-10-24: a team member hides the connection's personal data from themselves too
  // (or shows it again). Local mode has no switch: one person, whom the rules always hide it from.
  app.put(
    `${base}/self`,
    { preHandler: admin, config: { masking: 'names-only', audit: 'connections.personalFields.self' } },
    async (request) => {
      const principal = request.principal!
      if (principal.kind !== 'user') throw Errors.notFound('Not found')
      const { hidden } = parseInput(SelfBody, request.body ?? {})
      const connectionId = request.connection!.id
      app.ctx.personalFields.setHiddenFromSelf(connectionId, principal.userId, hidden)
      request.auditInfo = { details: { hidden } }
      // Hidden now: a shell they opened while it was shown could go on reading it.
      if (hidden) await app.ctx.shell.closeFor({ connectionId, userId: principal.userId }, 'access')
      return { hidden }
    },
  )

  // Phase 3c §7: the rules that hide values from this caller, names only, so the web can mark
  // what the server hides. Empty for everyone who sees the values. User report 2026-10-27 and its
  // review (M3): `reaches` — whether values are hidden from the caller where they are (the badge): the
  // connection (any rule, or client-side encryption's key vault), a database (a rule of it, of every
  // database, or the key vault's), a collection (its rules through views, or its database's: a
  // $lookup reads them), a GridFS bucket (by what its files and chunks read).
  app.get(
    `${base}/applied`,
    { preHandler: requireConnection('documents:read'), config: { masking: 'names-only' } },
    async (request) => {
      const masker = maskerFor(request)
      if (!masker) return { rules: [], reaches: false }
      const rules = app.ctx.personalFields.stored(request.connection!.id).rules
      const { db, coll, bucket } = parseInput(AppliedQuery, request.query ?? {})
      if (!db)
        return { rules, reaches: masker.anyRules || !!request.connection!.settings.encryption?.enabled }
      if (bucket) return { rules, reaches: await bucketLocked(request, db, bucket) }
      if (!coll) return { rules, reaches: masker.anyInDb(db) }
      // Final review M4: the paths hidden in one namespace, following a view to what it reads.
      const aware = await viewAwareMaskerFor(request, [[db, coll]])
      const patterns = aware!.forNs(db, coll).patterns
      return { rules, patterns, reaches: patterns.length > 0 || masker.anyInDb(db) }
    },
  )

  app.put(
    base,
    { preHandler: admin, config: { masking: 'names-only', audit: 'connections.personalFields' } },
    async (request) => {
      const body = parseInput(PutBody, request.body ?? {})
      const { rules } = parseInput(PersonalRulesBodySchema, { rules: body.rules })
      const stored = app.ctx.personalFields.stored(request.connection!.id).rules
      if (body.base && parts(body.base) !== parts(stored))
        throw Errors.conflict('The personal-data rules changed meanwhile')
      const before = stored.length
      app.ctx.personalFields.set(request.connection!.id, rules)
      request.auditInfo = { details: { before, after: rules.length } }
      // The values may be hidden now from the local user (local mode) or from those who hide them
      // from themselves; a shell they have open could read them (review 2026-10-13, M5).
      const connectionId = request.connection!.id
      if (request.principal!.kind === 'local' && app.ctx.personalFields.hiddenLocally(connectionId))
        await app.ctx.shell.closeFor({ connectionId }, 'access')
      for (const userId of app.ctx.personalFields.usersHidingFromSelf(connectionId))
        if (app.ctx.personalFields.hiddenFromSelf(connectionId, userId))
          await app.ctx.shell.closeFor({ connectionId, userId }, 'access')
      return { rules }
    },
  )
}
