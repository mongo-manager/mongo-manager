// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { Binary, type Document } from 'mongodb'
import {
  CreateDataKeySchema,
  CreateEncryptedCollectionSchema,
  RewrapDataKeysSchema,
  type DataKeyInfo,
  type EncryptionSummary,
  type MasterKey,
} from '@mongo-manager/shared'
import { Errors } from '../../errors'
import { parseInput } from '../../validate'
import { isRestricted, requireConnection } from '../../connections/access'
import { connectionProblem } from '../../connections/policy'
import { moduleUnavailableMessage } from '../../optional/modules'
import { clientFor, withMongo } from '../../data/mongo-errors'
import { encryptedFields } from '../../encryption/fields'
import { masterKeyOf, type EncryptionTools } from '../../encryption/tools'
import { masterKeyProblem } from '../../encryption/options'
import { classifyError } from '../../connections/errors'
import { CollParams, DbParams, assertTargetAllowed } from './params'

/**
 * W8 (completion): CSFLE / Queryable Encryption on a connection — what it is set to, the data
 * keys (list without key material, create, rewrap), Queryable Encryption collections and the
 * encrypted fields of a collection (for the marks in the documents view). Key management is a
 * connection administrator's (databases:admin) and refused to anyone who may not see personal data
 * (key alt names often name people). Every call needs mongodb-client-encryption: the standalone
 * binaries and the Docker image say it is not in their package.
 */
const uuidOf = (b: unknown): string =>
  b instanceof Binary ? Buffer.from(b.buffer).toString('hex') : String(b ?? '')

