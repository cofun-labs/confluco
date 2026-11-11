import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp, type Env } from '../src/app'
import { FakeClerk } from './clerk'
import { FAKE_USAGE, FakeAiBinding, FakeQuotaNamespace, FakeUsageDataset } from './fakes'

const MODEL = '@cf/test/model'
const EXT = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
let clock = new Date('2026-11-08T12:00:00Z')
const app = createApp({ now: () => clock })

let clerk: FakeClerk
let otherClerk: FakeClerk
let ai: FakeAiBinding
let quota: FakeQuotaNamespace
let usage: FakeUsageDataset
let env: Env
let token: string

beforeAll(async () => {
  clerk = await FakeClerk.create()
  otherClerk = await FakeClerk.create()
})

beforeEach(async () => {
  ai = new FakeAiBinding()
  clock = new Date('2026-11-08T12:00:00Z')
  env = {
    AI: ai,
    QUOTA: (quota = new FakeQuotaNamespace()),
    USAGE: (usage = new FakeUsageDataset()),
    DAILY_REQUEST_LIMIT: '100',
    MODEL,
    AI_GATEWAY_ID: 'gw-test',
    CLERK_JWT_KEY: clerk.publicKeyPem,
    CLERK_AUTHORIZED_PARTIES: `${EXT}, https://confluco.example`,
  }
  token = await clerk.sessionToken({ userId: 'user_alice', azp: EXT })
})

const json = (res: Response): Promise<any> => res.json()

function req(method: string, path: string, bearer?: string, body?: unknown) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (bearer) headers.authorization = `Bearer ${bearer}`
  return app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }, env)
}

const hi = [{ role: 'user', content: 'hi' }]
const chat = (bearer: string | undefined, body: unknown = { messages: hi }) =>
  req('POST', '/v1/chat/completions', bearer, body)

describe('UC-AUTH-001 Sign in to use Copilot', () => {
  it('request without a session is refused', async () => {
    const res = await chat(undefined)
    expect(res.status).toBe(401)
    expect((await json(res)).error.code).toBe('unauthorized')
  })

  it('invalid, forged and expired sessions are refused', async () => {
    const forged = await otherClerk.sessionToken({ userId: 'user_eve', azp: EXT })
    const expired = await clerk.sessionToken({ userId: 'user_alice', azp: EXT, expiresInSec: -60 })
    for (const bad of ['not-a-jwt', forged, expired]) {
      expect((await chat(bad)).status).toBe(401)
    }
    expect(ai.calls).toHaveLength(0)
  })

  it('session issued to another site is refused', async () => {
    const elsewhere = await clerk.sessionToken({ userId: 'user_alice', azp: 'https://evil.example' })
    expect((await chat(elsewhere)).status).toBe(401)
  })
})

describe('UC-CHAT-001 Ask the AI from the side panel', () => {
  it('reply streams as server-sent events', async () => {
    const res = await chat(token, { messages: hi, stream: true })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    const text = (await res.text())
      .split('\n\n')
      .filter((l) => l.startsWith('data: ') && l !== 'data: [DONE]')
      .map((l) => JSON.parse(l.slice(6)).choices[0]?.delta.content ?? '')
      .join('')
    expect(text).toBe('Hello from Workers AI ')
  })

  it('asking for another model is refused', async () => {
    const res = await chat(token, { messages: hi, model: 'openai/gpt-5' })
    expect(res.status).toBe(400)
    expect((await json(res)).error.code).toBe('unsupported_model')
    expect(ai.calls).toHaveLength(0)
  })
})

