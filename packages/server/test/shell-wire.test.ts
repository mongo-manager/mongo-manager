import { describe, expect, it } from 'vitest'
import { BSON } from 'bson'
import {
  FrameSplitter,
  commandWithSequences,
  encodeFrame,
  encodeOpMsg,
  parseOpMsg,
  rewriteWorkerFrame,
  OP_MSG,
  OP_COMPRESSED,
  FLAG_MORE_TO_COME,
  MAX_FRAME_BYTES,
} from '../src/shell/proxy/wire'
import { commandPolicy } from '../src/shell/proxy/policy'

const opMsgFrame = (
  command: Record<string, unknown>,
  flags = 0,
  sequences: { identifier: string; documents: Buffer[] }[] = [],
) =>
  encodeFrame({
    requestID: 7,
    responseTo: 0,
    opCode: OP_MSG,
    body: encodeOpMsg({ flags, command, sequences }),
  })

describe('wire frame splitting (phase 3a-1 §5.2)', () => {
  it('reassembles frames split across chunks and handles several at once', () => {
    const a = opMsgFrame({ ping: 1, $db: 'admin' })
    const b = opMsgFrame({ hello: 1, $db: 'admin' })
    const s = new FrameSplitter()
    expect(s.push(a.subarray(0, 5))).toEqual([])
    const out = s.push(Buffer.concat([a.subarray(5), b]))
    expect(out).toHaveLength(2)
    expect(parseOpMsg(out[0]!.body).command).toMatchObject({ ping: 1 })
    expect(parseOpMsg(out[1]!.body).command).toMatchObject({ hello: 1 })
  })

  it('round-trips an OP_MSG with a kind-1 sequence and moreToCome', () => {
    const docs = [Buffer.from(BSON.serialize({ _id: 1 })), Buffer.from(BSON.serialize({ _id: 2 }))]
    const frame = opMsgFrame({ insert: 'c', $db: 'shop' }, FLAG_MORE_TO_COME, [
      { identifier: 'documents', documents: docs },
    ])
    const [parsed] = new FrameSplitter().push(frame)
    const msg = parseOpMsg(parsed!.body)
    expect(msg.flags & FLAG_MORE_TO_COME).toBe(FLAG_MORE_TO_COME)
    expect(msg.command).toMatchObject({ insert: 'c' })
    expect(msg.sequences[0]!.identifier).toBe('documents')
    expect(msg.sequences[0]!.documents.map((d) => BSON.deserialize(d))).toEqual([{ _id: 1 }, { _id: 2 }])
  })

  it('throws on an oversize frame length and on a truncated header length', () => {
    const bad = Buffer.alloc(16)
    bad.writeInt32LE(MAX_FRAME_BYTES + 1, 0)
    bad.writeInt32LE(OP_MSG, 12)
    expect(() => new FrameSplitter().push(bad)).toThrow(/bad frame length/)
    const tiny = Buffer.alloc(16)
    tiny.writeInt32LE(4, 0)
    expect(() => new FrameSplitter().push(tiny)).toThrow(/bad frame length/)
  })
})

describe('hello rewrite (phase 3a-1 §5.2)', () => {
  it('strips client, compression and speculative auth from a worker hello', () => {
    const frame = opMsgFrame({
      hello: 1,
      $db: 'admin',
      client: { application: { name: 'evil' }, driver: { name: 'x', version: '1' } },
      compression: ['zlib'],
      speculativeAuthenticate: { saslStart: 1 },
      saslSupportedMechs: 'admin.user',
    })
    const out = rewriteWorkerFrame(new FrameSplitter().push(frame)[0]!)
    const cmd = parseOpMsg(out.body).command
    expect(cmd).toMatchObject({ hello: 1 })
    expect(cmd).not.toHaveProperty('client')
    expect(cmd).not.toHaveProperty('compression')
    expect(cmd).not.toHaveProperty('speculativeAuthenticate')
    expect(cmd).not.toHaveProperty('saslSupportedMechs')
  })

  it('leaves a non-hello command untouched', () => {
    const frame = new FrameSplitter().push(opMsgFrame({ find: 'c', $db: 'shop' }))[0]!
    expect(rewriteWorkerFrame(frame)).toBe(frame)
  })
})

describe('opcode handling', () => {
  it('parses OP_COMPRESSED as its opcode so the proxy can reject it', () => {
    const frame = encodeFrame({ requestID: 1, responseTo: 0, opCode: OP_COMPRESSED, body: Buffer.alloc(9) })
    const [parsed] = new FrameSplitter().push(frame)
    expect(parsed!.opCode).toBe(OP_COMPRESSED)
  })
})

describe('folding document sequences for the policy (review M2)', () => {
  it('a writing pipeline moved into a document sequence is still caught on a read-only session', () => {
    const msg = parseOpMsg(
      encodeOpMsg({
        flags: 0,
        command: { aggregate: 'c', $db: 'shop' },
        sequences: [{ identifier: 'pipeline', documents: [Buffer.from(BSON.serialize({ $out: 'stolen' }))] }],
      }),
    )
    const readOnly = commandPolicy({ readOnly: true, admin: true })
    // Without folding, the command body has no pipeline, so the write hides and the policy allows it.
    expect(readOnly({ name: 'aggregate', db: 'shop', body: msg.command }).allow).toBe(true)
    // Folding the sequence back onto the command reveals the $out, and the policy refuses it.
    expect(readOnly({ name: 'aggregate', db: 'shop', body: commandWithSequences(msg) }).allow).toBe(false)
  })

  it('leaves a command with no sequences untouched', () => {
    const msg = parseOpMsg(encodeOpMsg({ flags: 0, command: { find: 'c', $db: 'shop' }, sequences: [] }))
    expect(commandWithSequences(msg)).toBe(msg.command)
  })
})
