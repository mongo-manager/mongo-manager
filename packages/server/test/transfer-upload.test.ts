// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startMongo, type TestMongo } from './support/mongo'
import { teamHarness } from './support/data'
import { slow } from './support/slowness'

let mongo: TestMongo
beforeAll(async () => {
  mongo = await startMongo()
}, slow(120_000))
afterAll(async () => mongo?.stop())

const UP = '/transfer/uploads'

describe('upload and preview routes (spec §4.1, §7 T2, T16)', () => {
  it('lets an editor upload and preview, not a viewer; other users get 404', async () => {
    const h = await teamHarness(mongo)
    try {
      const editor = h.user('editor')
      const res = await editor.raw('PUT', `${UP}?name=a.csv`, Buffer.from('a,b\n1,2\n'))
      expect(res.statusCode).toBe(201)
      const { uploadId, size } = res.json()
      expect(size).toBe(8)
      const p = await editor.call('POST', `${UP}/${uploadId}/preview`, {})
      expect(p.statusCode).toBe(200)
      expect(p.json().format).toBe('csv')
      expect((await h.user('viewer').raw('PUT', UP, Buffer.from('x'))).statusCode).toBe(403)
      expect((await h.user('editor').call('POST', `${UP}/${uploadId}/preview`, {})).statusCode).toBe(404)
      expect((await editor.call('POST', `${UP}/not-a-uuid/preview`, {})).statusCode).toBe(400)
      expect((await editor.call('DELETE', `${UP}/${uploadId}`)).statusCode).toBe(204)
      expect((await editor.call('POST', `${UP}/${uploadId}/preview`, {})).statusCode).toBe(404)
    } finally {
      await h.t.close()
    }
  })

  it('refuses other content types, missing CSRF tokens and floods', async () => {
    const h = await teamHarness(mongo)
    try {
      const editor = h.user('editor')
      expect(
        (await editor.raw('PUT', UP, Buffer.from('{}'), { 'content-type': 'application/json' })).statusCode,
      ).toBe(415)
      expect((await editor.raw('PUT', UP, Buffer.from('x'), { 'x-csrf-token': 'wrong' })).statusCode).toBe(
        403,
      )
      const codes = []
      for (let i = 0; i < 11; i++) codes.push((await editor.raw('PUT', UP, Buffer.from('x'))).statusCode)
      expect(codes.slice(0, 9).every((c) => c === 201)).toBe(true)
      expect(codes.at(-1)).toBe(429)
    } finally {
      await h.t.close()
    }
  })

  it('refuses an upload over the configured size with 413, and keeps nothing', async () => {
    const h = await teamHarness(mongo, {
      transfer: { maxUploadMb: 1, quotaMb: 16, totalQuotaMb: 51_200, ttlHours: 24, maxJobHours: 6 },
    })
    try {
      const editor = h.user('editor')
      expect((await editor.raw('PUT', UP, Buffer.alloc(1024 * 1024 + 1))).statusCode).toBe(413)
      expect(h.t.app.ctx.transfer.files.usage(editor.id)).toBe(0)
    } finally {
      await h.t.close()
    }
  })

  it('previews with the format and dialect asked for', async () => {
    const h = await teamHarness(mongo)
    try {
      const editor = h.user('editor')
      const { uploadId } = (await editor.raw('PUT', UP, Buffer.from('a;b\n1;2\n'))).json()
      const p = await editor.call('POST', `${UP}/${uploadId}/preview`, {
        dialect: { delimiter: ',', header: false },
      })
      expect(p.json().fields.map((f: { source: string }) => f.source)).toEqual(['field1'])
    } finally {
      await h.t.close()
    }
  })
})
