// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
// Captures explain outputs from a throwaway MongoDB (mongodb-memory-server) as test fixtures for
// the phase 2b normaliser.
//
//   node scripts/capture-explain.mjs                    the package's default MongoDB, into
//                                                       test/fixtures/explain (the 8.2 set)
//   node scripts/capture-explain.mjs --version 7.0.43   that release, into test/fixtures/explain/7.0
//   node scripts/capture-explain.mjs --sharded --bin <dir>
//                                                       a sharded cluster (a config server, two
//                                                       shards, a mongos), into .../8.2-sharded
//   node scripts/capture-explain.mjs --scrub            scrubs the captured fixtures again
//
// W5 (completion §2 W5.4): fixtures from 6.0, 7.0, 8.0 and 8.2 and a sharded cluster. The memory
// server downloads mongod (MONGOMS_VERSION) but no mongos: --bin names a folder holding mongod and
// mongos of one release (from MongoDB's archive for the platform, mongodb.com/try/download). Run on a
// machine that may download; the fixtures carry the version they came from.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { BSON, MongoClient } from 'mongodb'

const { EJSON } = BSON
const HERE = dirname(fileURLToPath(import.meta.url))
const BASE = join(HERE, '..', 'test', 'fixtures', 'explain')

const { values: args } = parseArgs({
  options: {
    version: { type: 'string' },
    sharded: { type: 'boolean', default: false },
    bin: { type: 'string' },
    scrub: { type: 'boolean', default: false },
  },
})

/** The data every capture explains: 3000 items with two indexes, a small joined collection, a view. */
async function seed(client, { sharded }) {
  const db = client.db('shop')
  if (sharded) {
    await client.db('admin').command({ enableSharding: 'shop' })
    await client.db('admin').command({ shardCollection: 'shop.items', key: { n: 1 } })
  }
  const items = db.collection('items')
  await items.insertMany(
    Array.from({ length: 3000 }, (_, n) => ({ n, g: n % 7, s: `s${n % 50}`, tags: [n % 3] })),
  )
  await items.createIndex({ g: 1 })
  await items.createIndex({ g: 1, n: -1 })
  if (sharded) {
    // Two shards each hold a part: the explain answers per shard.
    await client.db('admin').command({ split: 'shop.items', middle: { n: 1500 } })
    await client
      .db('admin')
      .command({ moveChunk: 'shop.items', find: { n: 2000 }, to: 'shard1', _waitForDelete: true })
  }
  await db.collection('other').insertMany([{ k: 1 }, { k: 2 }])
  await db.createCollection('v', { viewOn: 'items', pipeline: [{ $match: { g: 1 } }] })
  return { db, items }
}

function cases({ db, items }) {
  const opts = { maxTimeMS: 30_000 }
  return {
    'find-collscan': () => items.find({ s: 's3' }, opts).explain('executionStats'),
    'find-ixscan': () => items.find({ g: 3, n: { $gt: 100 } }, opts).explain('allPlansExecution'),
    'find-sort': () => items.find({ s: 's3' }, opts).sort({ n: -1 }).explain('executionStats'),
    'find-idhack': () => items.find({ _id: 1 }, opts).explain('executionStats'),
    'find-empty': () => db.collection('none').find({ a: 1 }, opts).explain('executionStats'),
    'find-planner': () => items.find({ g: 3 }, opts).explain('queryPlanner'),
    'find-view': () =>
      db
        .collection('v')
        .find({ n: { $lt: 10 } }, opts)
        .explain('executionStats'),
    'agg-group': () =>
      items
        .aggregate(
          [{ $match: { g: 2 } }, { $group: { _id: '$s', c: { $sum: 1 } } }, { $sort: { c: -1 } }],
          opts,
        )
        .explain('executionStats'),
    'agg-lookup': () =>
      items
        .aggregate(
          [
            { $limit: 5 },
            { $lookup: { from: 'other', localField: 'g', foreignField: 'k', as: 'o' } },
            { $project: { o: 1 } },
          ],
          opts,
        )
        .explain('executionStats'),
    'agg-count': () =>
      items.aggregate([{ $match: { g: 1 } }, { $count: 'n' }], opts).explain('executionStats'),
  }
}

/** The capturing machine's name is no fixture's business. */
// W5 review: nor are the cluster's clock and signature, or the session the capture used.
const DROPPED = new Set(['$clusterTime', 'operationTime', 'lsid'])
const scrub = (value) =>
  Array.isArray(value)
    ? value.map(scrub)
    : value && typeof value === 'object' && value.constructor === Object
      ? Object.fromEntries(
          Object.entries(value)
            .filter(([k]) => !DROPPED.has(k))
            .map(([k, v]) => [k, k === 'host' && typeof v === 'string' ? 'capture-host' : scrub(v)]),
        )
      : value

