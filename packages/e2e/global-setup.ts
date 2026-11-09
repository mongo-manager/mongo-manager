// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { MongoClient } from 'mongodb'
import { MongoMemoryReplSet, MongoMemoryServer } from 'mongodb-memory-server'
import { resolveConfig } from '../server/src/config'
import { startServer } from '../server/src/server'
import { LOCAL_PORT, PORT } from './playwright.config'

/** Phase 4b §4: the first-party plugins, as built in the monorepo (`pnpm build`). */
const PLUGINS = join(import.meta.dirname, '..', 'plugins', 'dist')

/**
 * CI 2026-10-20: the offline run's MongoDB went unanswered (getaddrinfo EAI_AGAIN mongo, the whole
 * run long), and every test that needed it failed one by one. The run starts once it answers, or
 * fails at once saying why. Its host only is said: the address may hold a password.
 */
async function untilAnswers(uri: string, withinMs = 60_000): Promise<void> {
  const deadline = Date.now() + withinMs
  for (;;) {
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 2_000, connectTimeoutMS: 2_000 })
    let failure: unknown
    try {
      await client.connect()
      await client.db('admin').command({ ping: 1 })
      return
    } catch (e) {
      failure = e
    } finally {
      await client.close().catch(() => undefined)
    }
    if (Date.now() >= deadline)
      throw new Error(
        `The MongoDB at ${new URL(uri).host} did not answer within ${withinMs / 1000} s: ${(failure as Error).message}`,
        { cause: failure },
      )
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
}

