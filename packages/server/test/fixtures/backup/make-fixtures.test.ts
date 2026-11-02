import { describe, expect, it } from 'vitest'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { Binary, Decimal128, Long, MongoClient, ObjectId, Timestamp } from 'mongodb'
import { execFileSync } from 'node:child_process'
import { once } from 'node:events'
import {
  createWriteStream,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixturesDir, mongoTools } from '../../support/mongo-tools'
import { readArchive } from '../../../src/backup/archive-reader'
import { ZipWriter } from '../../../src/transfer/formats/zip'

/**
 * Plan ruling 11: real-tool fixtures for the readers, generated once and committed. Run with
 *   MM_MAKE_FIXTURES=1 npx vitest run test/fixtures/backup/make-fixtures.test.ts
 * (skipped otherwise: the fixtures must not change under a normal test run). Interleaved archives
 * are tested live (backup-interop.test.ts) and by hand-built bytes, not by a large fixture.
 */
describe.skipIf(!process.env.MM_MAKE_FIXTURES)('backup fixtures', () => {
  it('writes the mongodump fixtures', { timeout: 300_000 }, async () => {
    const tools = await mongoTools()
    if (!tools) throw new Error('the tools are needed to make fixtures')
    const server = await MongoMemoryServer.create()
    const uri = server.getUri()
    const c = await new MongoClient(uri).connect()
    try {
      const shop = c.db('shop')
      await shop.collection('orders').insertMany([
        {
          _id: 1 as never,
          s: 'é𝄞',
          l: Long.fromNumber(2 ** 40),
          d: Decimal128.fromString('1.10'),
          b: new Binary(Buffer.from([0, 1])),
          t: new Timestamp({ t: 1, i: 2 }),
        },
        { _id: new ObjectId() as never, email: 'a@x', n: null, a: [1, [2, [3]]] },
      ])
      await shop
        .collection('orders')
        .createIndex({ email: 1 }, { name: 'email_1', unique: true, sparse: true })
      await shop.collection('orders').createIndex({ at: 1 }, { name: 'at_ttl', expireAfterSeconds: 3600 })
      await shop.createCollection('empty')
      await shop.createCollection('capped', { capped: true, size: 4096 })
      await shop.createCollection('v', { viewOn: 'orders', pipeline: [{ $match: { n: null } }] })
      await shop.createCollection('ts', { timeseries: { timeField: 't', metaField: 'm' } })
      await shop.collection('ts').insertMany([
        { t: new Date(0), m: 1, x: 1 },
        { t: new Date(1000), m: 1, x: 2 },
      ])

      const run = (args: string[]) => execFileSync(tools.dump, [`--uri=${uri}`, ...args], { stdio: 'pipe' })
      run([`--archive=${join(fixturesDir, 'shop.archive')}`, '--db=shop'])
      run([`--archive=${join(fixturesDir, 'shop.archive.gz')}`, '--db=shop', '--gzip'])
      const out = mkdtempSync(join(tmpdir(), 'mm-dir-'))
      run([`--out=${out}`, '--db=shop'])

      // The directory as a zip, under a "dump/" folder, as people usually zip it.
      const zipPath = join(fixturesDir, 'shop-dir.zip')
      const file = createWriteStream(zipPath)
      const zip = new ZipWriter(file)
      for (const name of readdirSync(join(out, 'shop')))
        await zip.add(`dump/shop/${name}`, readFileSync(join(out, 'shop', name)))
      await zip.finish()
      file.end()
      await once(file, 'close')
      rmSync(out, { recursive: true, force: true })

      const counts: Record<string, number> = {}
      for (const coll of ['orders', 'empty', 'capped', 'ts'])
        counts[`shop.${coll}`] = await shop.collection(coll).countDocuments()
      // The reader must accept what the tool wrote.
      let docs = 0
      const archive = readFileSync(join(fixturesDir, 'shop.archive'))
      for await (const e of readArchive(
        (async function* () {
          yield archive
        })(),
      ))
        if (e.kind === 'doc') docs++
      writeFileSync(
        join(fixturesDir, 'fixtures.json'),
        `${JSON.stringify({ tools: tools.version, counts }, null, 2)}\n`,
      )
      console.log('fixture documents:', docs, 'zip bytes:', statSync(zipPath).size)
      expect(docs).toBeGreaterThan(0)
    } finally {
      await c.close()
      await server.stop()
    }
  })
})