async function capture(client, out, sharded) {
  const version = (await client.db('admin').command({ buildInfo: 1 })).version
  const seeded = await seed(client, { sharded })
  mkdirSync(out, { recursive: true })
  for (const [name, run] of Object.entries(cases(seeded))) {
    const raw = scrub(await run())
    writeFileSync(
      join(out, `${name}.json`),
      `${EJSON.stringify({ version, ...(sharded ? { sharded: true } : {}), raw }, undefined, 2, { relaxed: false })}\n`,
    )
    console.log(`${out}: ${name} (${version})`)
  }
}

const exe = (dir, name) => join(dir, process.platform === 'win32' ? `${name}.exe` : name)

/** Starts a process and resolves once it says it waits for connections. */
function start(file, argv) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, argv, { stdio: ['ignore', 'pipe', 'pipe'] })
    let seen = ''
    // Review: what it says on stderr too (a refused option, a port in use), and never left running.
    let errors = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`${file} did not start: ${seen.slice(-500)} ${errors.slice(-500)}`))
    }, 60_000)
    child.stderr.on('data', (chunk) => (errors += chunk))
    child.stdout.on('data', (chunk) => {
      seen += chunk
      if (/Waiting for connections|waiting for connections/.test(seen)) {
        clearTimeout(timer)
        resolve(child)
      }
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`${file} exited ${code}: ${seen.slice(-500)} ${errors.slice(-500)}`))
    })
  })
}

async function replSet(port, name, mongod, dir, extra) {
  const path = join(dir, name)
  mkdirSync(path, { recursive: true })
  const child = await start(mongod, [
    '--port',
    String(port),
    '--bind_ip',
    '127.0.0.1',
    '--dbpath',
    path,
    '--replSet',
    name,
    ...extra,
  ])
  // Review: a mongod whose replica set could not start is stopped, not left behind.
  let client
  try {
    client = await MongoClient.connect(`mongodb://127.0.0.1:${port}/?directConnection=true`)
    await client.db('admin').command({
      replSetInitiate: {
        _id: name,
        members: [{ _id: 0, host: `127.0.0.1:${port}` }],
        ...(extra.includes('--configsvr') ? { configsvr: true } : {}),
      },
    })
    for (let i = 0; i < 60; i++) {
      const hello = await client.db('admin').command({ hello: 1 })
      if (hello.isWritablePrimary) break
      await new Promise((r) => setTimeout(r, 500))
    }
  } catch (e) {
    child.kill()
    throw e
  } finally {
    await client?.close()
  }
  return child
}

async function sharded(bin) {
  const dir = mkdtempSync(join(tmpdir(), 'mm-explain-sharded-'))
  const children = []
  const base = 47100 + Math.floor(Math.random() * 500)
  try {
    const mongod = exe(bin, 'mongod')
    children.push(await replSet(base, 'cfg', mongod, dir, ['--configsvr']))
    children.push(await replSet(base + 1, 'shard0', mongod, dir, ['--shardsvr']))
    children.push(await replSet(base + 2, 'shard1', mongod, dir, ['--shardsvr']))
    children.push(
      await start(exe(bin, 'mongos'), [
        '--port',
        String(base + 3),
        '--bind_ip',
        '127.0.0.1',
        '--configdb',
        `cfg/127.0.0.1:${base}`,
      ]),
    )
    const client = await MongoClient.connect(`mongodb://127.0.0.1:${base + 3}`)
    try {
      await client.db('admin').command({ addShard: `shard0/127.0.0.1:${base + 1}`, name: 'shard0' })
      await client.db('admin').command({ addShard: `shard1/127.0.0.1:${base + 2}`, name: 'shard1' })
      const version = (await client.db('admin').command({ buildInfo: 1 })).version
      await capture(client, join(BASE, `${version.split('.').slice(0, 2).join('.')}-sharded`), true)
    } finally {
      await client.close()
    }
  } finally {
    for (const child of children.reverse()) child.kill()
    await new Promise((r) => setTimeout(r, 1000))
    rmSync(dir, { recursive: true, force: true })
  }
}

async function single(version) {
  const server = await MongoMemoryServer.create(version ? { binary: { version } } : {})
  const client = await MongoClient.connect(server.getUri())
  try {
    const out = version ? join(BASE, version.split('.').slice(0, 2).join('.')) : BASE
    await capture(client, out, false)
  } finally {
    await client.close()
    await server.stop()
  }
}

/** Scrubs the fixtures already captured again, as a capture now would (W5 review). */
function scrubAll() {
  for (const dir of [
    BASE,
    ...readdirSync(BASE, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== 'hand')
      .map((d) => join(BASE, d.name)),
  ])
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      const path = join(dir, file)
      const parsed = EJSON.parse(readFileSync(path, 'utf8'), { relaxed: false })
      writeFileSync(path, `${EJSON.stringify(scrub(parsed), undefined, 2, { relaxed: false })}\n`)
      console.log(`scrubbed ${path}`)
    }
}

async function main() {
  if (args.scrub) scrubAll()
  else if (args.sharded) {
    if (!args.bin) throw new Error('--sharded needs --bin <folder with mongod and mongos>')
    await sharded(args.bin)
  } else await single(args.version)
}
main().catch((e) => {
  console.error(e)
  process.exit(1)
})
