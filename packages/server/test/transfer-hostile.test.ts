// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Readable, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { gzipSync } from 'node:zlib'
import { startMongo, type TestMongo } from './support/mongo'
import { dataHarness, teamHarness, type DataHarness } from './support/data'
import { waitJob } from './support/jobs'
import { hostile, rawZip } from './support/hostile'
import { fuzz } from './support/fuzz'
import { boundedGunzip } from '../src/transfer/gzip'
import { decodeText } from '../src/transfer/text'
import { docSource } from '../src/transfer/formats/json'
import { ndjsonLines } from '../src/transfer/formats/ndjson'
import { slow } from './support/slowness'

/** Phase 3d-1 spec §7, §10: hostile files through the routes; the server answers and stays up. */
let mongo: TestMongo
let h: DataHarness
beforeAll(async () => {
  mongo = await startMongo()
}, slow(120_000))
afterAll(async () => {
  await mongo?.stop()
})
beforeEach(async () => {
  h = await dataHarness(mongo)
})
afterEach(async () => {
  await h.t.close()
})

const NS = '/databases/hostile/collections/c'
const upload = async (bytes: Buffer): Promise<string> => {
  const res = await h.raw('PUT', '/transfer/uploads?name=f', bytes)
  expect(res.statusCode).toBe(201)
  return res.json().uploadId
}
/** The preview's refusal reason (or "ok"), and the server still answers. */
async function previewReason(bytes: Buffer, body: object = {}): Promise<string> {
  const id = await upload(bytes)
  const res = await h.call('POST', `/transfer/uploads/${id}/preview`, body)
  expect((await h.t.app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200)
  return res.statusCode === 200 ? 'ok' : (res.json().details?.reason ?? res.json().code)
}
async function importNd(text: string | Buffer, extra: object = {}) {
  const uploadId = await upload(Buffer.from(text))
  const res = await h.call('POST', `${NS}/import`, { uploadId, format: 'ndjson', mode: 'insert', ...extra })
  expect(res.statusCode).toBe(202)
  const job = await waitJob(h.t, res.json().job.id)
  const report = (await h.get(`/api/transfer/jobs/${job.id}/report`)).json()
  return { job, report }
}

const W = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
function workbook(parts: Record<string, string | Buffer>): Buffer {
  const base: Record<string, string | Buffer> = {
    'xl/workbook.xml': `<workbook xmlns="${W}" xmlns:r="${R}"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<Relationships><Relationship Id="rId1" Type="${R}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rS" Type="${R}/sharedStrings" Target="sharedStrings.xml"/></Relationships>`,
    'xl/worksheets/sheet1.xml': `<worksheet xmlns="${W}"><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>`,
    ...parts,
  }
  return rawZip(Object.entries(base).map(([name, data]) => ({ name, data: Buffer.from(data) })))
}

describe('hostile files through the routes (spec §7)', () => {
  it('T4: a gzip bomb is stopped by the inflate budget', async () => {
    expect(await previewReason(hostile.gzipBomb(1000))).toBe('inflate')
  })

  it('T4: a workbook whose sheet is a zip bomb is stopped', async () => {
    expect(
      await previewReason(workbook({ 'xl/worksheets/sheet1.xml': Buffer.alloc(64 * 1024 * 1024) })),
    ).toBe('inflate')
  })

  it('T7: a workbook declaring a DTD or an external entity is refused', async () => {
    const xxe = `<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><worksheet xmlns="${W}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>&e;</t></is></c></row></sheetData></worksheet>`
    expect(await previewReason(workbook({ 'xl/worksheets/sheet1.xml': xxe }))).toBe('xml_dtd')
  })

  it('T7: a workbook pointing at an external target is refused', async () => {
    const rels = `<Relationships><Relationship Id="rId1" Type="${R}/worksheet" Target="http://evil.example/x.xml" TargetMode="External"/></Relationships>`
    expect(await previewReason(workbook({ 'xl/_rels/workbook.xml.rels': rels }))).toBe('xlsx')
  })

  it('T6: more than 1 000 000 shared strings are refused', async () => {
    const parts = ['<sst>']
    for (let i = 0; i <= 1_000_000; i++) parts.push(`<si><t>${i}</t></si>`)
    parts.push('</sst>')
    expect(await previewReason(workbook({ 'xl/sharedStrings.xml': parts.join('') }))).toBe('xlsx')
  }, 60_000)

  it('T5: a CSV quote that never closes over 17 MiB, and a row of 10 001 fields, are refused', async () => {
    expect(await previewReason(Buffer.from(`a\n"${'x'.repeat(17 * 1024 * 1024)}`))).toBe('record_size')
    expect(
      await previewReason(Buffer.from(`${Array.from({ length: 10_001 }, (_, i) => i).join(',')}\n`)),
    ).toBe('fields')
  })

  it('T5: JSON nested 10 000 levels is a row error, not a crash', async () => {
    const { job, report } = await importNd(`${hostile.deepJson(10_000)}\n{"ok":1}\n`)
    expect(job.state).toBe('done')
    expect(report).toMatchObject({ inserted: 1, failed: 1 })
  })

  it('T9: __proto__ is refused and never reaches a prototype', async () => {
    const { report } = await importNd(
      '{"__proto__":{"polluted":true}}\n{"constructor":{"prototype":{"p":1}}}\n',
    )
    expect(report).toMatchObject({ inserted: 0, failed: 2 })
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('T10, T11: a UTF-16 file hiding $-keys is a row error; invalid bytes fail their record only', async () => {
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('{"$set":1}\n{"a":1}\n', 'utf16le')])
    expect((await importNd(utf16)).report).toMatchObject({ inserted: 1, failed: 1 })
    const bad = Buffer.concat([Buffer.from('{"a":"'), Buffer.from([0xfe]), Buffer.from('"}\n{"a":2}\n')])
    expect((await importNd(bad)).report).toMatchObject({ inserted: 1, failed: 1 })
  }, 60_000)

  it('T12: adversarial 64-character values preview quickly', async () => {
    const rows = Array.from(
      { length: 1000 },
      () => `${'1'.repeat(63)}x,2024-01-01T${'1'.repeat(53)},${'-'.repeat(64)}`,
    )
    const started = Date.now()
    expect(await previewReason(Buffer.from(`a,b,c\n${rows.join('\n')}\n`))).toBe('ok')
    expect(Date.now() - started).toBeLessThan(3_000)
  })

  it("T18: an import cannot read another user's upload", async () => {
    const team = await teamHarness(mongo)
    try {
      const a = team.user('editor')
      const b = team.user('editor')
      const { uploadId } = (await a.raw('PUT', '/transfer/uploads', Buffer.from('{"a":1}\n'))).json()
      expect(
        (await b.call('POST', `${NS}/import`, { uploadId, format: 'ndjson', mode: 'insert' })).statusCode,
      ).toBe(404)
    } finally {
      await team.t.close()
    }
  })
})

describe('fuzzing the remaining readers (spec §7)', () => {
  it('NDJSON', async () => {
    await fuzz(
      9101,
      400,
      Buffer.from('{"a":1}\n{"b":[1,{"c":"d"}]}\n\n{"e":{"$date":"2024-01-01T00:00:00Z"}}\n'),
      async (input) => {
        for await (const _ of docSource(ndjsonLines(Readable.from([input.toString('latin1')])), {
          allowUnusual: false,
        }).records);
      },
    )
  })

  it('gzip', async () => {
    const base = gzipSync(Buffer.from('id,name\n1,Ali\n2,Veli\n'.repeat(50)))
    await fuzz(9201, 300, base, (input) =>
      pipeline(
        Readable.from([input]),
        boundedGunzip(input.length, 1e7),
        new Writable({ write: (_c, _e, done) => done() }),
      ),
    )
  })

  it('text decoding, strict and lenient', async () => {
    const base = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('İstanbul € şğü\n'.repeat(20))])
    await fuzz(9301, 300, base, async (input) => {
      for await (const _ of decodeText(Readable.from([input]), undefined, { lenient: true }));
      for await (const _ of decodeText(Readable.from([input])));
    })
  })

  // W4.1: the single-byte encodings a user may choose; every byte sequence ends in text or an AppError.
  it('text decoding in the single-byte encodings', async () => {
    const base = Buffer.from('Işık;Şahin;€ “a”\n'.repeat(20), 'latin1')
    await fuzz(9302, 300, base, async (input) => {
      for (const enc of ['latin1', 'windows1252', 'windows1254', 'iso88599'] as const) {
        for await (const _ of decodeText(Readable.from([input]), enc, { lenient: true }));
        for await (const _ of decodeText(Readable.from([input]), enc));
      }
    })
  })
})
