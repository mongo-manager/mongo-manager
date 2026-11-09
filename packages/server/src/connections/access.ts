// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { FastifyRequest } from 'fastify'
import { DATA_WRITE_PERMISSIONS, permissionsFor, type Permission, type Role } from '@mongo-manager/shared'
import { Errors } from '../errors'
import type { Principal, ServerContext } from '../http/context'
import { AGENT_CALL_HEADER } from '../ai/agent/calls'

/** Spec §3.3: global role, overridden per connection by a grant; 'none' hides it. Admins keep admin. */
export function effectiveRole(ctx: ServerContext, principal: Principal, connectionId: string): Role | null {
  if (principal.kind === 'local' || principal.role === 'admin') return 'admin'
  const grant = ctx.grants.roleFor(connectionId, principal.userId)
  if (grant === 'none') return null
  return grant ?? principal.role
}

/**
 * Phase 3b spec §2.2: a user who may not see the connection's personal data. A grant never
 * restricts the connection's admins: they define the rules. User request 2026-10-24: its
 * administrators may hide it from themselves ("hide from me", hidesFromSelf), with the same guards.
 */
export function isRestricted(ctx: ServerContext, principal: Principal, connectionId: string): boolean {
  // User request 2026-10-13: in local mode the rules hide values from the local user too, with the
  // guards of a team member who may not see personal data (2026-10-24: no switch to show them).
  // Work running on its own for them is not (review 2026-10-13, C1): their backups stay whole.
  if (principal.kind === 'local')
    return !principal.unattended && ctx.personalFields.hiddenLocally(connectionId)
  if (principal.kind !== 'user') return false
  if (hidesFromSelf(ctx, principal, connectionId)) return true
  if (effectiveRole(ctx, principal, connectionId) === 'admin') return false
  return ctx.grants.maskedGrant(connectionId, principal.userId)
}

/**
 * User report 2026-10-30: values hidden from the person by someone else's rule — a member given masked
 * access to a connection they do not administer. Not one who hides values from themselves (they show
 * them again at will) nor local mode's one person (they edit the rules): for them hiding is how values
 * are shown, never what they may do — MongoDB's accounts stay theirs to manage.
 */
export function restrictedByOthers(ctx: ServerContext, principal: Principal, connectionId: string): boolean {
  if (principal.kind !== 'user') return false
  if (effectiveRole(ctx, principal, connectionId) === 'admin') return false
  return ctx.grants.maskedGrant(connectionId, principal.userId)
}

/**
 * User request 2026-10-24: a team member's own "hide from me". It is how they view data, never what
 * work running on its own for them writes; and it holds only while they administer the connection
 * (the choice is made and undone on its Personal data tab): made an editor, they were left masked
 * with no way back (review of the rework, I4).
 */
export function hidesFromSelf(ctx: ServerContext, principal: Principal, connectionId: string): boolean {
  if (principal.kind !== 'user' || principal.unattended) return false
  const role = effectiveRole(ctx, principal, connectionId)
  if (!role || !permissionsFor(role).has('connections:manage')) return false
  return ctx.personalFields.hiddenFromSelf(connectionId, principal.userId)
}

/** The principal as work running on its own for it acts: what it writes is not masked by a view. */
export const unattended = (principal: Principal): Principal => ({ ...principal, unattended: true })

/** The principal as its person views data (the history of their scheduled work, for one). */
export function viewing(principal: Principal): Principal {
  if (!principal.unattended) return principal
  const person = { ...principal }
  delete person.unattended
  return person
}

/**
 * Phase 3a-1 spec §9: who may open a shell. Admins of the connection always may; an editor only
 * with a per-connection shell grant; a viewer never; and no one when the shell is disabled. A user
 * who may not see personal data never may (phase 3b §2.2): code there could read anything.
 */
export function mayUseShell(ctx: ServerContext, principal: Principal, connectionId: string): boolean {
  if (!ctx.config.shell.enabled) return false
  // First: an admin who does not see personal data (the local user hiding it) has no shell either.
  if (isRestricted(ctx, principal, connectionId)) return false
  const role = effectiveRole(ctx, principal, connectionId)
  if (role === 'admin') return true
  if (role === 'editor' && principal.kind === 'user')
    return ctx.grants.shellGrant(connectionId, principal.userId)
  return false
}

