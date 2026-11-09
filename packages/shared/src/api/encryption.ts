// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { z } from 'zod'
import { CollectionNameSchema } from '../schemas'

/**
 * W8 (completion): CSFLE / Queryable Encryption — data keys (create, list, rewrap) and encrypted
 * collections (Queryable Encryption's createEncryptedCollection with its fields). The key provider
 * credentials live on the connection (sealed); what is asked here only names the master key.
 */
const ENDPOINT = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*(?::\d{1,5})?$/
const text = (max: number) => z.string().trim().min(1).max(max)
const endpoint = z.string().trim().max(255).regex(ENDPOINT, 'host[:port]')

export const MasterKeySchema = z.discriminatedUnion('provider', [
  z.strictObject({ provider: z.literal('local') }),
  z.strictObject({
    provider: z.literal('aws'),
    region: text(64),
    key: text(2048),
    endpoint: endpoint.optional(),
  }),
  z.strictObject({
    provider: z.literal('azure'),
    keyVaultEndpoint: endpoint,
    keyName: text(256),
    keyVersion: text(256).optional(),
  }),
  z.strictObject({
    provider: z.literal('gcp'),
    projectId: text(256),
    location: text(256),
    keyRing: text(256),
    keyName: text(256),
    keyVersion: text(256).optional(),
    endpoint: endpoint.optional(),
  }),
  z.strictObject({
    provider: z.literal('kmip'),
    keyId: text(256).optional(),
    endpoint: endpoint.optional(),
    delegated: z.boolean().optional(),
  }),
])
export type MasterKey = z.infer<typeof MasterKeySchema>

/** A data key's id as the app shows it: its UUID, 32 hex digits. */
export const DataKeyIdSchema = z.string().regex(/^[0-9a-f]{32}$/)

export const CreateDataKeySchema = z.strictObject({
  masterKey: MasterKeySchema,
  keyAltNames: z.array(text(255)).max(10).optional(),
})
export type CreateDataKey = z.infer<typeof CreateDataKeySchema>

/** Rotation: the data keys re-encrypted with another (or the same) master key. None named: all. */
export const RewrapDataKeysSchema = z.strictObject({
  masterKey: MasterKeySchema,
  keyIds: z.array(DataKeyIdSchema).min(1).max(1000).optional(),
})
export type RewrapDataKeys = z.infer<typeof RewrapDataKeysSchema>

/** The BSON types Queryable Encryption encrypts (a range query takes the numeric ones and dates). */
export const QE_BSON_TYPES = [
  'string',
  'int',
  'long',
  'double',
  'decimal',
  'date',
  'objectId',
  'bool',
  'binData',
  'object',
  'array',
] as const
export const QE_RANGE_TYPES = ['int', 'long', 'double', 'decimal', 'date'] as const
export const QE_EQUALITY_TYPES = ['string', 'int', 'long', 'date', 'objectId', 'bool', 'binData'] as const

const FIELD_PATH = /^[^$.\s][^$\s]{0,254}$/

export const EncryptedFieldSchema = z
  .strictObject({
    path: z
      .string()
      .regex(FIELD_PATH, 'A field path (no $, no spaces)')
      .refine((p) => !p.includes('..') && !p.endsWith('.'), 'A field path'),
    bsonType: z.enum(QE_BSON_TYPES),
    queries: z
      .discriminatedUnion('queryType', [
        z.strictObject({
          queryType: z.literal('equality'),
          contention: z.number().int().min(0).max(16).optional(),
        }),
        z.strictObject({
          queryType: z.literal('range'),
          min: z.number().finite().optional(),
          max: z.number().finite().optional(),
          sparsity: z.number().int().min(1).max(4).optional(),
          trimFactor: z.number().int().min(0).max(64).optional(),
          precision: z.number().int().min(0).max(100).optional(),
          contention: z.number().int().min(0).max(16).optional(),
        }),
      ])
      .optional(),
  })
  .superRefine((f, ctx) => {
    const q = f.queries
    if (q?.queryType === 'equality' && !(QE_EQUALITY_TYPES as readonly string[]).includes(f.bsonType))
      ctx.addIssue({
        code: 'custom',
        path: ['queries'],
        message: `An equality query does not take ${f.bsonType}`,
      })
    if (q?.queryType === 'range') {
      if (!(QE_RANGE_TYPES as readonly string[]).includes(f.bsonType))
        ctx.addIssue({
          code: 'custom',
          path: ['queries'],
          message: `A range query does not take ${f.bsonType}`,
        })
      if (q.min !== undefined && q.max !== undefined && q.min >= q.max)
        ctx.addIssue({ code: 'custom', path: ['queries', 'max'], message: 'max must be above min' })
    }
  })
export type EncryptedField = z.infer<typeof EncryptedFieldSchema>

export const CreateEncryptedCollectionSchema = z
  .strictObject({
    name: CollectionNameSchema,
    masterKey: MasterKeySchema,
    fields: z.array(EncryptedFieldSchema).min(1).max(100),
  })
  .superRefine((c, ctx) => {
    const seen = new Set<string>()
    c.fields.forEach((f, i) => {
      // A path and one of its parents cannot both be encrypted.
      for (const other of seen)
        if (other === f.path || other.startsWith(`${f.path}.`) || f.path.startsWith(`${other}.`))
          ctx.addIssue({
            code: 'custom',
            path: ['fields', i, 'path'],
            message: `${f.path} overlaps ${other}`,
          })
      seen.add(f.path)
    })
  })
export type CreateEncryptedCollection = z.infer<typeof CreateEncryptedCollectionSchema>

/** A data key as listed: never its key material. */
export interface DataKeyInfo {
  id: string
  keyAltNames: string[]
  /** For a caller who may not see personal data: how many, not what (they may name people). */
  keyAltNamesHidden?: number
  provider: string
  masterKey: Record<string, unknown>
  createdAt: string | null
  updatedAt: string | null
  status: number | null
}

export type EncryptedFieldKind = 'queryable' | 'deterministic' | 'random'
export interface EncryptedFieldInfo {
  path: string
  kind: EncryptedFieldKind
  bsonType?: string
  queryType?: string
  /** Where it is known from: the server's collection options, or the connection's own maps. */
  source: 'server' | 'connection'
}

/** GET …/encryption: how a connection encrypts (no credential). */
export interface EncryptionSummary {
  enabled: boolean
  /** Whether this server can do it at all (the optional package), and what to do otherwise. */
  available: boolean
  unavailableReason?: string
  mode?: 'auto' | 'decryptOnly'
  keyVaultNamespace?: string
  providers?: string[]
  library?: 'cryptShared' | 'mongocryptd'
}
