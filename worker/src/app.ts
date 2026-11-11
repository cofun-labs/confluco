import { verifyToken } from '@clerk/backend'
import { Hono, type Context } from 'hono'
import { cors } from 'hono/cors'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import * as z from './zod'
import { loginPage } from './login'
import type { QuotaNamespace } from './quota'
import {
  finishReason,
  meterStream,
  recordUsage,
  replyInfo,
  tokenCount,
  type UsageDataset,
  type UsageRecord,
} from './usage'

/** The slice of the Workers AI binding this worker uses. */
export interface AiBinding {
  run(model: string, inputs: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>
}

export interface Env {
  AI: AiBinding
  MODEL: string
  AI_GATEWAY_ID?: string
  /** Clerk publishable key, used by the sign-in page. */
  CLERK_PUBLISHABLE_KEY?: string
  /** Clerk JWT public key (PEM), from Clerk Dashboard > API keys. Verifies session tokens without a network call. */
  CLERK_JWT_KEY?: string
  /** Comma-separated origins allowed to call, e.g. chrome-extension://<id>. Checked against the token's azp claim. */
  CLERK_AUTHORIZED_PARTIES?: string
  /** Per-user daily request counters (Durable Object namespace). */
  QUOTA: QuotaNamespace
  /** Chat requests each user may make per UTC day. */
  DAILY_REQUEST_LIMIT?: string | number
  /** Per-request usage records (Workers Analytics Engine dataset). Never holds message content. */
  USAGE: UsageDataset
}

export interface AppOptions {
  /** Clock used for the daily quota. Tests pass their own to move between days. */
  now?: () => Date
}

type Vars = { userId: string }
type Ctx = Context<{ Bindings: Env; Variables: Vars }>

class HttpError extends Error {
  constructor(
    public status: ContentfulStatusCode,
    public code: string,
    message: string,
  ) {
    super(message)
  }
}

const MAX_MESSAGES = 200
const MAX_TOKENS = 16_384
const MAX_CONTENT_CHARS = 200_000
const MAX_TOOLS = 64
const MAX_TOOL_CALLS = 32
const MAX_ID_CHARS = 256
const MAX_SCHEMA_DEPTH = 64
/** OpenAI's rule for function names. */
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/
const badRequest = (message: string) => new HttpError(400, 'bad_request', message)

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Whether a value can be read as a stream. Judged by the method the worker calls, not by class: the
 * AI binding's stream need not be an instance of this module's `ReadableStream`.
 */
function isStream(value: unknown): value is ReadableStream<Uint8Array> {
  return !!value && typeof value === 'object' && 'getReader' in value && typeof value.getReader === 'function'
}

/** Whether a JSON value nests objects or arrays more than `max` levels deep. Stops at `max`, so it can't overflow. */
function nestedDeeperThan(value: unknown, max: number): boolean {
  if (!value || typeof value !== 'object') return false
  if (max === 0) return true
  return Object.values(value).some((child) => nestedDeeperThan(child, max - 1))
}

// What the worker accepts in a chat request. Every part is a zod schema that keeps only the fields
// the model needs, so anything else a client added is dropped. A request is refused with the first
// thing wrong with it, in the words below: the client is told what the part needs, not zod's own
// description of the mismatch.

/** `schema`, refused with `message` whatever is wrong inside it. */
function part<S extends z.ZodType>(schema: S, message: string) {
  return z.unknown().transform((value, ctx): z.output<S> => {
    const parsed = schema.safeParse(value)
    if (parsed.success) return parsed.data
    ctx.addIssue({ code: 'custom', message })
    return z.NEVER
  })
}

/** The value as `schema` gives it, or a 400 with the first thing wrong with it. */
function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value)
  if (parsed.success) return parsed.data
  throw badRequest(parsed.error.issues[0].message)
}

/** The body: a JSON object. Its fields are checked one by one, in the order the refusals are given. */
const Body = part(
  z.object({
    messages: z.unknown().optional(),
    tools: z.unknown().optional(),
    tool_choice: z.unknown().optional(),
    max_tokens: z.unknown().optional(),
    stream: z.unknown().optional(),
    model: z.unknown().optional(),
  }),
  'body must be a JSON object',
)