/** Databases whose contents belong to MongoDB itself. */
export const SYSTEM_DATABASES = new Set(['admin', 'config', 'local'])
/** Collections holding credentials or key material: unreadable for non-admins. */
export const CREDENTIAL_COLLECTIONS = new Set([
  'system.users',
  'system.keys',
  'system.backup_users',
  'system.roles',
])

/**
 * Security review 2026-10-13 (M1): the local database is its connection admins' only — its oplog
 * holds every write, password hashes included.
 */
export const ADMIN_ONLY_DATABASES = new Set(['local'])

/**
 * Security audit 2026-10-16 (minor): what only a connection's admins may read, in one place — the
 * local database whole (its oplog holds every write, password hashes included) and the credential
 * collections of any database. Every route, list and log that hides those uses this.
 */
export function isAdminOnlyNamespace(db: string | null | undefined, coll?: string | null): boolean {
  return (
    (!!db && ADMIN_ONLY_DATABASES.has(db)) ||
    (!!coll && CREDENTIAL_COLLECTIONS.has(coll)) ||
    isEncryptionNamespace(db, coll)
  )
}

/**
 * W8, security review C1: client-side encryption's own collections — every key vault a connection
 * on this server names (data keys, their alternate names and master key endpoints) and Queryable
 * Encryption's metadata (enxcol_.*) — are key material: a connection admin's only, read or write.
 * Someone who could rewrite a master key's endpoint would have the next decrypting read send the KMS
 * token to their host. Every key vault of every connection counts (over-hiding is the safe side), so
 * the checks need no connection at hand: each server registers its connections here.
 */
export interface KeyVaultSource {
  keyVaultNamespaces(): ReadonlySet<string>
}
const KEY_VAULT_SOURCES = new Set<KeyVaultSource>()
export function registerKeyVaults(source: KeyVaultSource): () => void {
  KEY_VAULT_SOURCES.add(source)
  return () => KEY_VAULT_SOURCES.delete(source)
}
export function isEncryptionNamespace(db: string | null | undefined, coll?: string | null): boolean {
  if (!coll) return false
  if (coll.startsWith('enxcol_.')) return true
  if (!db) return false
  const ns = `${db}.${coll}`
  for (const s of KEY_VAULT_SOURCES) if (s.keyVaultNamespaces().has(ns)) return true
  return false
}
/** A database holds a key vault some connection names. */
export function hostsKeyVault(db: string): boolean {
  for (const s of KEY_VAULT_SOURCES)
    for (const ns of s.keyVaultNamespaces()) if (ns.startsWith(`${db}.`)) return true
  return false
}

/** The same for a "db.coll" namespace (share review C1, I2): a database alone counts too. */
export function isAdminOnlyNs(namespace: string | null | undefined): boolean {
  if (!namespace) return false
  const dot = namespace.indexOf('.')
  return dot < 0
    ? isAdminOnlyNamespace(namespace)
    : isAdminOnlyNamespace(namespace.slice(0, dot), namespace.slice(dot + 1))
}

/**
 * W4 review C1: a restore drill's scratch database (mm_drill_<hex>) holds a backup's documents while
 * the drill runs. No one opens it through the app, connection admins included: it is not data
 * anyone works on, and a backup restored there may be one the reader may not see whole.
 */
export function isDrillScratch(db: string | null | undefined): boolean {
  return !!db && /^mm_drill_/i.test(db)
}

/** W4 re-review C1: a "db.coll" namespace in a drill's scratch database. */
export function isDrillScratchNs(ns: string | null | undefined): boolean {
  if (!ns) return false
  const dot = ns.indexOf('.')
  return isDrillScratch(dot < 0 ? ns : ns.slice(0, dot))
}

