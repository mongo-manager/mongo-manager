// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { createClient, type PluginContext } from '../../kit/src/client'
import { createRenderer } from './renderer'
import { mount } from './view'
import { mountReferenced } from './referencedView'

/**
 * Plugins wave 2: references. As a cell renderer, the referenced document's name beside an
 * ObjectId; as a collection tab, the fields holding other documents' ObjectIds and the collections
 * those ids are found in (src/view.ts); as a document action, the documents referring to one
 * (src/referencedView.ts).
 */
const client = createClient()

if (client.contribution.kind === 'cellRenderer') {
  let locale = 'en'
  const render = createRenderer((method, params) => client.ask(method, params))
  client.onCells((_renderer, values, asked, paths, place) => render(values, paths, place, asked || locale))
  client.onContext((next) => {
    locale = next
  })
  client.onReady(async () => {
    locale = (await client.ask<PluginContext>('context.get')).locale
  })
} else if (client.contribution.kind === 'documentAction')
  mountReferenced(document.getElementById('app')!, client)
else mount(document.getElementById('app')!, client)