/**
 * A tool call's id: 1 to 256 characters as JavaScript counts them. Not `.max()`: zod counts a string
 * over the limit by code point, which would let an id of emoji be twice as long.
 */
const isId = (id: string) => id.length > 0 && id.length <= MAX_ID_CHARS
const Id = z.string().refine(isId)
const ToolName = z.string().regex(TOOL_NAME)

const ToolCalls = part(
  z.array(z.unknown()).min(1).max(MAX_TOOL_CALLS),
  `tool_calls must be an array of 1 to ${MAX_TOOL_CALLS} calls`,
).pipe(
  z.array(
    part(
      z.object({
        id: Id,
        type: z.literal('function'),
        function: z.object({ name: ToolName, arguments: z.string() }),
      }),
      'each tool call needs an id, type "function", and a function with a name and string arguments',
    ),
  ),
)

/** An assistant message: its text, or the tools it called, with text or without. */
const AssistantMessage = z
  .object({ role: z.literal('assistant'), content: z.unknown().optional(), tool_calls: z.unknown().optional() })
  .transform((m, ctx) => {
    const refuse = (message: string) => {
      ctx.addIssue({ code: 'custom', message })
      return z.NEVER
    }
    if (m.tool_calls === undefined || m.tool_calls === null) {
      if (typeof m.content !== 'string') return refuse('assistant messages need string content or tool_calls')
      return { role: m.role, content: m.content }
    }
    if (m.content !== undefined && m.content !== null && typeof m.content !== 'string') {
      return refuse('assistant content must be a string or null')
    }
    const calls = ToolCalls.safeParse(m.tool_calls)
    if (!calls.success) return refuse(calls.error.issues[0].message)
    // The model accepts an empty string next to tool calls; OpenAI clients often send null.
    return { role: m.role, content: m.content ?? '', tool_calls: calls.data }
  })

const TOOL_MESSAGE = 'tool messages need a tool_call_id and string content'

/** One message, with the fields the model needs for its role. */
const Message = part(z.looseObject({}), 'each message must be an object').pipe(
  z.discriminatedUnion(
    'role',
    [
      z.object({ role: z.literal('system'), content: z.string({ error: 'system messages need string content' }) }),
      z.object({ role: z.literal('user'), content: z.string({ error: 'user messages need string content' }) }),
      AssistantMessage,
      z.object({
        role: z.literal('tool'),
        tool_call_id: z.string({ error: TOOL_MESSAGE }).refine(isId, { error: TOOL_MESSAGE }),
        content: z.string({ error: TOOL_MESSAGE }),
      }),
    ],
    { error: 'each message needs a role: system, user, assistant, or tool' },
  ),
)

const Messages = part(z.array(z.unknown()).min(1), 'messages must be a non-empty array')
  .refine((messages) => messages.length <= MAX_MESSAGES, { error: `at most ${MAX_MESSAGES} messages`, abort: true })
  .pipe(z.array(Message))

const TOOL = 'each tool needs type "function" and a function definition'
const TOOL_NAMES = 'tool names are 1 to 64 letters, digits, underscores, or dashes'

/** A tool as far as its name: a function tool. What else its function holds is read after the name is known to be new. */
const ToolHead = z.object(
  {
    type: z.literal('function', { error: TOOL }),
    function: z.looseObject(
      { name: z.string({ error: TOOL_NAMES }).regex(TOOL_NAME, { error: TOOL_NAMES }) },
      { error: TOOL },
    ),
  },
  { error: TOOL },
)

const ToolBody = z.object({
  description: z.string({ error: 'tool descriptions must be strings' }).optional(),
  // Passed on as it is. Bounded, so serializing the request (here and in the AI binding) can never
  // run out of stack.
  parameters: z
    .custom<Record<string, unknown>>(isObject, { error: 'tool parameters must be an object' })
    .refine((parameters) => !nestedDeeperThan(parameters, MAX_SCHEMA_DEPTH), {
      error: `tool parameters are nested more than ${MAX_SCHEMA_DEPTH} levels deep`,
    })
    .optional(),
})