/** W4 re-review C1: refuses a drill's scratch database, whoever asks. */
export function assertNotDrillScratch(...dbs: Array<string | null | undefined>): void {
  if (dbs.some((db) => isDrillScratch(db)))
    throw Errors.forbidden('A restore drill’s scratch database is not open to anyone', {
      reason: 'drill_scratch',
    })
}

/** Keys of a request whose value names a database. */
const DB_KEYS = new Set(['db', 'database', 'targetDb', 'sourceDb'])
/** Keys holding a user's data (documents, queries, code): their contents are never read as names. */
const DATA_KEYS = new Set([
  'documents',
  'document',
  'filter',
  'query',
  'pipeline',
  'update',
  'replacement',
  'sort',
  'projection',
  'values',
  'rows',
  'cells',
  'text',
  'code',
  'script',
  'value',
  'doc',
  'docs',
  'fields',
  'body',
])

/**
 * W4 re-review C1: whether a request's parameters, query or body name a drill's scratch database —
 * under a key that names a database (db, database, …), at any depth up to 6 inside the request's own
 * structure (source, target, mapping, scope, …), never inside a user's documents or queries.
 */
export function namesDrillScratch(value: unknown): boolean {
  const budget = { left: SCAN_ENTRIES }
  return scan(value, 0, budget)
}

/**
 * W4 re-review 2 (I2): at most this many entries are looked at. W4 final review (minor): above the
 * largest body the server takes (1 MiB, about 100,000 entries), and past it the request is refused —
 * a scan that stopped would let a padded request through.
 */
const SCAN_ENTRIES = 200_000

const tooComplex = () => Errors.validation('The request is too complex', { reason: 'too_complex' })

/** A plain object (a parsed JSON body's): never a Buffer, a stream or another class's internals. */
function isPlain(v: object): boolean {
  const proto = Object.getPrototypeOf(v) as unknown
  return proto === Object.prototype || proto === null
}

function scan(value: unknown, depth: number, budget: { left: number }): boolean {
  if (depth > 6 || value === null || typeof value !== 'object') return false
  if (Array.isArray(value)) {
    for (const v of value) {
      if (--budget.left < 0) throw tooComplex()
      if (scan(v, depth + 1, budget)) return true
    }
    return false
  }
  if (!isPlain(value)) return false
  for (const k in value) {
    if (!Object.prototype.hasOwnProperty.call(value, k)) continue
    if (--budget.left < 0) throw tooComplex()
    if (DATA_KEYS.has(k)) continue
    const v = (value as Record<string, unknown>)[k]
    if (DB_KEYS.has(k) && typeof v === 'string' && isDrillScratch(v)) return true
    if ((k === 'ns' || k === 'namespace') && typeof v === 'string' && isDrillScratchNs(v)) return true
    if (scan(v, depth + 1, budget)) return true
  }
  return false
}

/** Writes to system namespaces and reads of credential collections need the connection admin role. */

export function isRestrictedNamespace(db: string, coll: string | undefined, write: boolean): boolean {
  if (coll && CREDENTIAL_COLLECTIONS.has(coll)) return true
  if (isEncryptionNamespace(db, coll)) return true
  return write && (SYSTEM_DATABASES.has(db) || (coll?.startsWith('system.') ?? false))
}

/**
 * W8, security review Minor 8: documents are written onto a connection with client-side encryption
 * only by someone who may see its data — the same rule as the document routes', for writes that
 * reach a connection another way (a copy's target, a fetched backup's restore).
 */
export function assertEncryptedWriteAllowed(
  ctx: ServerContext,
  principal: Principal,
  connection: { id: string; settings: { encryption?: { enabled: boolean } | undefined } },
): void {
  // A copy's own rules on encrypted values (copy-plan: ciphertext moved as stored, Queryable
  // Encryption refused) stay as they are; this is the masked person's refusal alone.
  if (!connection.settings.encryption?.enabled) return
  if (isRestricted(ctx, principal, connection.id))
    throw Errors.forbidden(
      'You cannot write documents on a connection with client-side encryption while personal data is hidden from you',
      { reason: 'encryption_masked_write' },
    )
}

