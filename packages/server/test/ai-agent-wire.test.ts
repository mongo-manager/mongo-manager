import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config'
import { createAiEgress } from '../src/ai/egress'
import type { WireTarget } from '../src/ai/wire'
import {
  ToolsUnsupportedError,
  buildAgentRequest,
  callAgentProvider,
  toolsUnsupported,
  type AgentMessage,
  type ToolSpec,
} from '../src/ai/agent/wire'
import type { Egress } from '../src/net/egress'
import {
  anthropicToolReply,
  geminiToolReply,
  ollamaToolReply,
  openaiToolReply,
  rawReply,
  startFakeAi,
  statusReply,
  type FakeAi,
} from './support/fake-ai'

let egress: Egress
beforeAll(() => {
  egress = createAiEgress(resolveConfig({ cli: { auth: false, dataDir: '/tmp/x' } }))
})
const fakes: FakeAi[] = []
afterEach(async () => {
  for (const f of fakes.splice(0)) await f.close()
})
async function fake() {
  const f = await startFakeAi()
  fakes.push(f)
  return f
}
const base = (kind: WireTarget['kind'], f: FakeAi): string => (kind === 'openai' ? `${f.url}/v1` : f.url)
const target = (kind: WireTarget['kind'], f: FakeAi): WireTarget => ({
  kind,
  baseUrl: base(kind, f),
  model: kind === 'gemini' ? 'gemini-3-pro' : 'm',
  apiKey: kind === 'anthropic' || kind === 'gemini' ? 'k' : null,
  maxTokens: 512,
})
const TOOLS: ToolSpec[] = [
  {
    name: 'list_databases',
    description: 'Lists databases',
    parameters: {
      type: 'object',
      properties: { connection: { type: 'string', description: 'A connection name' } },
      required: ['connection'],
      additionalProperties: false,
    },
  },
]
const call = async (kind: WireTarget['kind'], f: FakeAi, messages: AgentMessage[]) => {
  let text = ''
  const out = await callAgentProvider(egress, target(kind, f), 'You act.', messages, TOOLS, {
    signal: new AbortController().signal,
    privateOnly: false,
    onText: (d) => void (text += d),
  })
  return { text, ...out }
}
const ASK: AgentMessage[] = [{ role: 'user', content: 'what databases are on Sales?' }]