// Standalone tests: implementation behavior worth guarding, not product contract (see docs/bdd.md).
describe('worker API', () => {
  it('GET /health needs no session (infrastructure)', async () => {
    expect((await req('GET', '/health')).status).toBe(200)
  })

  it('/v1/me returns the Clerk user id and model', async () => {
    const res = await req('GET', '/v1/me', token)
    expect(res.status).toBe(200)
    expect(await json(res)).toEqual({ userId: 'user_alice', model: MODEL })
  })

  it('a session from any allowed origin is accepted', async () => {
    const web = await clerk.sessionToken({ userId: 'user_alice', azp: 'https://confluco.example' })
    expect((await chat(web)).status).toBe(200)
  })

  it('a session without an origin (Clerk Native API) is accepted', async () => {
    const native = await clerk.sessionToken({ userId: 'user_alice' })
    const res = await app.request('/v1/me', { headers: { authorization: `Bearer ${native}` } }, env)
    expect(res.status).toBe(200)
    expect((await json(res)).userId).toBe('user_alice')
  })

  it('API is off without the JWT key', async () => {
    env.CLERK_JWT_KEY = undefined
    const res = await chat(token)
    expect(res.status).toBe(503)
    expect((await json(res)).error.code).toBe('not_configured')
  })

  it('API is off without allowed origins', async () => {
    env.CLERK_AUTHORIZED_PARTIES = ''
    const res = await chat(token)
    expect(res.status).toBe(503)
    expect((await json(res)).error.code).toBe('not_configured')
  })

  it('extension origin passes CORS preflight', async () => {
    const res = await app.request(
      '/v1/chat/completions',
      { method: 'OPTIONS', headers: { origin: EXT, 'access-control-request-method': 'POST' } },
      env,
    )
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
  })

  it('sign-in page loads Clerk with the publishable key', async () => {
    env.CLERK_PUBLISHABLE_KEY = 'pk_test_ZXhhbXBsZS5jbGVyay5hY2NvdW50cy5kZXYk' // example.clerk.accounts.dev
    const res = await req('GET', '/login')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/html/)
    const html = await res.text()
    expect(res.headers.get('content-security-policy')).toBe("frame-ancestors 'none'")
    expect(res.headers.get('x-frame-options')).toBe('DENY')
    expect(html).toContain('data-clerk-publishable-key="pk_test_ZXhhbXBsZS5jbGVyay5hY2NvdW50cy5kZXYk"')
    expect(html).toContain('src="https://example.clerk.accounts.dev/npm/@clerk/clerk-js@6/dist/clerk.browser.js"')
    expect(html).toContain('src="https://example.clerk.accounts.dev/npm/@clerk/ui@1/dist/ui.browser.js"')
  })

  it('root URL redirects to the sign-in page', async () => {
    const res = await req('GET', '/')
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/login')
  })

  it('sign-in page is off without a publishable key', async () => {
    expect((await req('GET', '/login')).status).toBe(503)
  })

  it('non-streamed reply goes through the gateway tagged with the user', async () => {
    const res = await chat(token, { messages: hi, max_tokens: 50 })
    expect(res.status).toBe(200)
    expect((await json(res)).choices[0].message.content).toBe('Hello from Workers AI')
    expect(ai.calls[0]).toEqual({
      model: MODEL,
      inputs: { messages: hi, max_tokens: 50 },
      options: {
        gateway: {
          id: 'gw-test',
          collectLog: false,
          skipCache: true,
          metadata: { app: 'confluco', user: 'user_alice' },
        },
      },
    })
  })

  it('without a gateway the model is called directly', async () => {
    env.AI_GATEWAY_ID = ''
    await chat(token)
    expect(ai.calls[0].options).toBeUndefined()
  })

  it('invalid bodies are rejected without calling the model', async () => {
    expect((await chat(token, { messages: [] })).status).toBe(400)
    expect((await chat(token, [1])).status).toBe(400)
    expect((await chat(token, { messages: [{ role: 'tool', content: 'x' }] })).status).toBe(400)
    expect((await chat(token, { messages: [{ role: 'user', content: 1 }] })).status).toBe(400)
    expect((await chat(token, { messages: [{ role: 'user', content: 'x'.repeat(200_001) }] })).status).toBe(400)
    expect((await chat(token, { messages: hi, max_tokens: 100_000 })).status).toBe(400)
    expect((await chat(token, { messages: hi, stream: 'false' })).status).toBe(400)
    expect(ai.calls).toHaveLength(0)
  })

  it('passes only role and content to the model, and defaults max_tokens when unset', async () => {
    await chat(token, { messages: [{ role: 'user', content: 'hi', name: 'x', extra: 1 }], max_tokens: null })
    expect(ai.calls[0].inputs).toEqual({ messages: [{ role: 'user', content: 'hi' }], max_tokens: 16_384 })
  })

  it('naming the server model is allowed', async () => {
    expect((await chat(token, { messages: hi, model: MODEL })).status).toBe(200)
  })

  it('model failure returns 502', async () => {
    ai.failWith = new Error('capacity')
    const res = await chat(token)
    expect(res.status).toBe(502)
    const { error } = await json(res)
    expect(error.code).toBe('provider_error')
    expect(error.message).not.toContain('capacity')
  })
})

describe('UC-CHAT-001 daily quota', () => {
  beforeEach(() => {
    env.DAILY_REQUEST_LIMIT = '2'
  })

  it("a user over today's quota is refused and the model is not called", async () => {
    expect((await chat(token)).status).toBe(200)
    expect((await chat(token)).status).toBe(200)
    const res = await chat(token)
    expect(res.status).toBe(429)
    const { error } = await json(res)
    expect(error.code).toBe('rate_limited')
    expect(error.message).toContain('00:00 UTC')
    expect(ai.calls).toHaveLength(2)
  })

  it('the quota resets at 00:00 UTC', async () => {
    clock = new Date('2026-11-08T23:59:59Z')
    await chat(token)
    await chat(token)
    expect((await chat(token)).status).toBe(429)
    clock = new Date('2026-11-09T00:00:00Z')
    expect((await chat(token)).status).toBe(200)
  })

  it('each user has their own quota', async () => {
    await chat(token)
    await chat(token)
    expect((await chat(token)).status).toBe(429)
    const bob = await clerk.sessionToken({ userId: 'user_bob', azp: EXT })
    expect((await chat(bob)).status).toBe(200)
  })

  it('rejected requests do not use up the quota', async () => {
    await chat(undefined)
    await chat(token, { messages: [] })
    await chat(token, { messages: hi, model: 'other' })
    expect((await chat(token)).status).toBe(200)
    expect((await chat(token)).status).toBe(200)
  })

  it('a request stamped with an earlier day does not reset the quota', async () => {
    clock = new Date('2026-11-09T00:00:01Z')
    await chat(token)
    await chat(token)
    // Another instance whose clock still reads the previous day.
    clock = new Date('2026-11-08T23:59:59Z')
    expect((await chat(token)).status).toBe(429)
    clock = new Date('2026-11-09T00:00:02Z')
    expect((await chat(token)).status).toBe(429)
  })

  it('an unavailable quota counter refuses the request without calling the model', async () => {
    quota.failWith = new Error('Durable Object reset because its code was updated')
    const res = await chat(token)
    expect(res.status).toBe(503)
    const { error } = await json(res)
    expect(error.code).toBe('quota_unavailable')
    expect(error.message).not.toContain('Durable Object')
    expect(ai.calls).toHaveLength(0)
  })

  it('a limit of 0 turns chat off without promising a reset', async () => {
    env.DAILY_REQUEST_LIMIT = '0'
    const res = await chat(token)
    expect(res.status).toBe(503)
    const { error } = await json(res)
    expect(error.code).toBe('chat_disabled')
    expect(error.message).not.toContain('00:00 UTC')
    expect(ai.calls).toHaveLength(0)
  })

  it('chat is off without a valid daily limit', async () => {
    for (const bad of [undefined, '', 'abc', '-1']) {
      env.DAILY_REQUEST_LIMIT = bad
      expect((await chat(token)).status).toBe(503)
    }
    expect(ai.calls).toHaveLength(0)
  })
})

