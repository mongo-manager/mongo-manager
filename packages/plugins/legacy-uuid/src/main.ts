// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { createClient, type PluginContext } from '../../kit/src/client'
import { uuidAnswer } from './renderer'
import { mount } from './view'

/**
 * Legacy UUIDs (research 2026-10-28). As a cell renderer, a legacy UUID read in each driver's byte
 * order; as a collection tab, the UUID fields of a sample and a finder (src/view.ts).
 */
const client = createClient()

if (client.contribution.kind === 'cellRenderer') {
  let locale = 'en'
  client.onCells((_renderer, values, asked) => values.map((v) => uuidAnswer(v, asked || locale)))
  client.onContext((next) => {
    locale = next
  })
  client.onReady(async () => {
    locale = (await client.ask<PluginContext>('context.get')).locale
  })
} else mount(document.getElementById('app')!, client)
