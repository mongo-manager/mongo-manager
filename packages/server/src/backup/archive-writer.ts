// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { Writable } from 'node:stream'
import { BSON, EJSON, Long, type Document } from 'bson'
import type { MongoManagerHeader, NamespaceType } from '@mongo-manager/shared'
import { Crc64 } from './crc64'
import { knownVersion } from './series'

export const ARCHIVE_MAGIC = 0x8199e26d
export const TERMINATOR = Buffer.from([0xff, 0xff, 0xff, 0xff])

export interface NamespaceMeta {
  db: string
  coll: string
  type: NamespaceType
  options: Document
  indexes: Document[]
  uuid?: string
}

/** mongodump's metadata text: canonical Extended JSON, options only when there are some. */
export function metadataText(m: NamespaceMeta): string {
  const body: Document = {}
  if (Object.keys(m.options).length) body.options = m.options
  body.indexes = m.indexes
  if (m.uuid) body.uuid = m.uuid
  body.collectionName = m.coll
  body.type = m.type
  return EJSON.stringify(body, { relaxed: false })
}

/**
 * Phase 3d-3a spec §4.1: writes a mongodump archive, one namespace at a time (no interleaving), so
 * `mongorestore --archive` restores it. Writes wait for the output to drain.
 */
export class ArchiveWriter {
  private current: { db: string; coll: string; crc: Crc64 } | null = null

  constructor(private readonly out: Writable) {}

  /**
   * Final review C2: an output destroyed by a failure (the quota, a full disk) never drains, and a
   * write on it emits no second error. A destroyed output fails the write at once, and a wait for
   * drain also ends on close or error, so a backup never hangs.
   */
  private async put(buf: Buffer): Promise<void> {
    const out = this.out
    const closed = () => out.errored ?? new Error('The backup output closed')
    if (out.destroyed) throw closed()
    if (out.write(buf)) return
    await new Promise<void>((resolve, reject) => {
      const settle = (e?: Error | null) => {
        out.off('drain', onDrain)
        out.off('close', onClose)
        out.off('error', onError)
        if (e) reject(e)
        else resolve()
      }
      const onDrain = () => settle()
      const onClose = () => settle(closed())
      const onError = (e: Error) => settle(e)
      out.on('drain', onDrain)
      out.on('close', onClose)
      out.on('error', onError)
    })
  }

  async begin(
    header: { serverVersion: string; toolVersion: string; mongoManager: MongoManagerHeader | null },
    metas: NamespaceMeta[],
  ): Promise<void> {
    const magic = Buffer.alloc(4)
    magic.writeUInt32LE(ARCHIVE_MAGIC)
    await this.put(magic)
    await this.put(
      Buffer.from(
        BSON.serialize({
          concurrent_collections: 1,
          version: '0.1',
          // mongorestore refuses an archive whose server version it cannot parse (as series.ts reads it).
          server_version: knownVersion(header.serverVersion) ? header.serverVersion : '0.0.0',
          tool_version: header.toolVersion,
          ...(header.mongoManager ? { mongoManager: header.mongoManager } : {}),
        }),
      ),
    )
    for (const m of metas)
      await this.put(
        Buffer.from(
          BSON.serialize({ db: m.db, collection: m.coll, metadata: metadataText(m), size: 0, type: m.type }),
        ),
      )
    await this.put(TERMINATOR)
  }

  async open(db: string, coll: string): Promise<void> {
    if (this.current) throw new Error('A namespace is already open')
    this.current = { db, coll, crc: new Crc64() }
    await this.put(Buffer.from(BSON.serialize({ db, collection: coll, EOF: false, CRC: Long.ZERO })))
  }

  async write(raw: Buffer): Promise<void> {
    if (!this.current) throw new Error('No namespace is open')
    this.current.crc.update(raw)
    await this.put(raw)
  }

  async close(): Promise<void> {
    const c = this.current
    if (!c) throw new Error('No namespace is open')
    this.current = null
    await this.put(TERMINATOR)
    await this.put(
      Buffer.from(BSON.serialize({ db: c.db, collection: c.coll, EOF: true, CRC: c.crc.signed() })),
    )
    await this.put(TERMINATOR)
  }

  /** Nothing follows the last namespace's end; this only checks the writer was used fully. */
  async finish(): Promise<void> {
    if (this.current) throw new Error('A namespace is still open')
  }
}
