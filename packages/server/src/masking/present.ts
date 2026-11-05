// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { randomBytes } from 'node:crypto'
import type { FastifyRequest } from 'fastify'
import type { Document } from 'mongodb'
import { hashDocument, toClientDocument, type DocumentItem } from '../data/ejson-io'
import { maskDocument } from './document'
import type { NsMasker } from './match'
import { maskerFor } from './request'

/** Phase 3c §4.2: an item with the output masker applied; the pin is always of the real document. */
export function maskItem(item: DocumentItem, output: NsMasker | null): DocumentItem {
  if (!output?.any) return item
  // Data review 2026-10-13 (M3): a caution could tell what a hidden value holds; masked, there is none.
  if ('document' in item) return { document: maskDocument(item.document, output), hash: item.hash }
  const id = (maskDocument({ _id: item.unsupported._id }, output) as { _id: unknown })._id
  // Round 2 (M12): why a document cannot be shown can name a hidden field and quote its value.
  return { unsupported: { _id: id, reason: 'This document cannot be shown here' } }
}

export interface Presenter {
  item(doc: Document): DocumentItem
  hash(doc: Document): string
}

export interface PresentOptions {
  /** The namespace the documents were read from: a pin is bound to it. */
  ns: string
  /**
   * The documents are whole stored documents of `ns` (a find without projection on a collection,
   * a single document): only those get a real pin for a restricted user. Anything a query built
   * could be shaped to confirm a guess by its pin (final review C3), so it gets a random one:
   * such documents cannot be edited by pin anyway.
   */
  stored: boolean
}

/** How this request shows documents: pinned with the server key, masked by `output` when given. */
export function presenterFor(
  request: FastifyRequest,
  output: NsMasker | null,
  opts: PresentOptions,
): Presenter {
  const key = request.server.ctx.docPinKey
  const real = (doc: Document) => hashDocument(doc, key, opts.ns)
  const hash = !opts.stored && maskerFor(request) ? () => randomBytes(32).toString('hex') : real
  return {
    hash: real,
    item: (doc) => maskItem(toClientDocument(doc, hash), output),
  }
}