/**
 * The tool definitions: function tools only, with unique names. Tools are read one at a time, so the
 * first thing wrong in the list is what the client is told.
 */
const Tools = part(
  z.array(z.unknown()).min(1).max(MAX_TOOLS),
  `tools must be an array of 1 to ${MAX_TOOLS} tools`,
).transform((list, ctx) => {
  const refuse = (message: string) => {
    ctx.addIssue({ code: 'custom', message })
    return z.NEVER
  }
  const names = new Set<string>()
  const tools: { type: 'function'; function: { name: string } & z.output<typeof ToolBody> }[] = []
  for (const item of list) {
    const head = ToolHead.safeParse(item)
    if (!head.success) return refuse(head.error.issues[0].message)
    const { name } = head.data.function
    if (names.has(name)) return refuse(`tool ${name} is defined twice`)
    names.add(name)
    const body = ToolBody.safeParse(head.data.function)
    if (!body.success) return refuse(body.error.issues[0].message)
    tools.push({ type: 'function', function: { name, ...body.data } })
  }
  return tools
})

// `none` is left out on purpose: the model ignores it and writes fake tool calls into the reply text.
// Clients that want no tool calls leave out `tools`.
const ToolChoice = part(
  z.union([
    z.enum(['auto', 'required']),
    z.object({ type: z.literal('function'), function: z.object({ name: ToolName }) }),
  ]),
  'tool_choice must be auto, required, or {"type":"function","function":{"name":...}}',
)

const MaxTokens = part(z.int().min(1).max(MAX_TOKENS), `max_tokens must be an integer from 1 to ${MAX_TOKENS}`)
const Stream = part(z.boolean().optional(), 'stream must be a boolean')

type Tools = z.output<typeof Tools>

/** What the model gets: the fields it needs from each part of the request, nothing else. */
interface ModelInputs {
  messages: z.output<typeof Messages>
  tools?: Tools
  tool_choice?: z.output<typeof ToolChoice>
}

function parseToolChoice(value: unknown, tools: Tools | undefined): z.output<typeof ToolChoice> {
  if (!tools) throw badRequest('tool_choice needs tools')
  if (value === 'none') throw badRequest('tool_choice none is not supported; leave out tools instead')
  const choice = parse(ToolChoice, value)
  if (typeof choice === 'string') return choice
  const { name } = choice.function
  if (!tools.some((tool) => tool.function.name === name)) {
    throw badRequest(`tool_choice names an unknown tool: ${name}`)
  }
  return choice
}

/**
 * Validates the conversation and tools, and returns only what the model needs.
 * `chars` counts message text, tool calls and results, and tool definitions, so tools can't get around
 * the size limit.
 */
function parseModelInputs(body: z.output<typeof Body>): { inputs: ModelInputs; chars: number } {
  const inputs: ModelInputs = { messages: parse(Messages, body.messages) }
  if (body.tools !== undefined && body.tools !== null) inputs.tools = parse(Tools, body.tools)
  if (body.tool_choice !== undefined && body.tool_choice !== null) {
    inputs.tool_choice = parseToolChoice(body.tool_choice, inputs.tools)
  }

  // As OpenAI requires, an assistant message with tool calls is followed right away by one result per
  // call (in any order), before any other message. Ids only need to be unique within one assistant
  // message: results are paired with the calls right before them.
  let pending = new Set<string>()
  const unanswered = () => badRequest('each tool call needs its result right after the assistant message')
  let chars = 0
  for (const m of inputs.messages) {
    chars += m.content.length
    if (m.role === 'tool') {
      if (!pending.delete(m.tool_call_id)) {
        throw badRequest('each tool message must answer a call from the assistant message before it')
      }
      chars += m.tool_call_id.length
      continue
    }
    if (pending.size) throw unanswered()
    const toolCalls = 'tool_calls' in m ? m.tool_calls : undefined
    if (toolCalls) {
      pending = new Set(toolCalls.map((call) => call.id))
      if (pending.size !== toolCalls.length) throw badRequest('tool call ids in one message must be unique')
      chars += JSON.stringify(toolCalls).length
    }
  }
  if (pending.size) throw unanswered()
  if (inputs.tools) chars += JSON.stringify(inputs.tools).length
  return { inputs, chars }
}