/** Reads a usage data point back into named fields, following the layout in src/usage.ts. */
function usageRecord(point: FakeUsageDataset['points'][number]) {
  const [userId] = point.indexes ?? []
  const [model, outcome, finishReason, mode] = point.blobs ?? []
  const [messages, inputChars, promptTokens, completionTokens, durationMs] = point.doubles ?? []
  return {
    userId,
    model,
    outcome,
    finishReason,
    mode,
    messages,
    inputChars,
    promptTokens,
    completionTokens,
    durationMs,
  }
}
const records = () => usage.points.map(usageRecord)

describe("UC-CHAT-002 Keep a record of each user's chat usage", () => {
  const two = [
    { role: 'system', content: 'be brief' },
    { role: 'user', content: 'hello' },
  ]

  it('a streamed reply leaves a record with its token counts', async () => {
    const res = await chat(token, { messages: two, stream: true })
    expect(res.status).toBe(200)
    await res.text()
    expect(records()).toEqual([
      {
        userId: 'user_alice',
        model: MODEL,
        outcome: 'ok',
        finishReason: 'stop',
        mode: 'stream',
        messages: 2,
        inputChars: 13,
        promptTokens: FAKE_USAGE.prompt_tokens,
        completionTokens: FAKE_USAGE.completion_tokens,
        durationMs: expect.any(Number),
      },
    ])
    expect(records()[0].durationMs).toBeGreaterThanOrEqual(0)
    expect(ai.calls[0].inputs.stream_options).toEqual({ include_usage: true })
  })

  it('a non-streamed reply leaves a record with its token counts', async () => {
    expect((await chat(token, { messages: two })).status).toBe(200)
    expect(records()).toEqual([
      expect.objectContaining({
        userId: 'user_alice',
        outcome: 'ok',
        finishReason: 'stop',
        mode: 'sync',
        messages: 2,
        inputChars: 13,
        promptTokens: FAKE_USAGE.prompt_tokens,
        completionTokens: FAKE_USAGE.completion_tokens,
      }),
    ])
  })

  it('refused and failed requests leave a record of how they ended', async () => {
    env.DAILY_REQUEST_LIMIT = '1'
    await chat(token, { messages: [] })
    await chat(token)
    await chat(token)
    env.DAILY_REQUEST_LIMIT = '100'
    ai.failWith = new Error('capacity')
    await chat(token)
    ai.failWith = undefined
    quota.failWith = new Error('Durable Object reset')
    await chat(token)
    expect(records().map((r) => r.outcome)).toEqual([
      'bad_request',
      'ok',
      'rate_limited',
      'provider_error',
      'quota_unavailable',
    ])
    expect(records().every((r) => r.userId === 'user_alice')).toBe(true)
  })

  it('a stream that breaks off leaves a record of how it ended', async () => {
    ai.streamFailWith = new Error('connection reset')
    const res = await chat(token, { messages: hi, stream: true })
    await expect(res.text()).rejects.toThrow('connection reset')
    expect(records().map((r) => r.outcome)).toEqual(['stream_error'])
  })

  it('a stream that ends early without an error is recorded as incomplete', async () => {
    const sse = 'data: {"choices":[{"delta":{"content":"a"}}]}\n\n'
    ai.rawSse = sse
    expect(await (await chat(token, { messages: hi, stream: true })).text()).toBe(sse)
    expect(records().map((r) => r.outcome)).toEqual(['incomplete'])
  })

  it('nothing users wrote or the AI replied is kept', async () => {
    const SECRET = 'zebra-7f3a-confidential'
    ai = env.AI = new FakeAiBinding(`reply ${SECRET}-reply`)
    const messages = [
      { role: 'system', content: `system ${SECRET}-system` },
      { role: 'user', content: `page ${SECRET}-user` },
      { role: 'assistant', content: `earlier ${SECRET}-assistant` },
    ]
    await (await chat(token, { messages, stream: true })).text()
    await chat(token, { messages })
    await chat(token, { messages, model: `${SECRET}-model` })
    expect(records()).toHaveLength(3)
    expect(JSON.stringify(usage.points)).not.toContain(SECRET)
    // The gateway is told not to keep prompts and replies in its logs or its cache.
    expect(
      ai.calls.every((call) => {
        const gateway = call.options?.gateway as { collectLog?: boolean; skipCache?: boolean } | undefined
        return gateway?.collectLog === false && gateway.skipCache === true
      }),
    ).toBe(true)
  })
})

