// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { FastifyInstance } from 'fastify'
import { databaseRoutes } from './databases'
import { collectionRoutes } from './collections'
import { documentReadRoutes, documentWriteRoutes } from './documents'
import { bulkRoutes } from './bulk'
import { indexRoutes } from './indexes'
import { searchIndexRoutes } from './search-indexes'
import { recentQueryRoutes } from './recent'
import { serverRoutes } from './server'
import { schemaRoutes } from './schema'
import { aggregateRoutes } from './aggregate'
import { pipelineRoutes } from './pipelines'
import { explainRoutes } from './explain'
import { validationRoutes } from './validation'
import { preImageRoutes } from './preimages'
import { favouriteRoutes } from './favourites'
import { libraryRoutes } from './library'
import { shellHistoryRoutes } from './shell'
import { snippetRoutes } from './snippets'
import { personalFieldRoutes } from './personal-fields'
import { profilerRoutes } from './profiler'
import { slowQueryRoutes } from './slow-queries'
import { historyRoutes } from './history'
import { shardingRoutes } from './sharding'
import { indexAdviceRoutes } from './index-advice'
import { transferRoutes } from './transfer'
import { copyRoutes } from './copy'
import { gridfsRoutes } from './gridfs'
import { databaseAccessRoutes } from './database-access'
import { encryptionRoutes } from './encryption'
import { modelRoutes } from './model'
import { drillLeftoverRoutes } from './drill-leftovers'
import { storageRoutes } from './storage'

export async function dataRoutes(app: FastifyInstance): Promise<void> {
  await app.register(databaseRoutes)
  await app.register(drillLeftoverRoutes)
  // Phase 4b §1.
  await app.register(gridfsRoutes)
  await app.register(collectionRoutes)
  await app.register(documentReadRoutes)
  await app.register(documentWriteRoutes)
  await app.register(bulkRoutes)
  await app.register(indexRoutes)
  // W2.6: Atlas Search and Vector Search indexes.
  await app.register(searchIndexRoutes)
  await app.register(recentQueryRoutes)
  await app.register(serverRoutes)
  await app.register(schemaRoutes)
  await app.register(aggregateRoutes)
  await app.register(pipelineRoutes)
  await app.register(explainRoutes)
  await app.register(validationRoutes)
  // W4.7: pre- and post-images from the Watch page.
  await app.register(preImageRoutes)
  await app.register(favouriteRoutes)
  await app.register(libraryRoutes)
  await app.register(shellHistoryRoutes)
  await app.register(snippetRoutes)
  await app.register(personalFieldRoutes)
  await app.register(profilerRoutes)
  await app.register(slowQueryRoutes)
  await app.register(historyRoutes)
  await app.register(shardingRoutes)
  await app.register(indexAdviceRoutes)
  // Plugins wave 4: storage, compact, a shard key's analysis.
  await app.register(storageRoutes)
  await app.register(transferRoutes)
  await app.register(copyRoutes)
  // W3.1: MongoDB's users and roles.
  await app.register(databaseAccessRoutes)
  // W8: client-side encryption (data keys, encrypted collections, encrypted fields).
  await app.register(encryptionRoutes)
  // W6.4: a database's data model.
  await app.register(modelRoutes)
}