export async function encryptionRoutes(app: FastifyInstance): Promise<void> {
  const { ctx } = app
  const admin = requireConnection('databases:admin')

  /** The connection's encryption, usable here (enabled, package present, policy met). */
  const usable = (request: FastifyRequest) => {
    const s = request.connection!.settings
    if (!s.encryption?.enabled)
      throw Errors.conflict('Client-side encryption is not set up on this connection', {
        reason: 'encryption_not_set_up',
      })
    const problem = connectionProblem(s, ctx.policy())
    if (problem) throw Errors.conflict(problem.message, { reason: problem.reason })
    return s.encryption
  }
  const providerOf = (request: FastifyRequest, m: MasterKey) => {
    const e = usable(request)
    if (!(e.kms as Record<string, unknown>)[m.provider])
      throw Errors.validation(`The connection has no ${m.provider} key provider`, {
        reason: 'kms_provider_missing',
      })
    // Security review C1: a master key's endpoint is where the KMS token goes.
    const problem = masterKeyProblem(m, request.connection!.settings, ctx.policy())
    if (problem) throw Errors.validation(problem, { reason: 'kms_host_not_allowed' })
  }
  const tools = async (request: FastifyRequest): Promise<EncryptionTools> => {
    // Key management reads and writes the key vault as stored (never through a decrypting client).
    const client = await clientFor(request, { asStored: true })
    try {
      return await ctx.encryptionTools(client, request.connection!.settings)
    } catch (e) {
      const err = classifyError(e)
      throw Errors.conflict(err.message, { reason: 'encryption_unavailable' })
    }
  }

  app.get(
    '/connections/:id/encryption',
    { preHandler: requireConnection('connections:read'), config: { masking: 'names-only' } },
    async (request): Promise<EncryptionSummary> => {
      const e = request.connection!.settings.encryption
      const info = ctx.optionalModules.clientEncryption
      const available = info.status === 'available'
      return {
        enabled: e?.enabled === true,
        available,
        ...(available
          ? {}
          : { unavailableReason: moduleUnavailableMessage('mongodb-client-encryption', info) }),
        ...(e?.enabled
          ? {
              mode: e.mode,
              keyVaultNamespace: e.keyVaultNamespace,
              providers: Object.keys(e.kms).filter((k) => (e.kms as Record<string, unknown>)[k]),
              library: e.library,
            }
          : {}),
      }
    },
  )

  app.get(
    '/connections/:id/encryption/keys',
    { preHandler: admin, config: { masking: 'denied' } },
    async (request): Promise<DataKeyInfo[]> => {
      const e = usable(request)
      const [db, coll] = [
        e.keyVaultNamespace.split('.')[0]!,
        e.keyVaultNamespace.split('.').slice(1).join('.'),
      ]
      const client = await clientFor(request, { asStored: true })
      // Never the key material: an encrypted data key is still key material.
      const keys = await withMongo(() =>
        client
          .db(db)
          .collection(coll)
          .find({}, { projection: { keyMaterial: 0 }, limit: 1000 })
          .toArray(),
      )
      const hide = isRestricted(ctx, request.principal!, request.connection!.id)
      return keys.map((k: Document) => {
        const names = Array.isArray(k.keyAltNames) ? k.keyAltNames.map(String) : []
        const { provider, ...masterKey } = (k.masterKey ?? {}) as Document
        return {
          id: uuidOf(k._id),
          keyAltNames: hide ? [] : names,
          ...(hide && names.length ? { keyAltNamesHidden: names.length } : {}),
          provider: String(provider ?? ''),
          masterKey,
          createdAt: k.creationDate instanceof Date ? k.creationDate.toISOString() : null,
          updatedAt: k.updateDate instanceof Date ? k.updateDate.toISOString() : null,
          status: typeof k.status === 'number' ? k.status : null,
        }
      })
    },
  )

  app.post(
    '/connections/:id/encryption/keys',
    { preHandler: admin, config: { masking: 'denied', audit: 'encryption.keys.create' } },
    async (request) => {
      const body = parseInput(CreateDataKeySchema, request.body)
      providerOf(request, body.masterKey)
      const t = await tools(request)
      const masterKey = masterKeyOf(body.masterKey)
      const id = await withMongo(() =>
        t.createDataKey(body.masterKey.provider, {
          ...(masterKey ? { masterKey } : {}),
          ...(body.keyAltNames?.length ? { keyAltNames: body.keyAltNames } : {}),
        }),
      )
      request.auditInfo = { details: { provider: body.masterKey.provider, keyId: uuidOf(id) } }
      return { id: uuidOf(id) }
    },
  )

  app.post(
    '/connections/:id/encryption/keys/rewrap',
    { preHandler: admin, config: { masking: 'denied', audit: 'encryption.keys.rewrap' } },
    async (request) => {
      const body = parseInput(RewrapDataKeysSchema, request.body)
      providerOf(request, body.masterKey)
      const t = await tools(request)
      const filter = body.keyIds
        ? { _id: { $in: body.keyIds.map((id) => new Binary(Buffer.from(id, 'hex'), Binary.SUBTYPE_UUID)) } }
        : {}
      const masterKey = masterKeyOf(body.masterKey)
      const result = await withMongo(() =>
        t.rewrapManyDataKey(filter, {
          provider: body.masterKey.provider,
          ...(masterKey ? { masterKey } : {}),
        }),
      )
      const rewrapped = result.bulkWriteResult?.modifiedCount ?? 0
      request.auditInfo = { details: { provider: body.masterKey.provider, rewrapped, all: !body.keyIds } }
      return { rewrapped }
    },
  )

  app.post(
    '/connections/:id/databases/:db/encrypted-collections',
    { preHandler: admin, config: { masking: 'denied', audit: 'encryption.collections.create' } },
    async (request) => {
      const { db } = parseInput(DbParams, request.params)
      const body = parseInput(CreateEncryptedCollectionSchema, request.body)
      assertTargetAllowed(request, db, body.name)
      providerOf(request, body.masterKey)
      const t = await tools(request)
      const masterKey = masterKeyOf(body.masterKey)
      const client = await clientFor(request, { asStored: true })
      const fields = body.fields.map((f) => ({
        path: f.path,
        bsonType: f.bsonType,
        // A key is made for each field (keyId null): createEncryptedCollection creates them.
        keyId: null,
        ...(f.queries ? { queries: f.queries } : {}),
      }))
      const created = await withMongo(() =>
        t.createEncryptedCollection(client.db(db), body.name, {
          provider: body.masterKey.provider,
          ...(masterKey ? { masterKey } : {}),
          createCollectionOptions: { encryptedFields: { fields } },
        }),
      )
      request.auditInfo = {
        details: { collection: body.name, fields: body.fields.length, provider: body.masterKey.provider },
      }
      return {
        name: body.name,
        fields: ((created.encryptedFields?.fields as Document[] | undefined) ?? []).map((f) => ({
          path: String(f.path),
          keyId: uuidOf(f.keyId),
        })),
      }
    },
  )

  app.get(
    '/connections/:id/databases/:db/collections/:coll/encrypted-fields',
    { preHandler: requireConnection('documents:read'), config: { masking: 'names-only' } },
    async (request) => {
      const { db, coll } = parseInput(CollParams, request.params)
      const client = await clientFor(request, { asStored: true })
      const [info] = await withMongo(() =>
        client.db(db).listCollections({ name: coll }, { nameOnly: false }).toArray(),
      )
      const e = request.connection!.settings.encryption
      return encryptedFields((info?.options ?? {}) as Document, `${db}.${coll}`, {
        schemaMap: e?.enabled ? e.schemaMap : undefined,
        encryptedFieldsMap: e?.enabled ? e.encryptedFieldsMap : undefined,
      })
    },
  )
}
