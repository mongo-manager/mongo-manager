import { describe, expect, it } from 'vitest'
import { PassThrough } from 'node:stream'
import { Binary, Int32, ObjectId, type Document } from 'bson'
import { sqlWriter, type SqlExportDialect } from '../src/transfer/formats/sqlwrite'
import { readSqlDump } from '../src/transfer/formats/sqldump'
import { bsonKind } from '../src/transfer/bson-kind'

/**
 * Data review 2026-10-13 (M9): our own SQL export did not come back into MongoDB — PostgreSQL bytes
 * were written as decode(…) (a function call the reader refuses), an ObjectId _id came back as text
 * (so an upsert into the source duplicated every document), and a nested column "sub.a" failed every
 * row. A dump the app wrote reads back as the documents it held.
 */
async function exportSql(docs: Document[], dialect: SqlExportDialect): Promise<string> {
  const out = new PassThrough()
  out.setEncoding('utf8')
  const parts: string[] = []
  out.on('data', (c: string) => parts.push(c))
  const w = sqlWriter(out, { dialect, table: 'items', rowsPerInsert: 100, transaction: true, fields: null })
  for (const d of docs) await w.write(d)
  await w.end()
  out.end()
  await new Promise((r) => setImmediate(r))
  return parts.join('')
}

async function* text(s: string): AsyncGenerator<string> {
  yield s
}

describe('our own SQL export, read back', () => {
  const id = new ObjectId('652629f0c3e5b2a1d4f0a9b7')
  const docs = [
    { _id: id, sub: { a: new Int32(1), b: 'x' }, bin: new Binary(Buffer.from([1, 2, 255])) },
    { _id: new ObjectId('652629f0c3e5b2a1d4f0a9b8'), sub: { a: new Int32(2), b: 'y' }, bin: null },
  ]
  for (const dialect of ['postgres', 'mysql', 'sqlite'] as const)
    it(`gives back its documents (${dialect})`, async () => {
      const sql = await exportSql(docs, dialect)
      expect(sql).not.toContain('decode(')
      const back: Document[] = []
      for await (const r of readSqlDump(text(sql), { tables: new Set(['items']), primaryKeyAsId: true })) {
        expect(r.record, JSON.stringify(r.record)).not.toHaveProperty('error')
        back.push((r.record as { doc: Document }).doc)
      }
      expect(back).toHaveLength(2)
      const [first] = back
      expect(bsonKind(first!._id)).toBe('ObjectId')
      expect(String(first!._id)).toBe(id.toHexString())
      expect(first!.sub).toMatchObject({ b: 'x' })
      expect(Number((first!.sub as { a: unknown }).a)).toBe(1)
      expect(Buffer.from((first!.bin as Binary).buffer)).toEqual(Buffer.from([1, 2, 255]))
    })

  // Review of the fix (Minor 5): a field one document holds whole and another as a sub-document
  // is one column; a field a document lacks comes back lacking.
  it('gives back a field that is a value in one document and a sub-document in another', async () => {
    const mixed = [
      { _id: new ObjectId('652629f0c3e5b2a1d4f0a9b1'), a: new Int32(1) },
      { _id: new ObjectId('652629f0c3e5b2a1d4f0a9b2'), a: { b: new Int32(2) }, c: 'x' },
    ]
    for (const dialect of ['sqlite', 'postgres'] as const) {
      const sql = await exportSql(mixed, dialect)
      const back: Document[] = []
      for await (const r of readSqlDump(text(sql), { tables: new Set(['items']), primaryKeyAsId: true })) {
        expect(r.record, JSON.stringify(r.record)).not.toHaveProperty('error')
        back.push((r.record as { doc: Document }).doc)
      }
      expect(Number(back[0]!.a)).toBe(1)
      expect(back[0]).not.toHaveProperty('c')
      expect(Number((back[1]!.a as { b: unknown }).b)).toBe(2)
      expect(back[1]!.c).toBe('x')
    }
  })

  // Review of the fix (Minor 4): only a dump that begins with the app's mark is read as its own.
  it('reads as its own only a dump whose first line is the app\u2019s mark', async () => {
    const sql = [
      'CREATE TABLE t (id INTEGER PRIMARY KEY, code CHAR(24));',
      '-- Mongo Manager export',
      "INSERT INTO t VALUES (1, '652629f0c3e5b2a1d4f0a9b7');",
      '',
    ].join('\n')
    const rows: Document[] = []
    for await (const r of readSqlDump(text(sql), { tables: new Set(['t']), primaryKeyAsId: true }))
      rows.push((r.record as { doc: Document }).doc)
    expect(rows[0]!.code).toBe('652629f0c3e5b2a1d4f0a9b7')
  })

  // Review of the fix (Minor 3): a "__proto__" segment, where unusual names are allowed, is data.
  it('keeps a __proto__ segment as data, never as the prototype', async () => {
    const sql = [
      '-- Mongo Manager export',
      'CREATE TABLE "t" ("_id" INTEGER, "__proto__.x" INTEGER, "a.__proto__" INTEGER);',
      'INSERT INTO "t" ("_id", "__proto__.x", "a.__proto__") VALUES (1, 2, 3);',
      '',
    ].join('\n')
    const rows: Document[] = []
    for await (const r of readSqlDump(text(sql), {
      tables: new Set(['t']),
      primaryKeyAsId: true,
      allowUnusual: true,
    }))
      rows.push((r.record as { doc: Document }).doc)
    const doc = rows[0]!
    expect(Object.getPrototypeOf(doc)).toBe(Object.prototype)
    expect(Object.getOwnPropertyDescriptor(doc, '__proto__')?.value).toMatchObject({ x: 2 })
    expect(Object.getOwnPropertyDescriptor(doc.a as object, '__proto__')?.value).toBe(3)
  })

  it('reads a dump of another tool as it did: a CHAR(24) text stays text, a dotted name is refused', async () => {
    const sql = [
      'CREATE TABLE t (id INTEGER PRIMARY KEY, code CHAR(24), "a.b" INTEGER);',
      "INSERT INTO t VALUES (1, '652629f0c3e5b2a1d4f0a9b7', 1);",
      '',
    ].join('\n')
    const back: unknown[] = []
    for await (const r of readSqlDump(text(sql), { tables: new Set(['t']), primaryKeyAsId: true }))
      back.push(r.record)
    expect(back[0]).toHaveProperty('error')
    const plain = [
      'CREATE TABLE t (id INTEGER PRIMARY KEY, code CHAR(24));',
      "INSERT INTO t VALUES (1, '652629f0c3e5b2a1d4f0a9b7');",
      '',
    ].join('\n')
    const rows: Document[] = []
    for await (const r of readSqlDump(text(plain), { tables: new Set(['t']), primaryKeyAsId: true }))
      rows.push((r.record as { doc: Document }).doc)
    expect(rows[0]!.code).toBe('652629f0c3e5b2a1d4f0a9b7')
  })
})
