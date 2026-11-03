import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'
import { startHttpsServer } from './https-server'

/** What a fake provider answers with: written to the response however the test likes. */
export type Reply = (res: ServerResponse, req: { path: string; body: Record<string, unknown> }) => unknown

export interface FakeAi {
  /** Plain http on 127.0.0.1 (loopback is allowed to the assistant in local mode). */
  url: string
  requests: Array<{ path: string; headers: IncomingHttpHeaders; body: Record<string, unknown> }>
  /** The answer to every following request. */
  reply(r: Reply): void
  close(): Promise<void>
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Bytes written in slices of `split` bytes (characters and events cut anywhere), a little apart. */
async function write(res: ServerResponse, text: string, split?: number): Promise<void> {
  const bytes = Buffer.from(text)
  if (!split) return void res.end(bytes)
  for (let i = 0; i < bytes.length; i += split) {
    res.write(bytes.subarray(i, i + split))
    await sleep(1)
  }
  res.end()
}

const pieces = (text: string) => text.match(/.{1,5}/gsu) ?? []

export const anthropicReply =
  (text: string, usage = { input: 12, output: 7 }, split?: number): Reply =>
  async (res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const ev = (type: string, data: object) =>
      `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
    await write(
      res,
      [
        ev('message_start', { message: { usage: { input_tokens: usage.input, output_tokens: 1 } } }),
        ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
        ': a comment line\n\n',
        ...pieces(text).map((p) =>
          ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: p } }),
        ),
        ev('content_block_stop', { index: 0 }),
        ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: usage.output } }),
        ev('message_stop', {}),
      ].join(''),
      split,
    )
  }

export const openaiReply =
  (text: string, usage = { input: 12, output: 7 }, split?: number): Reply =>
  async (res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const data = (o: object) => `data: ${JSON.stringify(o)}\n\n`
    await write(
      res,
      [
        ...pieces(text).map((p) => data({ choices: [{ index: 0, delta: { content: p } }] })),
        data({ choices: [], usage: { prompt_tokens: usage.input, completion_tokens: usage.output } }),
        'data: [DONE]\n\n',
      ].join(''),
      split,
    )
  }

export const ollamaReply =
  (text: string, usage = { input: 12, output: 7 }, split?: number): Reply =>
  async (res) => {
    res.writeHead(200, { 'content-type': 'application/x-ndjson' })
    await write(
      res,
      [
        ...pieces(text).map((p) =>
          JSON.stringify({ message: { role: 'assistant', content: p }, done: false }),
        ),
        JSON.stringify({
          message: { role: 'assistant', content: '' },
          done: true,
          prompt_eval_count: usage.input,
          eval_count: usage.output,
        }),
      ].join('\n') + '\n',
      split,
    )
  }

export const geminiReply =
  (text: string, usage = { input: 12, output: 7 }, split?: number): Reply =>
  async (res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const data = (o: object) => `data: ${JSON.stringify(o)}\r\n\r\n`
    const parts = pieces(text)
    await write(
      res,
      [
        // A thinking model's thought is not part of the answer (plan ruling 13).
        data({
          candidates: [{ content: { role: 'model', parts: [{ text: 'secret plan', thought: true }] } }],
        }),
        ...parts.map((p, i) =>
          data({
            candidates: [
              {
                content: { role: 'model', parts: [{ text: p }] },
                ...(i === parts.length - 1 ? { finishReason: 'STOP' } : {}),
              },
            ],
            usageMetadata: {
              promptTokenCount: usage.input,
              candidatesTokenCount: i === parts.length - 1 ? usage.output : 1,
            },
          }),
        ),
      ].join(''),
      split,
    )
  }

/** W6.3: a tool call a fake provider makes (arguments as an object; each kind writes them its way). */
export interface FakeCall {
  id?: string
  name: string
  args: unknown
  /** Gemini 3: a thought signature the request after must echo. */
  signature?: string
}

/** OpenAI's streamed tool calls: the arguments' JSON cut into pieces across chunks. */
export const openaiToolReply =
  (calls: FakeCall[], text = '', usage = { input: 20, output: 5 }): Reply =>
  async (res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const data = (o: object) => `data: ${JSON.stringify(o)}\n\n`
    const out: string[] = []
    for (const p of pieces(text)) out.push(data({ choices: [{ index: 0, delta: { content: p } }] }))
    calls.forEach((c, index) => {
      const args = JSON.stringify(c.args)
      const parts = args.match(/.{1,7}/gsu) ?? ['']
      out.push(
        data({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index,
                    id: c.id ?? `call_${index}`,
                    type: 'function',
                    function: { name: c.name, arguments: parts[0] },
                  },
                ],
              },
            },
          ],
        }),
      )
      for (const p of parts.slice(1))
        out.push(
          data({ choices: [{ index: 0, delta: { tool_calls: [{ index, function: { arguments: p } }] } }] }),
        )
    })
    out.push(
      data({ choices: [{ index: 0, delta: {}, finish_reason: calls.length ? 'tool_calls' : 'stop' }] }),
    )
    out.push(data({ choices: [], usage: { prompt_tokens: usage.input, completion_tokens: usage.output } }))
    out.push('data: [DONE]\n\n')
    await write(res, out.join(''))
  }

/** Anthropic's tool_use blocks, their input as input_json_delta pieces. */
export const anthropicToolReply =
  (calls: FakeCall[], text = '', usage = { input: 20, output: 5 }): Reply =>
  async (res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const ev = (type: string, data: object) =>
      `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
    const out = [ev('message_start', { message: { usage: { input_tokens: usage.input, output_tokens: 1 } } })]
    let index = 0
    if (text) {
      out.push(ev('content_block_start', { index, content_block: { type: 'text', text: '' } }))
      for (const p of pieces(text))
        out.push(ev('content_block_delta', { index, delta: { type: 'text_delta', text: p } }))
      out.push(ev('content_block_stop', { index }))
      index++
    }
    for (const c of calls) {
      out.push(
        ev('content_block_start', {
          index,
          content_block: { type: 'tool_use', id: c.id ?? `toolu_${index}`, name: c.name, input: {} },
        }),
      )
      for (const p of JSON.stringify(c.args).match(/.{1,6}/gsu) ?? [])
        out.push(ev('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: p } }))
      out.push(ev('content_block_stop', { index }))
      index++
    }
    out.push(
      ev('message_delta', {
        delta: { stop_reason: calls.length ? 'tool_use' : 'end_turn' },
        usage: { output_tokens: usage.output },
      }),
      ev('message_stop', {}),
    )
    await write(res, out.join(''))
  }

/** Ollama's tool calls: whole, with their arguments as an object. */
export const ollamaToolReply =
  (calls: FakeCall[], text = '', usage = { input: 20, output: 5 }): Reply =>
  async (res) => {
    res.writeHead(200, { 'content-type': 'application/x-ndjson' })
    const out = pieces(text).map((p) =>
      JSON.stringify({ message: { role: 'assistant', content: p }, done: false }),
    )
    if (calls.length)
      out.push(
        JSON.stringify({
          message: {
            role: 'assistant',
            content: '',
            tool_calls: calls.map((c) => ({ function: { name: c.name, arguments: c.args } })),
          },
          done: false,
        }),
      )
    out.push(
      JSON.stringify({
        message: { role: 'assistant', content: '' },
        done: true,
        prompt_eval_count: usage.input,
        eval_count: usage.output,
      }),
    )
    await write(res, out.join('\n') + '\n')
  }

/** Gemini's functionCall parts, with an id and a thought signature when given. */
export const geminiToolReply =
  (calls: FakeCall[], text = '', usage = { input: 20, output: 5 }): Reply =>
  async (res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const data = (o: object) => `data: ${JSON.stringify(o)}\r\n\r\n`
    const parts: object[] = [
      ...(text ? [{ text }] : []),
      ...calls.map((c) => ({
        functionCall: { ...(c.id ? { id: c.id } : {}), name: c.name, args: c.args },
        ...(c.signature ? { thoughtSignature: c.signature } : {}),
      })),
    ]
    await write(
      res,
      data({
        candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: usage.input, candidatesTokenCount: usage.output },
      }),
    )
  }

/** A tool call or text in the format the request's path asks for. */
export const toolReplyFor = (path: string, calls: FakeCall[], text = ''): Reply => {
  if (path.includes(':streamGenerateContent')) return geminiToolReply(calls, text)
  if (path.endsWith('/v1/messages')) return anthropicToolReply(calls, text)
  if (path.endsWith('/api/chat')) return ollamaToolReply(calls, text)
  return openaiToolReply(calls, text)
}

/** Answers "<n> messages: <roles>" in the format the request's path asks for (history checks). */
export const echoReply = (): Reply => async (res, req) => {
  const body = req.body as {
    messages?: Array<{ role: string }>
    contents?: Array<{ role: string }>
  }
  const list = body.contents ?? body.messages ?? []
  const text = `${list.length} messages: ${list.map((m) => m.role).join(',')}`
  if (req.path.includes(':streamGenerateContent')) return geminiReply(text)(res, req)
  if (req.path.endsWith('/v1/messages')) return anthropicReply(text)(res, req)
  if (req.path.endsWith('/api/chat')) return ollamaReply(text)(res, req)
  return openaiReply(text)(res, req)
}

export const statusReply =
  (status: number, body = '', headers: Record<string, string> = {}): Reply =>
  (res) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers })
    res.end(body)
  }

export const rawReply =
  (text: string, contentType = 'text/event-stream'): Reply =>
  (res) => {
    res.writeHead(200, { 'content-type': contentType })
    res.end(text)
  }

export async function startFakeAi(): Promise<FakeAi> {
  let current: Reply = openaiReply('OK')
  const requests: FakeAi['requests'] = []
  const server = await startHttpsServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = []
      for await (const c of req) chunks.push(c as Buffer)
      const text = Buffer.concat(chunks).toString('utf8')
      const body = (text ? JSON.parse(text) : {}) as Record<string, unknown>
      const path = req.url ?? '/'
      requests.push({ path, headers: req.headers, body })
      await current(res, { path, body })
    },
    { plain: true },
  )
  return {
    url: server.url,
    requests,
    reply: (r) => void (current = r),
    close: server.close,
  }
}
