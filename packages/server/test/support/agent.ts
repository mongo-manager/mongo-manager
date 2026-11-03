import { request } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { FastifyInstance } from 'fastify'
import { ConnectionSettingsSchema, type AiChatLine } from '@mongo-manager/shared'
import { toolReplyFor, type FakeCall, type Reply } from './fake-ai'

/** W6.3 tests: what a provider was given, whatever its kind. */
export interface Conversation {
  /** The tool results so far, oldest first (their text). */
  results: string[]
  /** Every user-role text (the request with its envelope first). */
  users: string[]
  body: Record<string, unknown>
}

type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

export function conversationOf(body: Json): Conversation {
  const results: string[] = []
  const users: string[] = []
  for (const m of (body.messages ?? []) as Json[]) {
    if (m.role === 'tool') results.push(String(m.content))
    else if (m.role === 'user') {
      if (typeof m.content === 'string') users.push(m.content)
      else
        for (const part of m.content as Json[])
          if (part.type === 'tool_result') results.push(String(part.content))
          else if (part.type === 'text') users.push(String(part.text))
    }
  }
  for (const c of (body.contents ?? []) as Json[])
    for (const p of c.parts as Json[]) {
      if (p.functionResponse) results.push(String(p.functionResponse.response?.result))
      else if (c.role === 'user' && typeof p.text === 'string') users.push(p.text)
    }
  return { results, users, body }
}

/** A scripted model: what it does next from what it was given so far. */
export const agentReply =
  (next: (c: Conversation) => { calls?: FakeCall[]; text?: string }): Reply =>
  (res, req) => {
    const step = next(conversationOf(req.body as Json))
    return toolReplyFor(req.path, step.calls ?? [], step.text ?? '')(res, req)
  }

export interface AgentStream {
  lines: AiChatLine[]
  /** The first line (already come, or to come) that passes the test. */
  waitFor(test: (l: AiChatLine) => boolean, ms?: number): Promise<AiChatLine>
  ended: Promise<number>
  stop(): void
}

const ports = new WeakMap<FastifyInstance, number>()
async function portOf(app: FastifyInstance): Promise<number> {
  const known = ports.get(app)
  if (known) return known
  await app.listen({ port: 0, host: '127.0.0.1' })
  const port = (app.server.address() as AddressInfo).port
  ports.set(app, port)
  return port
}

/** One agent turn over a real socket, its lines read as they come (a turn waits for answers). */
export async function agentTurn(
  app: FastifyInstance,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  path = '/api/ai/agent',
): Promise<AgentStream> {
  const port = await portOf(app)
  const lines: AiChatLine[] = []
  const waiters: Array<{ test: (l: AiChatLine) => boolean; resolve: (l: AiChatLine) => void }> = []
  let status = 0
  const req = request({
    host: '127.0.0.1',
    port,
    method: 'POST',
    path,
    headers: {
      ...headers,
      host: `localhost:${port}`,
      origin: `http://localhost:${port}`,
      'content-type': 'application/json',
    },
  })
  const ended = new Promise<number>((resolve) => {
    req.on('response', (res) => {
      status = res.statusCode ?? 0
      let rest = ''
      res.on('data', (c: Buffer) => {
        rest += c.toString('utf8')
        let at: number
        while ((at = rest.indexOf('\n')) !== -1) {
          const text = rest.slice(0, at)
          rest = rest.slice(at + 1)
          if (!text.trim()) continue
          let line: AiChatLine
          try {
            line = JSON.parse(text) as AiChatLine
          } catch {
            continue
          }
          lines.push(line)
          for (const w of [...waiters])
            if (w.test(line)) {
              waiters.splice(waiters.indexOf(w), 1)
              w.resolve(line)
            }
        }
      })
      res.on('end', () => {
        if (rest.trim()) {
          try {
            lines.push(JSON.parse(rest) as AiChatLine)
          } catch {
            // an error body that is not a line
            lines.push({ type: 'error', reason: rest as never })
          }
        }
        resolve(status)
      })
      res.on('close', () => resolve(status))
    })
    req.on('error', () => resolve(status))
  })
  req.end(JSON.stringify(body))
  return {
    lines,
    waitFor: (test, ms = 8000) => {
      const hit = lines.find(test)
      if (hit) return Promise.resolve(hit)
      return new Promise((resolve, reject) => {
        const w = { test, resolve }
        waiters.push(w)
        setTimeout(() => {
          if (waiters.includes(w))
            reject(new Error(`No such line in ${JSON.stringify(lines).slice(0, 2000)}`))
        }, ms).unref()
      })
    },
    ended,
    stop: () => req.destroy(),
  }
}

/** A second connection to the same MongoDB under another name (and policy). */
export function namedConnection(
  app: FastifyInstance,
  port: number,
  name: string,
  over: {
    aiPolicy?: 'off' | 'local' | 'any'
    readOnly?: boolean
    defaultDatabase?: string
    aiAgentWrites?: boolean
    serverSelectionTimeoutMS?: number
    /** Settings of its own (an SSH tunnel, a sign-in), parsed with the rest. */
    settings?: Record<string, unknown>
  } = {},
): string {
  return app.ctx.connections.create(
    {
      name,
      favorite: false,
      readOnly: over.readOnly ?? false,
      ...(over.aiPolicy ? { aiPolicy: over.aiPolicy } : {}),
      ...(over.aiAgentWrites === false ? { aiAgentWrites: false } : {}),
      settings: ConnectionSettingsSchema.parse({
        hosts: [{ host: '127.0.0.1', port }],
        serverSelectionTimeoutMS: over.serverSelectionTimeoutMS ?? 3_000,
        ...(over.defaultDatabase ? { defaultDatabase: over.defaultDatabase } : {}),
        ...over.settings,
      }),
    },
    null,
  ).id
}
