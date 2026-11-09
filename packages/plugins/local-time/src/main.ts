// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { createClient, type PluginContext } from '../../kit/src/client'
import { answerFor, type LocalTimeSettings } from './answer'

/**
 * Plugins wave 3 (spec §8a): local time. A cell renderer only (a hidden frame): it answers the app's
 * questions about dates with the date in the user's local time, beside the value or in its
 * tooltip as its settings say.
 */
const client = createClient()
let locale = 'en'
let settings: LocalTimeSettings = {}
// Its settings are read before a question is answered: an answer made without them would be kept.
const loaded = new Promise<void>((resolve) =>
  client.onReady(async () => {
    try {
      const context = await client.ask<PluginContext>('context.get')
      locale = context.locale
      settings = context.settings
    } finally {
      resolve()
    }
  }),
)
client.onCells(async (renderer, values, asked) => {
  await loaded
  return values.map((v) => answerFor(renderer, v, asked || locale, settings, Date.now()))
})
client.onContext((next) => {
  locale = next
})