// Standalone tests for usage records.
describe('usage records', () => {
  it('a stream that carries a model error is recorded as provider_error', async () => {
    ai.rawSse = 'data: {"error":{"message":"model overloaded"}}\n\ndata: [DONE]\n\n'
    await (await chat(token, { messages: hi, stream: true })).text()
    expect(records().map((r) => r.outcome)).toEqual(['provider_error'])
  })

  it('a reply that cannot be sent is recorded once', async () => {
    env.AI = {
      async run() {
        return { usage: { prompt_tokens: 1n } }
      },
    }
    expect((await chat(token)).status).toBe(500)
    expect(records().map((r) => r.outcome)).toEqual(['internal'])
  })

  it('requests that fail auth leave no record', async () => {
    await chat(undefined)
    await chat('not-a-jwt')
    expect(usage.points).toHaveLength(0)
  })

  it('a stream the client cancels is recorded as cancelled', async () => {
    const res = await chat(token, { messages: hi, stream: true })
    const reader = res.body!.getReader()
    await reader.read()
    await reader.cancel()
    expect(records().map((r) => r.outcome)).toEqual(['cancelled'])
  })

  it('the stream reaches the client unchanged', async () => {
    const sse = 'data: {"choices":[{"delta":{"content":"a"}}]}\n\ndata: [DONE]\n\n'
    ai.rawSse = sse
    expect(await (await chat(token, { messages: hi, stream: true })).text()).toBe(sse)
    expect(records()[0]).toMatchObject({ outcome: 'ok', promptTokens: 0, completionTokens: 0, finishReason: '' })
  })

  it('reads the totals from a Workers AI stream with per-chunk usage', async () => {
    // Shape recorded from the production model: per-chunk usage, a zeroed chunk, then the totals.
    const usageOf = (p: number, c: number) => ({ prompt_tokens: p, completion_tokens: c, total_tokens: p + c })
    ai.rawSse = [
      { choices: [{ index: 0, delta: { content: 'Hi' }, finish_reason: null }], usage: usageOf(0, 2) },
      { choices: [{ index: 0, delta: { content: '!' }, finish_reason: 'length' }], usage: usageOf(0, 4) },
      { choices: [], usage: usageOf(0, 0) },
      { response: '', usage: usageOf(36, 30) },
    ]
      .map((e) => `data: ${JSON.stringify(e)}\n\n`)
      .join('')
      .concat('data: [DONE]\n\n')
    await (await chat(token, { messages: hi, stream: true })).text()
    expect(records()[0]).toMatchObject({
      outcome: 'ok',
      finishReason: 'length',
      promptTokens: 36,
      completionTokens: 30,
    })
  })

  it('unknown finish reasons and malformed token counts are not copied into records', async () => {
    ai.rawSse =
      'data: {"choices":[{"delta":{},"finish_reason":"free text"}],"usage":{"prompt_tokens":"9","completion_tokens":-1}}\n\ndata: [DONE]\n\n'
    await (await chat(token, { messages: hi, stream: true })).text()
    expect(records()[0]).toMatchObject({ finishReason: 'other', promptTokens: 0, completionTokens: 0 })
  })

  it('non-object events in the stream are passed through and skipped', async () => {
    const sse = 'data: null\n\ndata: 3\n\ndata: {"choices":[{"delta":{"content":"a"}}]}\n\ndata: [DONE]\n\n'
    ai.rawSse = sse
    expect(await (await chat(token, { messages: hi, stream: true })).text()).toBe(sse)
    expect(records().map((r) => r.outcome)).toEqual(['ok'])
  })

  it('reads the fields of a reply loosely: a field of another shape counts as missing', async () => {
    const replies: [unknown, Record<string, unknown>][] = [
      [
        { choices: { 0: { finish_reason: 'length' } }, usage: [] },
        { finishReason: 'length', promptTokens: 0 },
      ],
      [
        { choices: 'stop', usage: 'x' },
        { finishReason: '', promptTokens: 0 },
      ],
      [
        { choices: [null, { finish_reason: 'stop' }], usage: { prompt_tokens: 7 } },
        { finishReason: '', promptTokens: 7 },
      ],
      [['stop'], { finishReason: '', promptTokens: 0 }],
    ]
    for (const [reply, recorded] of replies) {
      env.USAGE = usage = new FakeUsageDataset()
      env.AI = {
        async run() {
          return reply
        },
      }
      const res = await chat(token)
      // The reply itself goes to the client as the model gave it.
      expect([res.status, await json(res)]).toEqual([200, reply])
      expect(records()[0]).toMatchObject({ outcome: 'ok', ...recorded })
    }
  })

  it('a non-streamed reply without usage is still recorded', async () => {
    env.AI = {
      async run() {
        return null
      },
    }
    expect((await chat(token)).status).toBe(200)
    expect(records()[0]).toMatchObject({ outcome: 'ok', promptTokens: 0, completionTokens: 0, finishReason: '' })
  })

  it('a streamed request refused before the model is called is recorded as streamed', async () => {
    await chat(token, { messages: [], stream: true })
    await chat(token, { messages: hi, max_tokens: 100_000, stream: true })
    expect(records().map((r) => [r.outcome, r.mode])).toEqual([
      ['bad_request', 'stream'],
      ['bad_request', 'stream'],
    ])
  })

  it('a failing usage dataset does not fail the request', async () => {
    env.USAGE = {
      writeDataPoint() {
        throw new Error('dataset unavailable')
      },
    }
    expect((await chat(token)).status).toBe(200)
  })
})

