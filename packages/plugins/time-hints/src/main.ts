import { createClient, type PluginContext } from '../../kit/src/client'
import { hint } from './hints'

/**
 * Plugins wave 1: time hints. A cell renderer only (a hidden frame): it answers the app's questions
 * about ObjectIds and numbers with the moment they stand for, in the app's language.
 */
const client = createClient()
let locale = 'en'
// The language the app asks in, so an answer is never kept in another one (wave 1 review M8).
client.onCells((_renderer, values, asked) => values.map((v) => hint(v, asked || locale)))
client.onContext((next) => {
  locale = next
})
client.onReady(async () => {
  locale = (await client.ask<PluginContext>('context.get')).locale
})