describe('tool calls, per provider (W6.3)', () => {
  it('OpenAI-compatible: tools as functions; streamed calls joined from their pieces', async () => {
    const f = await fake()
    f.reply(
      openaiToolReply(
        [
          { id: 'c1', name: 'list_databases', args: { connection: 'Sales Mongo' } },
          { id: 'c2', name: 'list_databases', args: { connection: 'Demo' } },
        ],
        'Looking.',
      ),
    )
    const out = await call('openai', f, ASK)
    expect(out.text).toBe('Looking.')
    expect(out.calls).toEqual([
      { id: 'c1', name: 'list_databases', args: { connection: 'Sales Mongo' } },
      { id: 'c2', name: 'list_databases', args: { connection: 'Demo' } },
    ])
    expect(out.usage).toEqual({ input: 20, output: 5 })
    const body = f.requests[0]!.body as { tools: unknown[]; messages: Array<{ role: string }> }
    expect(f.requests[0]!.path).toBe('/v1/chat/completions')
    expect(body.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'list_databases',
          description: 'Lists databases',
          parameters: TOOLS[0]!.parameters,
        },
      },
    ])
    expect(body.messages.map((m) => m.role)).toEqual(['system', 'user'])
  })

  it('OpenAI-compatible: earlier calls and their results travel as tool_calls and tool messages', () => {
    const req = buildAgentRequest(
      { kind: 'openai', baseUrl: 'https://x/v1', model: 'm', apiKey: null, maxTokens: 100 },
      'S',
      [
        ...ASK,
        {
          role: 'assistant',
          text: 'Looking.',
          calls: [{ id: 'c1', name: 'list_databases', args: { connection: 'A' } }],
        },
        { role: 'tool', results: [{ id: 'c1', name: 'list_databases', content: 'R' }] },
      ],
      TOOLS,
    )
    const body = JSON.parse(req.body.toString()) as { messages: unknown[] }
    expect(body.messages.slice(2)).toEqual([
      {
        role: 'assistant',
        content: 'Looking.',
        tool_calls: [
          {
            id: 'c1',
            type: 'function',
            function: { name: 'list_databases', arguments: '{"connection":"A"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'R' },
    ])
  })

  it('Anthropic: tool_use blocks from input_json_delta; results as tool_result blocks in a user message', async () => {
    const f = await fake()
    f.reply(
      anthropicToolReply(
        [{ id: 'toolu_1', name: 'list_databases', args: { connection: 'Sales Mongo' } }],
        'Sure.',
      ),
    )
    const out = await call('anthropic', f, ASK)
    expect(out.text).toBe('Sure.')
    expect(out.calls).toEqual([
      { id: 'toolu_1', name: 'list_databases', args: { connection: 'Sales Mongo' } },
    ])
    const body = f.requests[0]!.body as { tools: unknown[] }
    expect(body.tools).toEqual([
      { name: 'list_databases', description: 'Lists databases', input_schema: TOOLS[0]!.parameters },
    ])
    const next = JSON.parse(
      buildAgentRequest(
        target('anthropic', f),
        'S',
        [
          ...ASK,
          { role: 'assistant', text: 'Sure.', calls: out.calls },
          { role: 'tool', results: [{ id: 'toolu_1', name: 'list_databases', content: 'R' }] },
        ],
        TOOLS,
      ).body.toString(),
    ) as { messages: unknown[] }
    expect(next.messages.slice(1)).toEqual([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Sure.' },
          { type: 'tool_use', id: 'toolu_1', name: 'list_databases', input: { connection: 'Sales Mongo' } },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'R' }] },
    ])
  })

  it('Ollama: whole calls with object arguments get ids; results as tool messages with the tool name', async () => {
    const f = await fake()
    f.reply(ollamaToolReply([{ name: 'list_databases', args: { connection: 'Sales Mongo' } }]))
    const out = await call('ollama', f, ASK)
    expect(out.calls).toEqual([
      { id: expect.any(String), name: 'list_databases', args: { connection: 'Sales Mongo' } },
    ])
    const body = f.requests[0]!.body as { tools: unknown[]; stream: boolean }
    expect(f.requests[0]!.path).toBe('/api/chat')
    expect(body.tools).toHaveLength(1)
    const next = JSON.parse(
      buildAgentRequest(
        target('ollama', f),
        'S',
        [
          ...ASK,
          { role: 'assistant', text: '', calls: out.calls },
          { role: 'tool', results: [{ id: out.calls[0]!.id, name: 'list_databases', content: 'R' }] },
        ],
        TOOLS,
      ).body.toString(),
    ) as { messages: unknown[] }
    expect(next.messages.slice(2)).toEqual([
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ function: { name: 'list_databases', arguments: { connection: 'Sales Mongo' } } }],
      },
      { role: 'tool', content: 'R', tool_name: 'list_databases' },
    ])
  })

  it('Gemini: function declarations without unsupported keywords; the model’s parts and signatures echoed back', async () => {
    const f = await fake()
    f.reply(
      geminiToolReply([
        { id: 'g1', name: 'list_databases', args: { connection: 'Sales Mongo' }, signature: 'sig-abc' },
      ]),
    )
    const out = await call('gemini', f, ASK)
    expect(out.calls).toEqual([{ id: 'g1', name: 'list_databases', args: { connection: 'Sales Mongo' } }])
    const body = f.requests[0]!.body as {
      tools: Array<{ functionDeclarations: Array<Record<string, unknown>> }>
    }
    const decl = body.tools[0]!.functionDeclarations[0]!
    expect(decl.name).toBe('list_databases')
    expect(JSON.stringify(decl)).not.toContain('additionalProperties')
    const next = JSON.parse(
      buildAgentRequest(
        target('gemini', f),
        'S',
        [
          ...ASK,
          { role: 'assistant', text: '', calls: out.calls, raw: out.raw },
          { role: 'tool', results: [{ id: 'g1', name: 'list_databases', content: 'R' }] },
        ],
        TOOLS,
      ).body.toString(),
    ) as { contents: unknown[] }
    expect(next.contents.slice(1)).toEqual([
      {
        role: 'model',
        parts: [
          {
            functionCall: { id: 'g1', name: 'list_databases', args: { connection: 'Sales Mongo' } },
            thoughtSignature: 'sig-abc',
          },
        ],
      },
      {
        role: 'user',
        parts: [{ functionResponse: { id: 'g1', name: 'list_databases', response: { result: 'R' } } }],
      },
    ])
  })

  it('Gemini: a call that came without an id is answered without one (an id made up here never travels)', async () => {
    const f = await fake()
    f.reply(geminiToolReply([{ name: 'list_databases', args: { connection: 'A' } }]))
    const out = await call('gemini', f, ASK)
    expect(out.calls).toEqual([{ id: expect.any(String), name: 'list_databases', args: { connection: 'A' } }])
    const next = JSON.parse(
      buildAgentRequest(
        target('gemini', f),
        'S',
        [
          ...ASK,
          { role: 'assistant', text: '', calls: out.calls, raw: out.raw },
          { role: 'tool', results: [{ id: out.calls[0]!.id, name: 'list_databases', content: 'R' }] },
        ],
        TOOLS,
      ).body.toString(),
    ) as { contents: Array<{ parts: unknown[] }> }
    expect(next.contents.at(-1)!.parts).toEqual([
      { functionResponse: { name: 'list_databases', response: { result: 'R' } } },
    ])
  })

  // Security review of W6.3 (minor 7): echoed back, a non-object made the provider answer 400.
  it('arguments that are JSON but not an object make a call marked invalid, and are never echoed', async () => {
    for (const [kind, reply] of [
      ['openai', openaiToolReply([{ id: 'c1', name: 'list_databases', args: [1, 2] }])],
      ['anthropic', anthropicToolReply([{ id: 'c1', name: 'list_databases', args: 'text' }])],
      ['ollama', ollamaToolReply([{ name: 'list_databases', args: 5 }])],
      ['gemini', geminiToolReply([{ id: 'c1', name: 'list_databases', args: [1] }])],
    ] as const) {
      const f = await fake()
      f.reply(reply)
      const out = await call(kind, f, ASK)
      expect(out.calls, kind).toEqual([
        { id: expect.any(String), name: 'list_databases', args: null, invalid: true },
      ])
      const echoed = JSON.parse(
        buildAgentRequest(
          target(kind, f),
          'S',
          [...ASK, { role: 'assistant', text: '', calls: out.calls, ...(out.raw ? { raw: out.raw } : {}) }],
          TOOLS,
        ).body.toString(),
      )
      expect(JSON.stringify(echoed), kind).not.toMatch(
        /"input":"text"|"args":\[|"arguments":"\[|"arguments":5/,
      )
    }
  })

  it('arguments that are not JSON make a call marked invalid, never a guess', async () => {
    const f = await fake()
    f.reply(
      rawReply(
        [
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'list_databases', arguments: '{"connection": "A' } }] } }] })}`,
          '',
          'data: [DONE]',
          '',
        ].join('\n'),
      ),
    )
    const out = await call('openai', f, ASK)
    expect(out.calls).toEqual([{ id: 'c1', name: 'list_databases', args: null, invalid: true }])
  })

  it('a model without tools is told apart (Ollama, llama.cpp, vLLM, Gemma) so the turn can fall back', async () => {
    expect(
      toolsUnsupported(400, '{"error":"registry.ollama.ai/library/gemma:2b does not support tools"}'),
    ).toBe(true)
    expect(toolsUnsupported(500, 'tools param requires --jinja flag')).toBe(true)
    expect(toolsUnsupported(400, '"auto" tool choice requires --enable-auto-tool-choice')).toBe(true)
    expect(toolsUnsupported(400, 'Function calling is not enabled for models/gemma-3-27b-it')).toBe(true)
    expect(toolsUnsupported(400, 'model not found')).toBe(false)
    expect(toolsUnsupported(401, 'does not support tools')).toBe(false)
    const f = await fake()
    f.reply(statusReply(400, '{"error":"m does not support tools"}'))
    await expect(call('ollama', f, ASK)).rejects.toBeInstanceOf(ToolsUnsupportedError)
  })
})