const pageTool = {
  type: 'function',
  function: {
    name: 'get_current_page',
    description: 'Returns the title and URL of the sample page open in the current tab.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
}
const searchTool = {
  type: 'function',
  function: {
    name: 'search_pages',
    description: 'Searches sample pages by keyword.',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
}
const tools = [pageTool, searchTool]
const askPage = [{ role: 'user', content: 'Which sample page am I on?' }]
/** The conversation after the extension ran get_current_page. */
const withToolResult = (result: string) => [
  ...askPage,
  {
    role: 'assistant',
    content: null,
    tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_current_page', arguments: '{}' } }],
  },
  { role: 'tool', tool_call_id: 'call_1', content: result },
]

/** Reads a streamed reply back the way an OpenAI client does: text, tool calls by index, and the finish reason. */
async function readStream(res: Response) {
  let text = ''
  let finishReason: string | undefined
  const calls: { id?: string; name?: string; arguments: string }[] = []
  for (const event of (await res.text()).split('\n\n')) {
    if (!event.startsWith('data: ') || event === 'data: [DONE]') continue
    const choice = JSON.parse(event.slice(6)).choices?.[0]
    if (!choice) continue
    text += choice.delta?.content ?? ''
    for (const d of choice.delta?.tool_calls ?? []) {
      const call = (calls[d.index] ??= { arguments: '' })
      if (d.id) call.id = d.id
      if (d.function?.name) call.name = d.function.name
      call.arguments += d.function?.arguments ?? ''
    }
    if (choice.finish_reason) finishReason = choice.finish_reason
  }
  return { text, calls, finishReason }
}

describe('UC-AGENT-001 Ask the AI something that needs a tool', () => {
  it('the streamed reply asks the extension to run tools, with their arguments', async () => {
    ai = env.AI = new FakeAiBinding("I'll check.")
    ai.toolCalls = [
      { name: 'get_current_page', arguments: '{}' },
      { name: 'search_pages', arguments: '{"query": "quarterly planning"}' },
    ]
    const res = await chat(token, { messages: askPage, tools, stream: true })
    expect(res.status).toBe(200)
    const reply = await readStream(res)
    expect(reply.finishReason).toBe('tool_calls')
    expect(reply.calls).toEqual([
      { id: 'chatcmpl-tool-0', name: 'get_current_page', arguments: '{}' },
      { id: 'chatcmpl-tool-1', name: 'search_pages', arguments: '{"query": "quarterly planning"}' },
    ])
    expect(JSON.parse(reply.calls[1].arguments)).toEqual({ query: 'quarterly planning' })
    // The model was offered the extension's tools.
    expect(ai.calls[0].inputs.tools).toEqual(tools)
  })

  it('the non-streamed reply asks the extension to run a tool', async () => {
    ai.toolCalls = [{ name: 'get_current_page', arguments: '{}' }]
    const res = await chat(token, { messages: askPage, tools })
    expect(res.status).toBe(200)
    const { choices } = await json(res)
    expect(choices[0].finish_reason).toBe('tool_calls')
    expect(choices[0].message.tool_calls).toEqual([
      { id: 'chatcmpl-tool-0', type: 'function', function: { name: 'get_current_page', arguments: '{}' } },
    ])
  })

  it('the AI answers from the tool result the extension sends back', async () => {
    ai = env.AI = new FakeAiBinding('You are on Q4 Roadmap')
    const result = JSON.stringify({
      title: 'Q4 Roadmap',
      url: 'https://example.atlassian.net/wiki/spaces/ENG/pages/123',
    })
    const res = await chat(token, { messages: withToolResult(result), tools, stream: true })
    expect(res.status).toBe(200)
    expect((await readStream(res)).text).toBe('You are on Q4 Roadmap ')
    // The model got the whole exchange: the question, its own tool call, and the result.
    expect(ai.calls[0].inputs.messages).toEqual([
      ...askPage,
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_current_page', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: result },
    ])
  })

  it('nothing in tool definitions, calls, or results is kept', async () => {
    const SECRET = 'okapi-91c2-confidential'
    ai = env.AI = new FakeAiBinding(`checking ${SECRET}-preamble`)
    ai.toolCalls = [{ name: 'search_pages', arguments: JSON.stringify({ query: `${SECRET}-arguments` }) }]
    const secretTools = [
      {
        type: 'function',
        function: {
          name: 'search_pages',
          description: `${SECRET}-description`,
          parameters: { type: 'object', properties: { [`${SECRET}-param`]: { type: 'string' } } },
        },
      },
    ]
    const messages = [
      { role: 'user', content: `find ${SECRET}-user` },
      {
        role: 'assistant',
        content: `${SECRET}-assistant`,
        tool_calls: [
          { id: `${SECRET}-id`, type: 'function', function: { name: 'search_pages', arguments: `"${SECRET}-args"` } },
        ],
      },
      { role: 'tool', tool_call_id: `${SECRET}-id`, content: `${SECRET}-result` },
    ]
    await (await chat(token, { messages, tools: secretTools, stream: true })).text()
    await chat(token, { messages, tools: secretTools })
    expect(records()).toHaveLength(2)
    expect(records().map((r) => r.finishReason)).toEqual(['tool_calls', 'tool_calls'])
    expect(JSON.stringify(usage.points)).not.toContain(SECRET)
    expect(
      ai.calls.every((call) => {
        const gateway = call.options?.gateway as { collectLog?: boolean; skipCache?: boolean } | undefined
        return gateway?.collectLog === false && gateway.skipCache === true
      }),
    ).toBe(true)
  })
})

describe('tool calling', () => {
  it('a streamed tool call leaves a record with its totals and finish reason', async () => {
    ai.toolCalls = [{ name: 'get_current_page', arguments: '{}' }]
    await (await chat(token, { messages: askPage, tools, stream: true })).text()
    expect(records()).toEqual([
      expect.objectContaining({
        outcome: 'ok',
        finishReason: 'tool_calls',
        promptTokens: FAKE_USAGE.prompt_tokens,
        completionTokens: FAKE_USAGE.completion_tokens,
      }),
    ])
  })

  it('tool definitions and tool calls count toward the size limit and the record', async () => {
    await chat(token, { messages: withToolResult('{"title":"x"}'), tools: [pageTool] })
    const { inputChars } = records()[0]
    const toolCalls = [{ id: 'call_1', type: 'function', function: { name: 'get_current_page', arguments: '{}' } }]
    const result = '{"title":"x"}'
    expect(inputChars).toBe(
      askPage[0].content.length +
        JSON.stringify(toolCalls).length +
        'call_1'.length +
        result.length +
        JSON.stringify([pageTool]).length,
    )

    const big = 'x'.repeat(200_001)
    const tooBig = [
      { messages: askPage, tools: [{ type: 'function', function: { name: 'f', description: big } }] },
      {
        messages: [
          ...askPage,
          {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'c', type: 'function', function: { name: 'f', arguments: big } }],
          },
          { role: 'tool', tool_call_id: 'c', content: '{}' },
        ],
      },
      { messages: [...withToolResult(big)] },
    ]
    for (const body of tooBig) expect((await chat(token, body)).status).toBe(400)
    expect(ai.calls).toHaveLength(1)
  })

  it('passes only the tool fields the model needs', async () => {
    await chat(token, {
      messages: [
        ...askPage,
        {
          role: 'assistant',
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'get_current_page', arguments: '{}', x: 1 }, x: 1 },
          ],
          refusal: null,
        },
        { role: 'tool', tool_call_id: 'call_1', content: '{}', name: 'get_current_page' },
      ],
      tools: [{ ...pageTool, function: { ...pageTool.function, strict: true }, extra: 1 }],
      tool_choice: { type: 'function', function: { name: 'get_current_page', x: 1 } },
      parallel_tool_calls: false,
    })
    expect(ai.calls[0].inputs).toEqual({
      messages: [
        ...askPage,
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_current_page', arguments: '{}' } }],
        },
        { role: 'tool', tool_call_id: 'call_1', content: '{}' },
      ],
      tools: [pageTool],
      tool_choice: { type: 'function', function: { name: 'get_current_page' } },
      max_tokens: 16_384,
    })
  })

  it('says what is wrong with each part of a request, and the first thing when several are', async () => {
    const call = { id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }
    const tool = { type: 'function', function: { name: 'f' } }
    const refused: [unknown, string][] = [
      [[], 'body must be a JSON object'],
      [{}, 'messages must be a non-empty array'],
      [{ messages: [] }, 'messages must be a non-empty array'],
      [{ messages: Array.from({ length: 201 }, () => askPage[0]) }, 'at most 200 messages'],
      [{ messages: ['hi'] }, 'each message must be an object'],
      [{ messages: [{ content: 'hi' }] }, 'each message needs a role: system, user, assistant, or tool'],
      [{ messages: [{ role: 'user', content: 5 }] }, 'user messages need string content'],
      [{ messages: [{ role: 'system' }] }, 'system messages need string content'],
      [{ messages: [{ role: 'assistant' }] }, 'assistant messages need string content or tool_calls'],
      [
        { messages: [{ role: 'assistant', content: 5, tool_calls: [call] }] },
        'assistant content must be a string or null',
      ],
      [{ messages: [{ role: 'assistant', tool_calls: [] }] }, 'tool_calls must be an array of 1 to 32 calls'],
      [
        { messages: [{ role: 'assistant', tool_calls: [{ ...call, type: 'tool' }] }] },
        'each tool call needs an id, type "function", and a function with a name and string arguments',
      ],
      [{ messages: [{ role: 'tool', content: 'r' }] }, 'tool messages need a tool_call_id and string content'],
      // An id is at most 256 characters as JavaScript counts them, emoji (two each) included.
      [
        { messages: [{ role: 'assistant', tool_calls: [{ ...call, id: '😀'.repeat(128) + 'x' }] }] },
        'each tool call needs an id, type "function", and a function with a name and string arguments',
      ],
      [
        { messages: [{ role: 'tool', tool_call_id: '😀'.repeat(128) + 'x', content: 'r' }] },
        'tool messages need a tool_call_id and string content',
      ],
      [
        { messages: [{ role: 'tool', tool_call_id: 'c1', content: 'r' }] },
        'each tool message must answer a call from the assistant message before it',
      ],
      [
        { messages: [{ role: 'assistant', tool_calls: [call] }, askPage[0]] },
        'each tool call needs its result right after the assistant message',
      ],
      [{ messages: [{ role: 'assistant', tool_calls: [call, call] }] }, 'tool call ids in one message must be unique'],
      [{ messages: askPage, tools: [] }, 'tools must be an array of 1 to 64 tools'],
      [
        { messages: askPage, tools: [{ type: 'function' }] },
        'each tool needs type "function" and a function definition',
      ],
      [
        { messages: askPage, tools: [{ type: 'function', function: { name: 'bad name' } }] },
        'tool names are 1 to 64 letters, digits, underscores, or dashes',
      ],
      [{ messages: askPage, tools: [tool, tool] }, 'tool f is defined twice'],
      // Tools are read in order: a name given twice is said before what is wrong with it, or with a later tool.
      [
        { messages: askPage, tools: [tool, { type: 'function', function: { name: 'f', description: 5 } }] },
        'tool f is defined twice',
      ],
      [
        { messages: askPage, tools: [tool, tool, { type: 'function', function: { name: 'bad name' } }] },
        'tool f is defined twice',
      ],
      [
        { messages: askPage, tools: [{ type: 'function', function: { name: 'f', description: 5 } }] },
        'tool descriptions must be strings',
      ],
      [
        { messages: askPage, tools: [{ type: 'function', function: { name: 'f', parameters: [] } }] },
        'tool parameters must be an object',
      ],
      [{ messages: askPage, tool_choice: 'auto' }, 'tool_choice needs tools'],
      [
        { messages: askPage, tools: [tool], tool_choice: 'always' },
        'tool_choice must be auto, required, or {"type":"function","function":{"name":...}}',
      ],
      [
        { messages: askPage, tools: [tool], tool_choice: { type: 'function', function: { name: 'g' } } },
        'tool_choice names an unknown tool: g',
      ],
      [{ messages: askPage, max_tokens: 0 }, 'max_tokens must be an integer from 1 to 16384'],
      [{ messages: askPage, stream: 'yes' }, 'stream must be a boolean'],
      // The conversation is checked first, then the tools, then the settings.
      [{ messages: [], tools: [], max_tokens: 0, stream: 1 }, 'messages must be a non-empty array'],
      [{ messages: askPage, tools: [], max_tokens: 0, stream: 1 }, 'tools must be an array of 1 to 64 tools'],
      [
        { messages: askPage, max_tokens: 0, stream: 1, model: 'other' },
        'max_tokens must be an integer from 1 to 16384',
      ],
    ]
    for (const [body, message] of refused) {
      const res = await chat(token, body)
      expect([res.status, await json(res)], JSON.stringify(body).slice(0, 80)).toEqual([
        400,
        { error: { code: 'bad_request', message } },
      ])
    }
    expect(ai.calls).toHaveLength(0)
  })

  it('tools without a description or parameters are allowed', async () => {
    const bare = [{ type: 'function', function: { name: 'ping' } }]
    expect((await chat(token, { messages: askPage, tools: bare })).status).toBe(200)
    expect(ai.calls[0].inputs.tools).toEqual(bare)
  })

  it('tool_choice auto and required are passed to the model', async () => {
    for (const tool_choice of ['auto', 'required']) {
      expect((await chat(token, { messages: askPage, tools, tool_choice })).status).toBe(200)
    }
    expect(ai.calls.map((c) => c.inputs.tool_choice)).toEqual(['auto', 'required'])
  })

  it('tool_choice none is refused, since the model does not honor it', async () => {
    const res = await chat(token, { messages: askPage, tools, tool_choice: 'none' })
    expect(res.status).toBe(400)
    expect((await json(res)).error.message).toContain('leave out tools')
    expect(ai.calls).toHaveLength(0)
  })

  it('each tool call gets one result right after it', async () => {
    const [question, call, result] = withToolResult('{}')
    const pageCall = { id: 'call_1', type: 'function', function: { name: 'get_current_page', arguments: '{}' } }
    const searchCall = { id: 'call_2', type: 'function', function: { name: 'search_pages', arguments: '{}' } }
    const twoCalls = { role: 'assistant', content: '', tool_calls: [pageCall, searchCall] }
    const result2 = { role: 'tool', tool_call_id: 'call_2', content: '[]' }
    const later = { role: 'user', content: 'go on' }
    const bad = [
      [question, result],
      [question, { ...result, tool_call_id: 'call_2' }],
      [question, result, call],
      [question, call],
      [question, call, later, result],
      [question, twoCalls, result],
      [question, twoCalls, result, later, result2],
      // Ids are unique within a message and each call gets one result.
      [question, { ...call, tool_calls: [pageCall, pageCall] }, result],
      [question, call, result, result],
    ]
    for (const messages of bad) expect((await chat(token, { messages })).status).toBe(400)
    expect(ai.calls).toHaveLength(0)
    // The client's id is not echoed back.
    const stray = { ...result, tool_call_id: 'stray-<id>' }
    expect((await json(await chat(token, { messages: [question, stray] }))).error.message).not.toContain('stray')
    // Results for several calls may come in any order.
    expect((await chat(token, { messages: [question, twoCalls, result2, result, later] })).status).toBe(200)
  })

  it('an agent can run several tool rounds, even if ids repeat across rounds', async () => {
    ai.toolCalls = [{ name: 'get_current_page', arguments: '{}' }]
    const messages: unknown[] = [...askPage]
    for (let round = 0; round < 2; round++) {
      const res = await chat(token, { messages, tools, stream: true })
      expect(res.status).toBe(200)
      const reply = await readStream(res)
      const toolCalls = reply.calls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: c.arguments },
      }))
      messages.push({ role: 'assistant', content: reply.text, tool_calls: toolCalls })
      messages.push({ role: 'tool', tool_call_id: toolCalls[0].id, content: '{"title":"Q4 Roadmap"}' })
    }
    ai.toolCalls = undefined
    expect((await chat(token, { messages, tools })).status).toBe(200)
    expect(ai.calls).toHaveLength(3)

    // Clients or other models may number ids per reply; results pair with the calls right before them.
    const [question, call, result] = withToolResult('{}')
    expect((await chat(token, { messages: [question, call, result, call, result] })).status).toBe(200)
  })

  it('tool_choice with a malformed name is refused without echoing it', async () => {
    const name = 'x'.repeat(1000)
    const res = await chat(token, { messages: askPage, tools, tool_choice: { type: 'function', function: { name } } })
    expect(res.status).toBe(400)
    expect((await json(res)).error.message).not.toContain(name)
  })

  it('deeply nested tool parameters are refused, not a server error', async () => {
    // Built as text: parsing this much nesting works, serializing it again does not.
    const depth = 20_000
    const parameters = '{"a":'.repeat(depth) + '{}' + '}'.repeat(depth)
    const body = `{"messages":${JSON.stringify(askPage)},"tools":[{"type":"function","function":{"name":"deep","parameters":${parameters}}}]}`
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` }
    const res = await app.request('/v1/chat/completions', { method: 'POST', headers, body }, env)
    expect(res.status).toBe(400)
    expect(ai.calls).toHaveLength(0)

    // Up to 64 levels is fine; one more is refused.
    const nested = (levels: number) => {
      let p: Record<string, unknown> = {}
      for (let i = 1; i < levels; i++) p = { a: p }
      return [{ type: 'function', function: { name: 'nested', parameters: p } }]
    }
    expect((await chat(token, { messages: askPage, tools: nested(64) })).status).toBe(200)
    expect((await chat(token, { messages: askPage, tools: nested(65) })).status).toBe(400)
  })

  it('invalid tools are rejected without calling the model', async () => {
    const fn = (f: Record<string, unknown>) => [{ type: 'function', function: f }]
    const bad: unknown[] = [
      'get_current_page',
      [],
      Array.from({ length: 65 }, (_, i) => ({ type: 'function', function: { name: `t${i}` } })),
      [{ type: 'code_interpreter' }],
      [{ type: 'function' }],
      fn({ name: 'has space' }),
      fn({ name: 'x'.repeat(65) }),
      fn({ name: 1 }),
      fn({ name: 'f', description: 1 }),
      fn({ name: 'f', parameters: 'object' }),
      fn({ name: 'f', parameters: [] }),
      [pageTool, pageTool],
    ]
    for (const t of bad) expect((await chat(token, { messages: askPage, tools: t })).status).toBe(400)
    expect(ai.calls).toHaveLength(0)
  })

  it('invalid tool_choice is rejected without calling the model', async () => {
    const bad = [
      { tool_choice: 'auto' },
      { tools, tool_choice: 'any' },
      { tools, tool_choice: { type: 'function', function: { name: 'unknown' } } },
      { tools, tool_choice: { type: 'function' } },
      { tools, tool_choice: { function: { name: 'get_current_page' } } },
    ]
    for (const body of bad) expect((await chat(token, { messages: askPage, ...body })).status).toBe(400)
    expect(ai.calls).toHaveLength(0)
  })

  it('invalid tool calls and tool results are rejected without calling the model', async () => {
    const call = { id: 'call_1', type: 'function', function: { name: 'get_current_page', arguments: '{}' } }
    const assistant = (m: Record<string, unknown>) => [...askPage, { role: 'assistant', ...m }]
    const bad: unknown[][] = [
      assistant({}),
      assistant({ content: 1, tool_calls: [call] }),
      assistant({ tool_calls: [] }),
      assistant({ tool_calls: {} }),
      assistant({ tool_calls: Array.from({ length: 33 }, (_, i) => ({ ...call, id: `c${i}` })) }),
      assistant({ tool_calls: [{ ...call, id: '' }] }),
      assistant({ tool_calls: [{ ...call, id: 'x'.repeat(257) }] }),
      assistant({ tool_calls: [{ ...call, type: 'other' }] }),
      assistant({ tool_calls: [{ ...call, function: { name: 'get_current_page', arguments: {} } }] }),
      assistant({ tool_calls: [{ ...call, function: { name: 'bad name', arguments: '{}' } }] }),
      [...askPage, { role: 'tool', content: '{}' }],
      [...askPage, { role: 'tool', tool_call_id: 'call_1', content: { title: 'x' } }],
      [...askPage, { role: 'developer', content: 'x' }],
      [...askPage, null],
    ]
    for (const messages of bad) expect((await chat(token, { messages })).status).toBe(400)
    expect(ai.calls).toHaveLength(0)
  })
})