/**
 * Phase 3d-1: who may export files. The role's data:export (admins and editors), or a viewer with
 * the per-connection export grant. Read-only mode does not take it away: exporting only reads.
 */
export function mayExport(ctx: ServerContext, principal: Principal, connectionId: string): boolean {
  const role = effectiveRole(ctx, principal, connectionId)
  if (!role) return false
  if (permissionsFor(role).has('data:export')) return true
  return principal.kind === 'user' && ctx.grants.exportGrant(connectionId, principal.userId)
}

/** requireConnection('documents:read') plus mayExport (phase 3d-1). */
export function requireExport() {
  const read = requireConnection('documents:read')
  return async (request: FastifyRequest): Promise<void> => {
    await read(request)
    if (!mayExport(request.server.ctx, request.principal!, request.connection!.id)) throw Errors.forbidden()
  }
}

export function requireConnection(permission: Permission) {
  return async (request: FastifyRequest): Promise<void> => {
    const principal = request.principal
    if (!principal) throw Errors.unauthenticated()
    const { ctx } = request.server
    const id = (request.params as { id?: unknown }).id
    const connection = typeof id === 'string' && id.length <= 64 ? ctx.connections.get(id) : undefined
    const role = connection ? effectiveRole(ctx, principal, connection.id) : null
    if (!connection || !role) throw Errors.notFound('Connection not found')
    const readOnly = ctx.config.readOnly || connection.readOnly
    if (!permissionsFor(role, { readOnly }).has(permission)) {
      if (readOnly && DATA_WRITE_PERMISSIONS.has(permission) && permissionsFor(role).has(permission))
        throw Errors.readOnly()
      throw Errors.forbidden()
    }
    const { db, coll } = request.params as { db?: unknown; coll?: unknown }
    if (typeof db === 'string' && isDrillScratch(db))
      throw Errors.forbidden('A restore drill’s scratch database is not open to anyone')
    if (role !== 'admin' && typeof db === 'string') {
      const write = DATA_WRITE_PERMISSIONS.has(permission)
      const name = typeof coll === 'string' ? coll : undefined
      if (isAdminOnlyNamespace(db, name) || isRestrictedNamespace(db, name, write)) {
        throw Errors.forbidden('System namespaces are restricted to connection admins')
      }
    }
    // Security review C1: key material is never read by someone from whom personal data is hidden,
    // an administrator included (the local user hiding it).
    if (
      role === 'admin' &&
      typeof db === 'string' &&
      isEncryptionNamespace(db, typeof coll === 'string' ? coll : undefined) &&
      isRestricted(ctx, principal, connection.id)
    )
      throw Errors.forbidden('Encryption keys are not shown while personal data is hidden from you', {
        reason: 'encryption_keys_hidden',
      })
    // W8: on a connection with client-side encryption, documents are written through the client
    // that encrypts them. Someone who may not see personal data never gets that client (it decrypts
    // too), and a connection set to decrypt only does not encrypt: their writes would store values
    // in the clear where they belong encrypted, so they are refused.
    const e = connection.settings.encryption
    if (e?.enabled && permission === 'documents:write') {
      if (e.mode === 'decryptOnly')
        throw Errors.forbidden('This connection decrypts only: documents are not written through it', {
          reason: 'encryption_decrypt_only',
        })
      // W8 × W6: the agent's calls read and write as stored (clientFor), so they do not encrypt.
      if (request.headers[AGENT_CALL_HEADER] !== undefined)
        throw Errors.forbidden(
          'The assistant does not write documents where client-side encryption is used',
          {
            reason: 'encrypted_connection',
          },
        )
      if (isRestricted(ctx, principal, connection.id))
        throw Errors.forbidden(
          'You cannot write documents on a connection with client-side encryption while personal data is hidden from you',
          { reason: 'encryption_masked_write' },
        )
    }
    request.connection = connection
    request.connectionRole = role
    request.connectionPermission = permission
  }
}

/** W7: whose OIDC sign-in a request uses — a team user's own, or the one local user's. */
export function personOf(principal: Principal): string {
  return principal.kind === 'user' ? principal.userId : 'local'
}