/**
 * A real server (team mode) on the built web app, with its own MongoDB — or, in the offline run,
 * the MongoDB container given by MM_E2E_EXTERNAL_MONGO_URI (nothing is downloaded there).
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const external = process.env.MM_E2E_EXTERNAL_MONGO_URI
  if (external) await untilAnswers(external)
  const mongo = external
    ? { getUri: () => external, stop: async () => true }
    : await MongoMemoryServer.create()
  // Phase 3e-1: change streams need a replica set. The main MongoDB stays standalone (the Watch
  // section's "standalone" state is tested against it); the offline run brings its own or skips.
  // W5 (completion §2 W5.4): MM_E2E_MEMORY_RS=1 starts the memory server's replica set beside an
  // external MongoDB too (the offline run, from a mongod fetched before the network went away), and
  // MM_E2E_REQUIRE_RS=1 (CI) makes a run without one fail instead of skipping Watch and Live sync.
  const externalRs = process.env.MM_E2E_EXTERNAL_RS_URI
  const rs = externalRs
    ? { getUri: () => externalRs, stop: async () => true }
    : !external || process.env.MM_E2E_MEMORY_RS === '1'
      ? await MongoMemoryReplSet.create({ replSet: { count: 1 } })
      : null
  if (!rs && process.env.MM_E2E_REQUIRE_RS === '1')
    throw new Error(
      'MM_E2E_REQUIRE_RS=1: a replica set is required (MM_E2E_EXTERNAL_RS_URI, or MM_E2E_MEMORY_RS=1)',
    )
  const dataDir = mkdtempSync(join(tmpdir(), 'mm-e2e-'))
  // Phase 3d-3b: the one folder server-folder destinations may use.
  const destRoot = mkdtempSync(join(tmpdir(), 'mm-e2e-dest-'))
  // Phase 4a-1: a fake OpenAI-compatible provider on loopback (allowed through MM_AI_PRIVATE_NETWORKS).
  const ai = await startFakeProvider()
  const server = await startServer(
    resolveConfig({
      cli: {
        dataDir,
        webPort: PORT,
        host: '127.0.0.1',
        auth: true,
        logLevel: 'warn',
        bundledPluginsDir: PLUGINS,
      },
      // Each shell test's session outlives its page for the reconnect grace (2 min), so the default
      // 3 shells per user would refuse the later shell tests of one run. Only the test server gets more.
      // The whole suite runs from one address within a few minutes: well above a person's budget.
      env: {
        MM_SHELL_MAX_PER_USER: '10',
        MM_API_RATE_LIMIT: '5000',
        MM_BACKUP_FOLDER_ROOTS: destRoot,
        MM_AI_PRIVATE_NETWORKS: '127.0.0.1/32',
        // The UI review asks far more than a person would in a minute.
        MM_AI_PER_MINUTE: '120',
        MM_AI_PER_DAY: '10000',
      },
    }),
  )
  // Local mode (no accounts) on its own port and data directory, for the "local" project.
  const localDir = mkdtempSync(join(tmpdir(), 'mm-e2e-local-'))
  const local = await startServer(
    resolveConfig({
      cli: {
        dataDir: localDir,
        webPort: LOCAL_PORT,
        host: '127.0.0.1',
        auth: false,
        logLevel: 'warn',
        bundledPluginsDir: PLUGINS,
      },
    }),
  )
  process.env.MM_E2E_SETUP_TOKEN = server.setupToken ?? ''
  // Security audit 2026-10-16: local mode opens from a launch link made from this directory's secret.
  process.env.MM_E2E_LOCAL_DIR = localDir
  process.env.MM_E2E_MONGO_URI = mongo.getUri()
  process.env.MM_E2E_RS_URI = rs?.getUri() ?? ''
  process.env.MM_E2E_DEST_ROOT = destRoot
  process.env.MM_E2E_AI_URL = ai.url
  return async () => {
    await server.close()
    await local.close()
    await ai.close()
    await mongo.stop()
    await rs?.stop()
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(localDir, { recursive: true, force: true })
    rmSync(destRoot, { recursive: true, force: true })
  }
}

async function startFakeProvider(): Promise<{ url: string; close(): Promise<void> }> {
  // Phase 4a-2: a chat answers with how many earlier messages it was given, so history shows end to end.
  const chatAnswer = (messages: Array<{ content: string }>): string => {
    const latest = messages.at(-1)?.content ?? ''
    const seen = `I can see ${Math.max(0, messages.length - 2)} earlier messages.`
    // User request 2026-10-13: the output asked for as a file, offered as an export.
    if (/as a csv/i.test(latest))
      return `${seen} Here is the file:\n\`\`\`json\n{ "filter": { "qty": { "$gt": 5 } }, "export": "csv" }\n\`\`\``
    if (/over five/i.test(latest))
      return `${seen} Orders over five:\n\`\`\`json\n{ "filter": { "qty": { "$gt": 5 } }, "sort": { "qty": -1 } }\n\`\`\``
    return `${seen} This collection holds **orders**: \`qty\` and \`status\`.`
  }
  const answer = (system: string): string => {
    if (system.includes('aggregation pipeline'))
      return 'Counts orders by status:\n```json\n[{ "$match": { "qty": { "$gt": 5 } } }, { "$group": { "_id": "$status", "n": { "$sum": 1 } } }]\n```'
    if (system.includes('find query'))
      return 'Orders over five:\n```json\n{ "filter": { "qty": { "$gt": 5 } }, "sort": { "qty": -1 } }\n```'
    if (system.includes('validator'))
      return 'Quantity required:\n```json\n{ "$jsonSchema": { "required": ["qty"] } }\n```'
    if (system.includes('may be slow'))
      return 'It scans every order: an index on **qty** helps.\n```json\n{ "indexes": [{ "keys": { "qty": 1 } }] }\n```'
    return '## Orders\nEach document is an **order**:\n- `qty`: a number\n- `status`: a word\n\nNothing odd.'
  }
  /**
   * W6.3: the agent, scripted for the user report of 2026-10-16 ("add a new collection named users to
   * the Sales Mongo connection and add a demo user"): it finds the connection by name in what it was
   * given, uses its default database (saying so), proposes the collection, then the demo user, and
   * says what was done — each step after the result of the one before.
   */
  /**
   * The AI database manager (design 2026-10-25, wave A): each scenario by the words that ask for it,
   * each step after the result of the one before (this turn's results only).
   */
  type AgentReply = { text: string; calls: Array<{ name: string; args: object }> }
  const managerAnswer = (messages: Array<{ role: string; content: string | null }>): AgentReply | null => {
    const asked = messages.map((m) => m.role).lastIndexOf('user')
    const request = String(messages[asked]?.content ?? '')
    const results = messages
      .slice(asked + 1)
      .filter((m) => m.role === 'tool')
      .map((m) => String(m.content))
    const call = (name: string, args: object, text = ''): AgentReply => ({ text, calls: [{ name, args }] })
    const done = (r: string | undefined) => !!r?.includes('"done":true')
    const words = request.slice(0, request.indexOf('<data>') >>> 0)
    // A5: a connection checked.
    if (/is local test up/i.test(words))
      return results.length === 0
        ? call('check_connection', { connection: 'Local test' })
        : {
            text: results[0]!.includes('"connected":true')
              ? 'Local test answers.'
              : 'Local test cannot be reached.',
            calls: [],
          }
    // A1: documents shown in the app, from a find the agent wrote.
    if (/show me the big orders/i.test(words))
      return results.length === 0
        ? call('open_in_app', {
            connection: 'Local test',
            database: 'shop',
            collection: 'orders',
            filter: '{ "qty": { "$gt": 5 } }',
          })
        : {
            text: results[0]!.includes('"opened":true')
              ? 'Here they are, in the app.'
              : 'They could not be shown.',
            calls: [],
          }
    // A3: a backup started, then followed by its job.
    // User request 2026-10-26: a backup made without a password, then downloaded from its step.
    if (/back up e2emgr and download/i.test(words))
      return results.length === 0
        ? call('run_backup', { connection: 'Local test', database: 'e2emgr' })
        : { text: 'Backed up: download it from the step.', calls: [] }
    if (/back up e2emgr now/i.test(words)) {
      if (results.length === 0)
        return call('run_backup', {
          connection: 'Local test',
          database: 'e2emgr',
          format: 'archive',
          destinations: ['Manager disk'],
        })
      const job = /"job":"([0-9a-f-]{36})"/.exec(results[0]!)?.[1]
      if (results.length === 1)
        return job
          ? call('get_job', { job }, 'Started; its job:')
          : { text: 'The backup did not start.', calls: [] }
      return {
        text: results[1]!.includes('"state":"') ? 'I am following the backup.' : 'Its job could not be read.',
        calls: [],
      }
    }
    // A4: a schedule in the person's time zone (none given: the turn's).
    if (/every monday/i.test(words))
      return results.length === 0
        ? call('create_backup_schedule', {
            connection: 'Local test',
            name: 'Weekly e2emgr',
            database: 'e2emgr',
            cadence: '{"kind":"weekly","days":[1],"time":"03:00"}',
            destinations: ['Manager disk'],
            format: 'archive',
          })
        : { text: done(results[0]) ? 'Scheduled.' : 'It was not scheduled.', calls: [] }
    // Wave B (design 2026-10-25): the whole of backups, the server, users, results, context, words.
    const told = (r: string | undefined) => !!r && !r.includes('"refused"')
    // B5: documents found, shown in the step from the person's own read.
    if (/find the e2emgr items/i.test(words))
      return results.length === 0
        ? call('find_documents', { connection: 'Local test', database: 'e2emgr', collection: 'items' })
        : { text: told(results[0]) ? 'Found them.' : 'They could not be read.', calls: [] }
    // B3: the server's health.
    if (/how is local test doing/i.test(words))
      return results.length === 0
        ? call('server_status', { connection: 'Local test' })
        : { text: told(results[0]) ? 'The server answers.' : 'Its status could not be read.', calls: [] }
    // B1: a schedule paused on its card.
    if (/pause the weekly e2emgr/i.test(words))
      return results.length === 0
        ? call('pause_schedule', { schedule: 'Weekly e2emgr' })
        : { text: done(results[0]) ? 'Paused.' : 'It was not paused.', calls: [] }
    // B4: a user made on its card (its password typed there); a role over the deployment refused.
    if (/add a reporting user/i.test(words))
      return results.length === 0
        ? call('create_user', {
            connection: 'Local test',
            database: 'e2emgr',
            user: 'reporter',
            roles: ['read'],
          })
        : { text: done(results[0]) ? 'User created.' : 'The user was not created.', calls: [] }
    if (/make a root user/i.test(words))
      return results.length === 0
        ? call('create_user', {
            connection: 'Local test',
            database: 'e2emgr',
            user: 'boss',
            roles: ['root@admin'],
          })
        : { text: 'That one is not mine to give.', calls: [] }
    // B2: the latest backup of e2emgr restored into another database, its name typed.
    if (/restore the e2emgr backup/i.test(words)) {
      if (results.length === 0) return call('list_backups', { connection: 'Local test' })
      const name = /"name":"(e2emgr[^"]*)"/.exec(results[0]!)?.[1]
      if (results.length === 1)
        return name
          ? call('restore_backup', { backup: name, connection: 'Local test', database: 'e2erestored' })
          : { text: 'There is no backup of e2emgr.', calls: [] }
      return { text: done(results[1]) ? 'Restored.' : 'It was not restored.', calls: [] }
    }
    // B7: the page the person is on, as the turn's focus says it.
    if (/what is this page/i.test(words)) {
      const data = JSON.parse(request.slice(request.indexOf('<data>') + 6, request.indexOf('</data>'))) as {
        focus?: { page?: string }
      }
      return { text: `You are on ${data.focus?.page ?? 'no page I know'}.`, calls: [] }
    }
    // Wave C (design 2026-10-25): export, values, copy and rename, a plan, a backup first, a report.
    const at = { connection: 'Local test', database: 'e2emgr' }
    // C1: the items exported on a card.
    if (/export the e2emgr items/i.test(words))
      return results.length === 0
        ? call('export_documents', { ...at, collection: 'items', format: 'csv' })
        : { text: done(results[0]) ? 'Exported.' : 'It was not exported.', calls: [] }
    // C2: a field's distinct values, counted.
    if (/which labels do the e2emgr items have/i.test(words))
      return results.length === 0
        ? call('distinct_values', { ...at, collection: 'items', field: 'label' })
        : { text: told(results[0]) ? 'Counted them.' : 'They could not be counted.', calls: [] }
    // C3: the items copied, then the copy renamed on its typed card.
    if (/copy the e2emgr items/i.test(words))
      return results.length === 0
        ? call('copy_collection', { ...at, collection: 'items', toCollection: 'itemscopy' })
        : { text: done(results[0]) ? 'Copied.' : 'It was not copied.', calls: [] }
    if (/rename the e2emgr copy/i.test(words))
      return results.length === 0
        ? call('rename_collection', { ...at, collection: 'itemscopy', to: 'itemsold' })
        : { text: done(results[0]) ? 'Renamed.' : 'It was not renamed.', calls: [] }
    // C4: two changes shown first as a plan, each on its card in order.
    if (/set up the e2emgr archive/i.test(words)) {
      if (results.length === 0)
        return call('plan_changes', {
          title: 'The e2emgr archive',
          changes: [
            { tool: 'create_collection', about: 'A collection for the archive' },
            { tool: 'create_collection', about: 'One for its log' },
          ],
        })
      if (results.length === 1) return call('create_collection', { ...at, collection: 'archive' })
      if (results.length === 2)
        return done(results[1])
          ? call('create_collection', { ...at, collection: 'archivelog' })
          : { text: 'The plan stopped.', calls: [] }
      return { text: done(results[2]) ? 'Set up.' : 'The plan stopped.', calls: [] }
    }
    // C4: a drop that loses data, its collection backed up first from the card.
    if (/drop the e2emgr archive log/i.test(words))
      return results.length === 0
        ? call('drop_collection', { ...at, collection: 'archivelog' })
        : { text: done(results[0]) ? 'Dropped.' : 'It was not dropped.', calls: [] }
    // C7: a scheduled report made on a card.
    if (/report the e2emgr items every morning/i.test(words))
      return results.length === 0
        ? call('create_report', {
            connection: 'Local test',
            name: 'Morning items',
            counts: [{ label: 'Items', database: 'e2emgr', collection: 'items' }],
            cadence: '{"kind":"daily","times":["09:00"]}',
            timeZone: 'UTC',
          })
        : { text: done(results[0]) ? 'Report made.' : 'The report was not made.', calls: [] }
    // README and landing page media (2026-10-31): the made-up store's questions, as the tour asks them.
    const store = { connection: 'Acme Store', database: 'acme', collection: 'orders' }
    // A question answered from an aggregation the agent writes and runs (a read: no card).
    if (/which sales channel/i.test(words)) {
      if (results.length === 0)
        return call(
          'run_aggregation',
          {
            ...store,
            pipeline: JSON.stringify([
              { $match: { status: { $in: ['paid', 'shipped'] } } },
              { $group: { _id: '$channel', orders: { $sum: 1 }, revenue: { $sum: '$total' } } },
              { $sort: { revenue: -1 } },
            ]),
            limit: 10,
          },
          'I will add up the paid and shipped orders of acme.orders by channel.',
        )
      // Each document comes as JSON text inside the result's JSON: read with its escapes taken out.
      const rows = [
        ...results[0]!
          .replace(/\\/g, '')
          .matchAll(/"_id":"(\w+)","orders":(\d+),"revenue":\{"\$numberDecimal":"([\d.]+)"\}/g),
      ].map(([, channel, orders, revenue]) => ({ channel, orders, revenue: Math.round(Number(revenue)) }))
      if (!rows.length) return { text: 'The orders could not be added up.', calls: [] }
      const euros = (n: number) => `€${n.toLocaleString('en-US')}`
      return {
        text:
          `**${rows[0]!.channel}** brings in the most: ${euros(rows[0]!.revenue)} from ${rows[0]!.orders} orders.\n\n` +
          rows.map((r) => `- **${r.channel}**: ${euros(r.revenue)} from ${r.orders} orders`).join('\n'),
        calls: [],
      }
    }
    // A change proposed on a card, made only once it is confirmed.
    if (/berlin marketplace orders faster/i.test(words))
      return results.length === 0
        ? call(
            'create_index',
            { ...store, keys: JSON.stringify({ channel: 1, 'customer.city': 1 }) },
            'That query reads all 1,200 orders to find a few. An index on channel and customer.city takes it straight to them:',
          )
        : {
            text: done(results[0])
              ? 'Done: the index is being built, and the query will use it.'
              : 'The index was not created.',
            calls: [],
          }
    return null
  }
  const agentAnswer = (
    messages: Array<{ role: string; content: string | null }>,
  ): { text: string; calls: Array<{ name: string; args: object }> } => {
    const results = messages.filter((m) => m.role === 'tool').map((m) => String(m.content))
    const request = String(messages.filter((m) => m.role === 'user').at(-1)?.content ?? '')
    const data = JSON.parse(request.slice(request.indexOf('<data>') + 6, request.indexOf('</data>'))) as {
      connections: Array<{ name: string; defaultDatabase: string | null }>
    }
    const sales = data.connections.find((c) => c.name === 'Sales Mongo')
    if (!sales) return { text: 'There is no Sales Mongo connection among the ones I may use.', calls: [] }
    const db = sales.defaultDatabase
    if (!db) return { text: 'Which database of Sales Mongo should I use?', calls: [] }
    const where = { connection: 'Sales Mongo', database: db, collection: 'users' }
    if (results.length === 0)
      return {
        text: `I will create users in ${db}, the default database of Sales Mongo.`,
        calls: [{ name: 'create_collection', args: where }],
      }
    if (results.length === 1)
      return results[0]!.includes('"done":true')
        ? {
            text: 'Now the demo user.',
            calls: [
              {
                name: 'insert_documents',
                args: { ...where, documents: '[{ "name": "Demo User", "email": "demo.user@example.com" }]' },
              },
            ],
          }
        : { text: 'The collection was not created.', calls: [] }
    return results[1]!.includes('"done":true')
      ? { text: `Done: users was created in ${db} on Sales Mongo, with a demo user.`, calls: [] }
      : { text: 'The demo user was not added.', calls: [] }
  }
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as {
      messages?: Array<{ role: string; content: string }>
      tools?: unknown[]
    }
    const messages = body.messages ?? []
    const system = messages[0]?.content ?? ''
    const agent = body.tools ? (managerAnswer(messages) ?? agentAnswer(messages)) : null
    const text = agent
      ? agent.text
      : system.includes('in a conversation')
        ? chatAnswer(messages)
        : answer(system)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const piece of text.match(/.{1,12}/gsu) ?? []) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`)
      await new Promise((r) => setTimeout(r, 15))
    }
    // As a real server streams them (W6.3 security review): the first piece names the call, the
    // arguments' JSON follows in pieces, and the choice ends with its finish reason.
    const delta = (d: object, finish: string | null = null) =>
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: d, finish_reason: finish }] })}\n\n`)
    for (const [index, call] of (agent?.calls ?? []).entries()) {
      const args = JSON.stringify(call.args)
      const pieces = args.match(/.{1,9}/gsu) ?? ['']
      delta({
        tool_calls: [
          {
            index,
            id: `call_${messages.length}_${index}`,
            type: 'function',
            function: { name: call.name, arguments: '' },
          },
        ],
      })
      for (const piece of pieces) {
        delta({ tool_calls: [{ index, function: { arguments: piece } }] })
        await new Promise((r) => setTimeout(r, 5))
      }
    }
    delta({}, agent?.calls.length ? 'tool_calls' : 'stop')
    res.write(
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 120, completion_tokens: 40 } })}\n\n`,
    )
    res.end('data: [DONE]\n\n')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise((r) => server.close(() => r())),
  }
}
