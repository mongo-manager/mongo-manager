// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { createClient, type PluginContext } from '../../kit/src/client'
import { binaryAnswer } from './sniff'
import { mount } from './view'

/**
 * Plugins wave 3 (spec §8): binary preview. As a cell renderer, what a binary value holds (from its
 * head, the only part the app sends); as a collection tab and a document action, the images.
 */
const client = createClient()

if (client.contribution.kind === 'cellRenderer') {
  let locale = 'en'
  client.onCells((_renderer, values, asked) => values.map((v) => binaryAnswer(v, asked || locale)))
  client.onContext((next) => {
    locale = next
  })
  client.onReady(async () => {
    locale = (await client.ask<PluginContext>('context.get')).locale
  })
} else mount(document.getElementById('app')!, client)
