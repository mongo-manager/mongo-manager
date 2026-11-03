import type { FastifyInstance } from 'fastify'
import {
  DashboardSchema,
  REBINDABLE_ACTIONS,
  ShortcutBindingsSchema,
  isNewerDashboard,
  readDashboard,
  type Dashboard,
  type RebindableAction,
  type ShortcutBindings,
} from '@mongo-manager/shared'
import { Errors } from '../errors'
import { parseInput } from '../validate'
import { requireAuth } from '../http/guards'
import { chatOwner } from '../ai/access'
import type { Principal } from '../http/context'
import { nextActionRoutes } from './next-actions'

const DASHBOARD = 'dashboard'
const SHORTCUTS = 'shortcuts'
/** Nine bindings of a few keys each are well under 1 KiB. */
const SHORTCUTS_BYTES = 4 * 1024
/** A layout of 30 widgets is a few KiB; anything much larger is not one. */
const DASHBOARD_BYTES = 32 * 1024

/**
 * User review 2026-10-09: the signed-in user's own Overview dashboard. No id in the path: each user
 * reads and writes only their own.
 */
export async function meRoutes(app: FastifyInstance): Promise<void> {
  const { ctx } = app
  const owner = (principal: Principal) => chatOwner(principal) ?? 'local'

  app.get(
    '/me/dashboard',
    { preHandler: requireAuth },
    async (request): Promise<{ dashboard: Dashboard | null; newer?: true }> => {
      const stored = ctx.preferences.get(owner(request.principal!), DASHBOARD)
      // A newer version's layout is not read here, nor overwritten (final review 13).
      return isNewerDashboard(stored)
        ? { dashboard: null, newer: true }
        : { dashboard: readDashboard(stored) }
    },
  )

  app.put(
    '/me/dashboard',
    { preHandler: requireAuth, bodyLimit: DASHBOARD_BYTES },
    async (request): Promise<{ dashboard: Dashboard }> => {
      const dashboard = parseInput(DashboardSchema, request.body)
      const who = owner(request.principal!)
      if (isNewerDashboard(ctx.preferences.get(who, DASHBOARD)))
        throw Errors.conflict('This Overview was saved by a newer version of Mongo Manager')
      ctx.preferences.set(who, DASHBOARD, dashboard)
      return { dashboard }
    },
  )

  app.delete('/me/dashboard', { preHandler: requireAuth }, async (request, reply) => {
    ctx.preferences.remove(owner(request.principal!), DASHBOARD)
    return reply.status(204).send()
  })

  // W5 (completion §2 W5.3): the user's own bindings of the global shortcuts, checked on write
  // as the settings page checks them (no conflict, no browser key, known actions and keys only).
  app.get(
    '/me/shortcuts',
    { preHandler: requireAuth },
    async (request): Promise<{ bindings: ShortcutBindings; dropped?: RebindableAction[] }> => {
      const { bindings, dropped } = readBindings(ctx.preferences.get(owner(request.principal!), SHORTCUTS))
      // W5 re-review: what was left out is said, so the next change does not lose it unseen.
      return dropped.length ? { bindings, dropped } : { bindings }
    },
  )

  app.put(
    '/me/shortcuts',
    { preHandler: requireAuth, bodyLimit: SHORTCUTS_BYTES },
    async (request): Promise<{ bindings: ShortcutBindings }> => {
      const { bindings } = parseInput(ShortcutBindingsSchema, request.body)
      ctx.preferences.set(owner(request.principal!), SHORTCUTS, { bindings })
      return { bindings }
    },
  )

  app.delete('/me/shortcuts', { preHandler: requireAuth }, async (request, reply) => {
    ctx.preferences.remove(owner(request.principal!), SHORTCUTS)
    return reply.status(204).send()
  })

  // completion W6.2: the Overview's next steps, put in order by the AI when the user asks.
  await nextActionRoutes(app)
}

/**
 * What is kept, read leniently: a binding this version cannot use (an action it does not have, a key
 * it now keeps for the browser, one that came to conflict) is left out, the rest kept. The set is
 * checked whole, since bindings may only fit together (a swap, a chain: review I1); what a check
 * names as wrong goes, and the rest is checked again.
 */
function readBindings(stored: unknown): { bindings: ShortcutBindings; dropped: RebindableAction[] } {
  const raw = (stored as { bindings?: unknown } | null)?.bindings
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { bindings: {}, dropped: [] }
  const known: readonly string[] = REBINDABLE_ACTIONS
  let current = Object.fromEntries(Object.entries(raw).filter(([action]) => known.includes(action)))
  // The actions of this version left out (names only; an action it no longer has is not one).
  const all = Object.keys(current) as RebindableAction[]
  const result = (bindings: ShortcutBindings) => ({
    bindings,
    dropped: all.filter((action) => !Object.hasOwn(bindings, action)),
  })
  // Each round leaves out at least one binding, so there are at most as many rounds as actions.
  for (let round = 0; round <= known.length; round++) {
    const checked = ShortcutBindingsSchema.safeParse({ bindings: current })
    if (checked.success) return result(checked.data.bindings)
    const named = new Set(
      checked.error.issues.map((i) => i.path[1]).filter((k): k is string => typeof k === 'string'),
    )
    const next = Object.fromEntries(Object.entries(current).filter(([action]) => !named.has(action)))
    if (Object.keys(next).length === Object.keys(current).length) return result({})
    current = next
  }
  return result({})
}