export function createApp({ now = () => new Date() }: AppOptions = {}) {
  const app = new Hono<{ Bindings: Env; Variables: Vars }>()

  // The extension calls from a chrome-extension:// origin. Auth is a bearer token, not cookies.
  app.use('*', cors({ origin: '*', allowHeaders: ['authorization', 'content-type'], maxAge: 86400 }))

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: { code: err.code, message: err.message } }, err.status)
    console.error(err)
    return c.json({ error: { code: 'internal', message: 'internal error' } }, 500)
  })

  app.get('/health', (c) => c.json({ ok: true }))

  // Sign-in page for the extension (Clerk Sync Host).
  app.get('/', (c) => c.redirect('/login'))
  app.get('/login', (c) => {
    if (!c.env.CLERK_PUBLISHABLE_KEY) throw new HttpError(503, 'not_configured', 'CLERK_PUBLISHABLE_KEY is not set')
    // This page holds the Clerk session the extension syncs from, so no other site may frame it.
    c.header('content-security-policy', "frame-ancestors 'none'")
    c.header('x-frame-options', 'DENY')
    return c.html(loginPage(c.env.CLERK_PUBLISHABLE_KEY))
  })

  // ---- Clerk session auth for /v1/* ----

  app.use('/v1/*', async (c, next) => {
    const jwtKey = c.env.CLERK_JWT_KEY
    if (!jwtKey) throw new HttpError(503, 'not_configured', 'CLERK_JWT_KEY is not set')

    const header = c.req.header('authorization') ?? ''
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
    if (!token) throw new HttpError(401, 'unauthorized', 'sign in first')

    const authorizedParties = (c.env.CLERK_AUTHORIZED_PARTIES ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    if (!authorizedParties.length) throw new HttpError(503, 'not_configured', 'CLERK_AUTHORIZED_PARTIES is not set')
    let claims: Awaited<ReturnType<typeof verifyToken>>
    try {
      claims = await verifyToken(token, { jwtKey })
    } catch {
      throw new HttpError(401, 'unauthorized', 'invalid or expired session')
    }
    // Clerk sets azp to the origin that requested the token. Tokens the extension
    // gets through Clerk's Native API have no origin, so they carry no azp.
    // A token with an azp must come from an allowed origin.
    const azp = typeof claims.azp === 'string' ? claims.azp : undefined
    if (azp && !authorizedParties.includes(azp)) {
      throw new HttpError(401, 'unauthorized', 'invalid or expired session')
    }
    c.set('userId', claims.sub)
    await next()
  })

  app.get('/v1/me', (c) => c.json({ userId: c.get('userId'), model: c.env.MODEL }))

  // OpenAI-compatible chat completions. The model is fixed by the server.
  // Every request that passed auth leaves one usage record, however it ends.
  app.post('/v1/chat/completions', async (c) => {
    const started = Date.now()
    const usage: UsageRecord = {
      userId: c.get('userId'),
      model: c.env.MODEL,
      stream: false,
      outcome: '',
      messages: 0,
      inputChars: 0,
      promptTokens: 0,
      completionTokens: 0,
      finishReason: '',
      durationMs: 0,
    }
    const record = (outcome: string) => {
      usage.outcome = outcome
      usage.durationMs = Date.now() - started
      recordUsage(c.env.USAGE, usage)
    }
    try {
      return await chatCompletion(c, usage, record)
    } catch (err) {
      record(err instanceof HttpError ? err.code : 'internal')
      throw err
    }
  })

  /**
   * Fills `usage` with sizes and token counts only, and calls `record` once the reply is complete.
   * Throws HttpError for refusals; the caller records those.
   */
  async function chatCompletion(c: Ctx, usage: UsageRecord, record: (outcome: string) => void): Promise<Response> {
    const body = parse(Body, await c.req.json().catch(() => undefined))
    usage.stream = body.stream === true
    const { inputs: modelInputs, chars } = parseModelInputs(body)
    usage.messages = modelInputs.messages.length
    usage.inputChars = chars
    if (chars > MAX_CONTENT_CHARS)
      throw new HttpError(400, 'bad_request', `messages and tools exceed ${MAX_CONTENT_CHARS} characters`)
    // null means not set.
    const max_tokens =
      body.max_tokens === undefined || body.max_tokens === null ? undefined : parse(MaxTokens, body.max_tokens)
    const stream = parse(Stream, body.stream)
    if (body.model !== undefined && body.model !== c.env.MODEL) {
      // A distinct code lets a client that cached the old model name notice and look it up again.
      throw new HttpError(400, 'unsupported_model', `unsupported model; use ${c.env.MODEL} or omit it`)
    }

    // Count the request once it is valid, before the model is called. A failed model call
    // still counts: the quota caps attempts, so retry loops can't get around it.
    const rawLimit = String(c.env.DAILY_REQUEST_LIMIT ?? '').trim()
    if (!/^\d+$/.test(rawLimit)) {
      throw new HttpError(503, 'not_configured', 'DAILY_REQUEST_LIMIT must be a non-negative integer')
    }
    const limit = Number(rawLimit)
    if (limit === 0) throw new HttpError(503, 'chat_disabled', 'Chat is turned off for now. Try again later.')
    const today = now().toISOString().slice(0, 10)
    let allowed: boolean
    try {
      allowed = await c.env.QUOTA.getByName(c.get('userId')).consume(today, limit)
    } catch (err) {
      console.error('quota check failed', err)
      throw new HttpError(503, 'quota_unavailable', 'Usage tracking is unavailable, try again in a moment.')
    }
    if (!allowed) {
      throw new HttpError(
        429,
        'rate_limited',
        `You have used all ${limit} requests for today. The quota resets at 00:00 UTC.`,
      )
    }

    // Pass only the fields the model needs; drop anything else a client added.
    const inputs: Record<string, unknown> = { ...modelInputs }
    // Without an explicit limit, models fall back to their own default, which can be
    // small enough to cut replies short.
    inputs.max_tokens = max_tokens ?? MAX_TOKENS
    if (stream === true) {
      inputs.stream = true
      // Ask for token usage in the final chunk, so streamed replies can be metered too.
      inputs.stream_options = { include_usage: true }
    }
    // collectLog: false keeps prompts and replies out of the gateway logs, and skipCache: true
    // keeps them out of its cache even if caching is turned on in the dashboard. The gateway's
    // analytics (requests, tokens, cost, metadata) still work.
    const options = c.env.AI_GATEWAY_ID
      ? {
          gateway: {
            id: c.env.AI_GATEWAY_ID,
            collectLog: false,
            skipCache: true,
            metadata: { app: 'confluco', user: c.get('userId') },
          },
        }
      : undefined

    let out: unknown
    try {
      out = await c.env.AI.run(c.env.MODEL, inputs, options)
    } catch (err) {
      // Details go to Workers Logs, not to the client.
      console.error('model call failed', err)
      throw new HttpError(502, 'provider_error', 'the model is unavailable, try again later')
    }

    if (stream === true) {
      // Workers AI already streams OpenAI-style SSE; pass it through, reading usage on the way.
      if (!isStream(out)) throw new Error('the model returned no stream')
      const metered = meterStream(out, (outcome, summary) => {
        Object.assign(usage, summary)
        record(outcome)
      })
      return new Response(metered, {
        headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
      })
    }
    const reply = replyInfo(out)
    usage.promptTokens = tokenCount(reply?.usage?.prompt_tokens)
    usage.completionTokens = tokenCount(reply?.usage?.completion_tokens)
    usage.finishReason = finishReason(reply?.finish_reason)
    // The reply as the model gave it. Build the response first: if that throws, the request is
    // recorded once, as internal.
    const res = c.newResponse(JSON.stringify(out), 200, { 'content-type': 'application/json' })
    record('ok')
    return res
  }

  return app
}
