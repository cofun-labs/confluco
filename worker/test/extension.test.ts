// Runs the extension's real agent (extension/src/agent.ts) against the worker,
// so the two sides can't drift apart.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CopilotAgent,
  MAY_HAVE_CHANGED,
  type AgentConfig,
  type AgentUpdate,
  type ConfirmTool,
  type HistoryMessage,
  type ToolCallRequest,
  type ToolSpec,
} from '../../extension/src/agent'
import { defineTool } from '../../extension/src/tool'
import { z } from '../../extension/src/zod'
import { createApp, type Env } from '../src/app'
import { FakeClerk } from './clerk'
import { FakeAiBinding, FakeQuotaNamespace, FakeUsageDataset } from './fakes'

const EXT = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
const MODEL = '@cf/test/model'
let clock = new Date('2026-11-08T12:00:00Z')
const app = createApp({ now: () => clock })
let clerk: FakeClerk
let env: Env
let ai: FakeAiBinding
let token: string

const realFetch = globalThis.fetch

beforeAll(async () => {
  clerk = await FakeClerk.create()
  // The extension calls fetch(); route it into the worker app.
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    app.request(new Request(input, init), undefined, env)) as typeof fetch
})

afterAll(() => {
  globalThis.fetch = realFetch
})

beforeEach(async () => {
  clock = new Date('2026-11-08T12:00:00Z')
  env = {
    AI: (ai = new FakeAiBinding('你好 来自 worker')),
    QUOTA: new FakeQuotaNamespace(),
    USAGE: new FakeUsageDataset(),
    DAILY_REQUEST_LIMIT: '100',
    MODEL,
    CLERK_JWT_KEY: clerk.publicKeyPem,
    CLERK_AUTHORIZED_PARTIES: EXT,
  }
  token = await clerk.sessionToken({ userId: 'user_alice', azp: EXT })
})

/** A tool with no arguments that returns a fixed page; records each run. */
function pageTool(page = { title: 'Q4 Roadmap', url: 'https://example.atlassian.net/wiki/spaces/ENG/pages/123' }) {
  const runs: unknown[] = []
  const tool = defineTool({
    name: 'lookup_page',
    description: 'Returns the title and URL of a sample page.',
    args: z.strictObject({}),
    run: async (args) => {
      runs.push(args)
      return page
    },
  })
  return { tool, runs }
}

function makeAgent(
  options: {
    tools?: ToolSpec[]
    maxSteps?: number
    history?: { messages: number; chars: number }
    systemPrompt?: string
    getToken?: () => Promise<string | null>
    context?: () => Promise<string | undefined>
    meter?: AgentConfig['meter']
  } = {},
) {
  return new CopilotAgent({
    apiUrl: 'https://nk.example.dev/v1/',
    getToken: options.getToken ?? (async () => token),
    systemPrompt: options.systemPrompt ?? 'You are Confluco.',
    tools: options.tools ?? [pageTool().tool],
    maxSteps: options.maxSteps,
    history: options.history,
    context: options.context,
    meter: options.meter,
  })
}

/** Asks one question and collects what the side panel would show. */
async function ask(agent: CopilotAgent, text: string, confirm?: ConfirmTool) {
  const updates: AgentUpdate[] = []
  const result = await agent.ask(text, (u) => updates.push(u), confirm)
  const reply = updates.map((u) => (u.type === 'text' ? u.delta : '')).join('')
  return { result, updates, reply }
}

/** A stand-in for a tool that needs the user's OK each time, like moving a page to the trash; records each run. */
function renameTool() {
  const runs: unknown[] = []
  const tool: ToolSpec = {
    name: 'rename_page',
    description: 'Renames the sample page.',
    parameters: {
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
      additionalProperties: false,
    },
    needsConfirmation: true,
    run: async (args) => {
      runs.push(args)
      return 'Renamed.'
    },
  }
  return { tool, runs }
}

const RENAME_CALL = { name: 'rename_page', arguments: '{"title":"Q4 Plan"}' }
const toolStatuses = (updates: AgentUpdate[]) => updates.flatMap((u) => (u.type === 'tool_end' ? [u.status] : []))

const PAGE_JSON = JSON.stringify({
  title: 'Q4 Roadmap',
  url: 'https://example.atlassian.net/wiki/spaces/ENG/pages/123',
})

const sentMessages = (call: number) => ai.calls[call].inputs.messages as Record<string, unknown>[]

describe('extension agent against the worker', () => {
  it('[UC-CHAT-001-S01] a plain question gets a streamed answer with no tools registered', async () => {
    const { result, updates, reply } = await ask(makeAgent({ tools: [] }), 'hi')
    expect(result).toEqual({ status: 'done' })
    expect(reply).toBe('你好 来自 worker ')
    expect(updates.filter((u) => u.type === 'text').length).toBeGreaterThan(1)
    expect(ai.calls).toHaveLength(1)
    expect(ai.calls[0].inputs.tools).toBeUndefined()
    expect(sentMessages(0)).toEqual([
      { role: 'system', content: 'You are Confluco.' },
      { role: 'user', content: 'hi' },
    ])
  })

  it('[UC-AGENT-001-S23] a tool the model asks for runs in the extension and the answer uses its result', async () => {
    const { tool, runs } = pageTool()
    ai.script = [{ toolCalls: [{ name: 'lookup_page', arguments: '{}' }] }, { reply: 'You are on Q4 Roadmap' }]
    const { result, updates, reply } = await ask(makeAgent({ tools: [tool] }), 'Which page am I on?')

    expect(result).toEqual({ status: 'done' })
    expect(runs).toEqual([{}])
    expect(updates.filter((u) => u.type !== 'text')).toEqual([
      { type: 'tool_start', id: 'chatcmpl-tool-0', name: 'lookup_page', args: {} },
      { type: 'tool_ready', id: 'chatcmpl-tool-0', args: {} },
      { type: 'tool_end', id: 'chatcmpl-tool-0', name: 'lookup_page', status: 'done', result: PAGE_JSON },
    ])
    expect(reply).toBe('You are on Q4 Roadmap ')
    // The second model call got the tool's result right after the call.
    expect(sentMessages(1).slice(-2)).toEqual([
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'chatcmpl-tool-0', type: 'function', function: { name: 'lookup_page', arguments: '{}' } }],
      },
      {
        role: 'tool',
        tool_call_id: 'chatcmpl-tool-0',
        content: JSON.stringify({
          title: 'Q4 Roadmap',
          url: 'https://example.atlassian.net/wiki/spaces/ENG/pages/123',
        }),
      },
    ])
  })

  it('a question stopped while the open page is read is never sent', async () => {
    let read!: () => void
    const started = new Promise<void>((r) => (read = r))
    // The tab never answers; Stop must still end the question.
    const agent = makeAgent({
      context: () => {
        read()
        return new Promise<never>(() => {})
      },
    })
    const question = agent.ask('hi', () => {})
    await started
    agent.stop()
    expect(await question).toEqual({ status: 'stopped' })
    expect(ai.calls).toHaveLength(0)
    expect(agent.history()).toEqual([])
  })

  it('asks the question without a note when reading the open page fails', async () => {
    const agent = makeAgent({
      context: async () => {
        throw new Error('tabs unavailable')
      },
    })
    const { result } = await ask(agent, 'hi')
    expect(result).toEqual({ status: 'done' })
    expect(sentMessages(0).at(-1)).toEqual({ role: 'user', content: 'hi' })
    expect(agent.history()[0]).toEqual({ role: 'user', text: 'hi' })
  })

  it('a stopped question mentions an earlier change whose outcome was unknown', async () => {
    const lost = Object.assign(new Error('The workspace did not answer.'), { mayHaveChanged: true })
    const writing: ToolSpec = {
      ...renameTool().tool,
      needsConfirmation: false,
      changesData: true,
      run: async () => Promise.reject(lost),
    }
    const refused: ToolSpec = {
      ...pageTool().tool,
      run: async () => Promise.reject(Object.assign(new Error('Turned away.'), { stopsQuestion: 'Wait a minute.' })),
    }
    ai.script = [{ toolCalls: [RENAME_CALL] }, { toolCalls: [{ name: 'lookup_page', arguments: '{}' }] }]
    const { result } = await ask(makeAgent({ tools: [writing, refused] }), 'Rename this page')
    expect(result).toEqual({ status: 'error', message: `Wait a minute. ${MAY_HAVE_CHANGED}` })
  })

  it('finds a possible change in any cause, even under a wrapper that says none', async () => {
    const lost = Object.assign(new Error('The workspace did not answer.'), { mayHaveChanged: true })
    const wrapped = Object.assign(new Error('Could not finish.', { cause: lost }), {
      mayHaveChanged: false,
      stopsQuestion: 'Wait a minute.',
    })
    // Without changesData: the error alone says data may have changed.
    const writing: ToolSpec = {
      ...renameTool().tool,
      needsConfirmation: false,
      run: async () => Promise.reject(wrapped),
    }
    ai.script = [{ toolCalls: [RENAME_CALL] }]
    const { result } = await ask(makeAgent({ tools: [writing] }), 'Rename this page')
    expect(result).toEqual({ status: 'error', message: `Wait a minute. ${MAY_HAVE_CHANGED}` })
  })

  it('[UC-AGENT-001-S05] a model that keeps calling tools is stopped at the step limit', async () => {
    const { tool, runs } = pageTool()
    ai.toolCalls = [{ name: 'lookup_page', arguments: '{}' }]
    const agent = makeAgent({ tools: [tool], maxSteps: 3 })
    const { result, updates } = await ask(agent, 'Which page am I on?')
    expect(result).toEqual({ status: 'step_limit', steps: 3 })
    expect(ai.calls).toHaveLength(3)
    // The last step's tool is refused, not run: the model would never see its result.
    expect(runs).toHaveLength(2)
    expect(updates.flatMap((u) => (u.type === 'tool_end' ? [u.status] : []))).toEqual(['done', 'done', 'skipped'])
    // The panel gets a start for the refused call too, so it can mark that call as skipped.
    const refusedId = updates.filter((u) => u.type === 'tool_end').at(-1)!.id
    expect(updates).toContainEqual(expect.objectContaining({ type: 'tool_start', id: refusedId }))

    // The conversation stays usable: the next question is answered, with the refused call answered too.
    ai.toolCalls = undefined
    expect((await ask(agent, 'Thanks')).result).toEqual({ status: 'done' })
    expect(sentMessages(3).at(-2)).toMatchObject({ role: 'tool', content: expect.stringContaining('limit of 3 steps') })
  })

  it('a null where the schema takes none is refused, not run as the text "null"', async () => {
    const runs: unknown[] = []
    const tool = defineTool({
      name: 'post_notes',
      description: 'Posts notes.',
      args: z.strictObject({
        text: z.string(),
        urgent: z.boolean(),
        count: z.number(),
        notes: z.array(z.strictObject({ page: z.string(), title: z.string().optional() })),
        tag: z.string().optional(),
        // Required, and null is a value for it: its own schema says so.
        due: z.string().nullable(),
        metadata: z.unknown(),
        alias: z.literal([null, 'none']),
        values: z.union([z.array(z.string()), z.array(z.null())]),
        labels: z.record(z.string(), z.string()).optional(),
        selection: z
          .discriminatedUnion('kind', [
            z.object({ kind: z.literal('page'), title: z.string() }),
            z.object({ kind: z.literal('empty'), title: z.null() }),
          ])
          .optional(),
        tags: z.array(z.string()).optional(),
        // A record can explicitly permit null for a value.
        fields: z.record(z.string(), z.union([z.string(), z.array(z.string()), z.null()])).optional(),
      }),
      preview: () => `Post; ${runs.length} run(s) so far`,
      run: async (args) => {
        runs.push(args)
        return 'Posted.'
      },
    })
    const good = {
      text: 'Hi',
      urgent: false,
      count: 2,
      notes: [{ page: 'a' }],
      due: null,
      metadata: null,
      alias: null,
      values: [null],
    }
    ai.script = [
      { toolCalls: [{ name: 'post_notes', arguments: JSON.stringify({ ...good, text: null }) }] },
      {
        toolCalls: [
          {
            name: 'post_notes',
            arguments: JSON.stringify({
              ...good,
              text: null,
              urgent: null,
              count: null,
              notes: [{ page: 'a' }, { page: null }],
            }),
          },
        ],
      },
      // A null entry of a list of texts, at the top and inside values by name.
      {
        toolCalls: [
          {
            name: 'post_notes',
            arguments: JSON.stringify({ ...good, tags: ['a', null], fields: { Status: null, Tags: [null, 'b'] } }),
          },
        ],
      },
      {
        toolCalls: [
          {
            name: 'post_notes',
            arguments: JSON.stringify({
              ...good,
              notes: { page: null },
              labels: { Status: null },
              selection: { kind: 'page', title: null },
            }),
          },
        ],
      },
      // A null where the argument may be left out is still dropped, and the call runs.
      {
        toolCalls: [
          {
            name: 'post_notes',
            arguments: JSON.stringify({ ...good, tag: null, notes: [{ page: 'a', title: null }] }),
          },
        ],
      },
      { reply: 'Done' },
    ]
    const { result, updates } = await ask(makeAgent({ tools: [tool] }), 'Post the notes')

    expect(result).toEqual({ status: 'done' })
    expect(runs).toEqual([good])
    // Refused before the preview, like any call whose arguments don't fit.
    expect(updates.filter((u) => u.type === 'tool_ready')).toHaveLength(1)
    expect(sentMessages(1).at(-1)).toEqual({
      role: 'tool',
      tool_call_id: 'chatcmpl-tool-0',
      content:
        'Not run: null is not a value for `text`. Give the call again with a value there, or ask the user for one.',
    })
    expect(sentMessages(2).at(-1)).toMatchObject({
      content:
        'Not run: null is not a value for `text`, `urgent`, `count`, `notes[1].page`. ' +
        'Give the call again with a value there, or ask the user for one.',
    })
    expect(sentMessages(3).at(-1)).toMatchObject({
      content:
        'Not run: null is not a value for `tags[1]`, `fields.Tags[0]`. ' +
        'Give the call again with a value there, or ask the user for one.',
    })
    expect(sentMessages(4).at(-1)).toMatchObject({
      content:
        'Not run: null is not a value for `notes.page`, `labels.Status`, `selection.title`. ' +
        'Give the call again with a value there, or ask the user for one.',
    })
    expect(sentMessages(5).at(-1)).toMatchObject({ role: 'tool', content: 'Posted.' })
  })

  it('calls pi cannot run (unknown tool, invalid arguments) still stop at the step limit', async () => {
    for (const calls of [
      [{ name: 'no_such_tool', arguments: '{}' }],
      [{ name: 'lookup_page', arguments: '{"x":1}' }],
      [
        { name: 'lookup_page', arguments: '{}' },
        { name: 'no_such_tool', arguments: '{}' },
      ],
    ]) {
      ai = env.AI = new FakeAiBinding('你好 来自 worker')
      ai.toolCalls = calls
      const agent = makeAgent({ maxSteps: 3 })
      expect((await ask(agent, 'Which page am I on?')).result).toEqual({ status: 'step_limit', steps: 3 })
      expect(ai.calls).toHaveLength(3)
      ai.toolCalls = undefined
      expect((await ask(agent, 'Thanks')).result).toEqual({ status: 'done' })
    }
  })

  it("reads only what it can from the worker's replies: anything else is an error, never a wrong value", async () => {
    const routed = globalThis.fetch
    const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })
    try {
      // The model lookup: a model that is not text is no model.
      const lookups: [number, unknown, string][] = [
        [200, { model: 5 }, 'HTTP 200'],
        [200, 'a model', 'HTTP 200'],
        [200, {}, 'HTTP 200'],
        [503, { error: { message: 'CLERK_JWT_KEY is not set' } }, 'CLERK_JWT_KEY is not set'],
        [500, { error: 'boom' }, 'HTTP 500'],
        [502, null, 'HTTP 502'],
      ]
      for (const [status, body, message] of lookups) {
        globalThis.fetch = (async () => answer(status, body)) as typeof fetch
        expect((await ask(makeAgent(), 'hi')).result, JSON.stringify(body)).toEqual({ status: 'error', message })
      }
      // A failed model request: the worker's own words when it gives them as text, wrapped or not.
      const failures: [unknown, string][] = [
        [{ error: { code: 'bad_request', message: 'wrapped words' } }, 'wrapped words'],
        [{ code: 'bad_request', message: 'unwrapped words' }, 'unwrapped words'],
        // Otherwise what the SDK made of the body, as it is.
        [{ error: { message: 5 } }, '{"message":5}'],
        [{ error: 'boom' }, '"boom"'],
        [['boom'], '["boom"]'],
      ]
      for (const [body, message] of failures) {
        globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
          String(input instanceof Request ? input.url : input).endsWith('/me')
            ? routed(input, init)
            : Promise.resolve(answer(400, body))) as typeof fetch
        const { result } = await ask(makeAgent(), 'hi')
        expect(result, JSON.stringify(body)).toEqual({ status: 'error', message })
      }
    } finally {
      globalThis.fetch = routed
    }
  })

  it('a tool that returns nothing still gives the model a result', async () => {
    const quiet: ToolSpec = { ...pageTool().tool, run: async () => undefined }
    ai.script = [{ toolCalls: [{ name: 'lookup_page', arguments: '{}' }] }, { reply: 'Done' }]
    expect((await ask(makeAgent({ tools: [quiet] }), 'Which page am I on?')).result).toEqual({ status: 'done' })
    expect(sentMessages(1).at(-1)).toMatchObject({ role: 'tool', content: expect.any(String) })
  })

  it('several tool calls on the last step are all refused, and the next question still works', async () => {
    const { tool, runs } = pageTool()
    ai.toolCalls = [
      { name: 'lookup_page', arguments: '{}' },
      { name: 'lookup_page', arguments: '{}' },
    ]
    const agent = makeAgent({ tools: [tool], maxSteps: 1 })
    expect((await ask(agent, 'Which page am I on?')).result).toEqual({ status: 'step_limit', steps: 1 })
    expect(runs).toHaveLength(0)

    ai.toolCalls = undefined
    expect((await ask(agent, 'Thanks')).result).toEqual({ status: 'done' })
    // Both calls have a result in the conversation, so the worker accepted it.
    expect(sentMessages(1).filter((m) => m.role === 'tool')).toHaveLength(2)
  })

  it('the conversation carries over to the next question', async () => {
    const agent = makeAgent()
    await ask(agent, 'first')
    await ask(agent, 'second')
    expect(sentMessages(1).map((m) => [m.role, m.content])).toEqual([
      ['system', 'You are Confluco.'],
      ['user', 'first'],
      ['assistant', '你好 来自 worker '],
      ['user', 'second'],
    ])
  })

  it('a long conversation sends only its newest part, starting at a question', async () => {
    const agent = makeAgent({ history: { messages: 3, chars: 100_000 } })
    await ask(agent, 'first')
    await ask(agent, 'second')
    await ask(agent, 'third')
    expect(sentMessages(2).map((m) => [m.role, m.content])).toEqual([
      ['system', 'You are Confluco.'],
      ['user', 'second'],
      ['assistant', '你好 来自 worker '],
      ['user', 'third'],
    ])
  })

  it('the system prompt and tool definitions count toward the history budget', async () => {
    const { tool } = pageTool()
    const toolChars = JSON.stringify([
      { name: tool.name, description: tool.description, parameters: tool.parameters },
    ]).length
    // The earlier exchange ("first", its reply, "second") is about 24 characters and fits in 40.
    const budget = (systemPrompt: string) =>
      makeAgent({ systemPrompt, history: { messages: 100, chars: toolChars + 40 } })

    let agent = budget('Short.')
    await ask(agent, 'first')
    await ask(agent, 'second')
    expect(sentMessages(1).map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user'])

    // A long system prompt uses up the room, so only the newest question is sent.
    agent = budget('x'.repeat(100))
    await ask(agent, 'first')
    await ask(agent, 'second')
    expect(sentMessages(3).map((m) => m.role)).toEqual(['system', 'user'])
  })

  it('a second question while one is running is refused, and the first is unharmed', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const agent = makeAgent({
      getToken: async () => {
        await gate
        return token
      },
    })
    const first = ask(agent, 'first')
    expect((await ask(agent, 'second')).result).toEqual({ status: 'error', message: 'Already answering a question.' })
    release()
    expect((await first).result).toEqual({ status: 'done' })
    await ask(agent, 'third')
    expect(sentMessages(1).map((m) => m.content)).toEqual(['You are Confluco.', 'first', '你好 来自 worker ', 'third'])
  })

  it('trimming never separates tool results from their call', async () => {
    const agent = makeAgent({ history: { messages: 3, chars: 100_000 } })
    ai.script = [{ toolCalls: [{ name: 'lookup_page', arguments: '{}' }] }, { reply: 'Q4 Roadmap' }]
    await ask(agent, 'Which page am I on?')
    // Last 3 would be [assistant tool call, tool result, assistant]; the cut moves to the next question.
    await ask(agent, 'thanks')
    expect(sentMessages(2).map((m) => m.role)).toEqual(['system', 'user'])
  })

  it('a tool that fails is reported to the model, which still answers', async () => {
    const failing: ToolSpec = { ...pageTool().tool, run: async () => Promise.reject(new Error('No page is open.')) }
    ai.script = [{ toolCalls: [{ name: 'lookup_page', arguments: '{}' }] }, { reply: 'Open a page first' }]
    const { result, updates, reply } = await ask(makeAgent({ tools: [failing] }), 'Which page am I on?')
    expect(result).toEqual({ status: 'done' })
    // The panel shows the same error the model got.
    expect(updates).toContainEqual({
      type: 'tool_end',
      id: 'chatcmpl-tool-0',
      name: 'lookup_page',
      status: 'failed',
      result: expect.stringContaining('No page is open.'),
    })
    expect(sentMessages(1).at(-1)).toMatchObject({ role: 'tool', content: expect.stringContaining('No page is open.') })
    expect(reply).toBe('Open a page first ')
  })

  it('[UC-AGENT-001-S12] stopping during a tool keeps the tools used so far, and drops what had not started', async () => {
    let agent: CopilotAgent
    const { tool, runs } = renameTool()
    const rename: ToolSpec = { ...tool, changesData: true }
    const slow: ToolSpec = {
      ...pageTool().tool,
      run: (_args, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted')))
          agent.stop()
        }),
    }
    agent = makeAgent({ tools: [rename, slow] })
    // Step 1 renames the page. Step 2 reads it, and would rename it again, but Stop comes first.
    ai.script = [{ toolCalls: [RENAME_CALL] }, { toolCalls: [{ name: 'lookup_page', arguments: '{}' }, RENAME_CALL] }]
    const stopped = await ask(agent, 'Rename this page to Q4 Plan', async () => true)
    expect(stopped.result).toEqual({ status: 'stopped', mayHaveChanged: true })
    expect(runs).toHaveLength(1)
    // The tool cut short shows as stopped, not as a failure of its own; the last call never started.
    expect(toolStatuses(stopped.updates)).toEqual(['done', 'stopped'])
    expect(agent.history().flatMap((m) => (m.role === 'tool' ? [[m.name, m.status]] : []))).toEqual([
      ['rename_page', 'done'],
      ['lookup_page', 'stopped'],
    ])

    // The next question carries both steps, each call answered right after it; the worker accepts it.
    expect((await ask(agent, 'What is it called now?')).result).toEqual({ status: 'done' })
    const sent = sentMessages(2)
    expect(sent.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'assistant', 'tool', 'user'])
    expect(sent[3]).toMatchObject({ role: 'tool', tool_call_id: 'chatcmpl-tool-0', content: 'Renamed.' })
    expect(sent[4]).toMatchObject({
      tool_calls: [{ id: 'chatcmpl-tool-1', function: { name: 'lookup_page' } }],
    })
    // The model is told the tool was cut short and may have done part of its work.
    expect(sent[5]).toMatchObject({
      role: 'tool',
      tool_call_id: 'chatcmpl-tool-1',
      // The tool's own error follows, in case it failed on its own.
      content: expect.stringMatching(/may have partly happened.*\n.*aborted/s),
    })
  })

  it('[UC-AGENT-001-S13] a question that fails after a tool ran keeps the tool for the next question', async () => {
    const { tool, runs } = renameTool()
    const failing: ToolSpec = {
      ...tool,
      run: async (args) => {
        // The model fails on the request that sends the result back.
        ai.failWith = new Error('capacity')
        return tool.run(args)
      },
    }
    const agent = makeAgent({ tools: [failing] })
    ai.script = [{ toolCalls: [RENAME_CALL] }]
    const failed = await ask(agent, 'Rename this page to Q4 Plan', async () => true)
    expect(failed.result).toMatchObject({ status: 'error' })
    expect(runs).toEqual([{ title: 'Q4 Plan' }])

    ai.failWith = undefined
    expect((await ask(agent, 'Did it work?')).result).toEqual({ status: 'done' })
    expect(sentMessages(2)).toEqual([
      { role: 'system', content: 'You are Confluco.' },
      { role: 'user', content: 'Rename this page to Q4 Plan' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'chatcmpl-tool-0',
            type: 'function',
            function: { name: 'rename_page', arguments: '{"title":"Q4 Plan"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'chatcmpl-tool-0', content: 'Renamed.' },
      { role: 'user', content: 'Did it work?' },
    ])
  })

  it('[UC-AGENT-001-S14] a question stopped or failed before any tool ran is left out', async () => {
    // Fails on the first model request.
    ai.failWith = new Error('capacity')
    const agent = makeAgent()
    expect((await ask(agent, 'first')).result).toMatchObject({ status: 'error' })
    ai.failWith = undefined

    // Stopped while its first model request is under way.
    let stopNext = true
    env.AI = ai = new (class extends FakeAiBinding {
      override async run(model: string, inputs: Record<string, unknown>, options?: Record<string, unknown>) {
        if (stopNext) stopping.stop()
        stopNext = false
        return super.run(model, inputs, options)
      }
    })('你好 来自 worker')
    const stopping = makeAgent()
    expect((await ask(stopping, 'second')).result).toEqual({ status: 'stopped' })

    for (const a of [agent, stopping]) {
      expect(a.history()).toEqual([])
      await ask(a, 'hi')
      expect(ai.calls.at(-1)!.inputs.messages).toEqual([
        { role: 'system', content: 'You are Confluco.' },
        { role: 'user', content: 'hi' },
      ])
    }
  })

  it('a stopped question keeps its tool calls when the session is saved and reopened', async () => {
    let agent: CopilotAgent
    const stubborn: ToolSpec = {
      ...pageTool().tool,
      run: async () => {
        agent.stop()
        return { title: 'Q4 Roadmap' }
      },
    }
    agent = makeAgent({ tools: [stubborn] })
    ai.script = [{ toolCalls: [{ name: 'lookup_page', arguments: '{}' }] }]
    expect((await ask(agent, 'Which page am I on?')).result).toEqual({ status: 'stopped' })
    const saved = structuredClone(agent.history())
    expect(saved).toEqual<HistoryMessage[]>([
      { role: 'user', text: 'Which page am I on?' },
      { role: 'assistant', parts: [{ type: 'tool_call', id: 'chatcmpl-tool-0', name: 'lookup_page', args: {} }] },
      {
        role: 'tool',
        id: 'chatcmpl-tool-0',
        name: 'lookup_page',
        status: 'done',
        result: '{"title":"Q4 Roadmap"}',
      },
    ])

    const resumed = makeAgent()
    await resumed.reset(saved)
    expect((await ask(resumed, 'And now?')).result).toEqual({ status: 'done' })
    expect(sentMessages(1).map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'user'])
  })

  it('a declined call is kept when the question then fails, so the model is not asked to retry it', async () => {
    const { tool, runs } = renameTool()
    const agent = makeAgent({ tools: [tool] })
    ai.script = [{ toolCalls: [RENAME_CALL] }]
    const failed = await ask(agent, 'Rename this page to Q4 Plan', async () => {
      ai.failWith = new Error('capacity')
      return false
    })
    expect(failed.result).toMatchObject({ status: 'error' })
    expect(runs).toEqual([])
    expect(agent.history().at(-1)).toMatchObject({ role: 'tool', status: 'declined' })

    ai.failWith = undefined
    await ask(agent, 'hi')
    expect(sentMessages(2).at(-2)).toMatchObject({ role: 'tool', content: expect.stringContaining('declined') })
  })

  it('a tool that finishes despite Stop still shows as done', async () => {
    let agent: CopilotAgent
    const stubborn: ToolSpec = {
      ...pageTool().tool,
      run: async () => {
        agent.stop()
        return { title: 'Q4 Roadmap' }
      },
    }
    agent = makeAgent({ tools: [stubborn] })
    ai.script = [{ toolCalls: [{ name: 'lookup_page', arguments: '{}' }] }]
    const { result, updates } = await ask(agent, 'Which page am I on?')
    expect(result).toEqual({ status: 'stopped' })
    expect(updates.flatMap((u) => (u.type === 'tool_end' ? [u.status] : []))).toEqual(['done'])
  })

  it('[UC-AGENT-001-S09] a tool the user declines does not run, and the agent continues without it', async () => {
    const { tool, runs } = renameTool()
    ai.script = [{ toolCalls: [RENAME_CALL] }, { reply: 'OK, I left the title as it is' }]
    const asked: ToolCallRequest[] = []
    const { result, updates, reply } = await ask(
      makeAgent({ tools: [tool] }),
      'Rename this page to Q4 Plan',
      async (call) => {
        asked.push(call)
        return false
      },
    )

    expect(asked).toEqual([{ id: 'chatcmpl-tool-0', name: 'rename_page', args: { title: 'Q4 Plan' } }])
    expect(runs).toEqual([])
    expect(toolStatuses(updates)).toEqual(['declined'])
    // The model is told the user said no, and answers without the tool.
    expect(sentMessages(1).at(-1)).toMatchObject({ role: 'tool', content: expect.stringContaining('declined') })
    expect(result).toEqual({ status: 'done' })
    expect(reply).toBe('OK, I left the title as it is ')
  })

  it('previews a call from the arguments it runs with, before it runs', async () => {
    const runs: unknown[] = []
    const tool = defineTool({
      name: 'tag_pages',
      description: 'Tags pages.',
      args: z.object({ pages: z.array(z.object({ page: z.string().optional() })) }),
      preview: (args) => `Tag ${args.pages.length} page(s); ${runs.length} run(s) so far`,
      run: async (args) => {
        runs.push(args)
        return 'Tagged.'
      },
    })
    // One page given as an object instead of a list: the tool gets it as a list of one.
    ai.script = [{ toolCalls: [{ name: 'tag_pages', arguments: '{"pages":{"page":"a"}}' }] }, { reply: 'Done' }]
    const { updates } = await ask(makeAgent({ tools: [tool] }), 'Tag page a')
    expect(runs).toEqual([{ pages: [{ page: 'a' }] }])
    expect(updates.filter((u) => u.type === 'tool_ready')).toEqual([
      {
        type: 'tool_ready',
        id: 'chatcmpl-tool-0',
        args: { pages: [{ page: 'a' }] },
        preview: 'Tag 1 page(s); 0 run(s) so far',
      },
    ])
  })

  it('Stop does not wait for a preview that is still looking things up', async () => {
    let agent: CopilotAgent
    const { tool, runs } = renameTool()
    const slow: ToolSpec = {
      ...tool,
      preview: () => {
        agent.stop()
        return new Promise<string>(() => {})
      },
    }
    agent = makeAgent({ tools: [slow] })
    ai.script = [{ toolCalls: [RENAME_CALL] }]
    const asked: ToolCallRequest[] = []
    const { result } = await ask(agent, 'Rename this page to Q4 Plan', async (call) => {
      asked.push(call)
      return true
    })
    expect(result).toEqual({ status: 'stopped' })
    expect(asked).toEqual([])
    expect(runs).toEqual([])
  })

  it('a tool that runs without asking does not start when Stop lands during its preview', async () => {
    let agent: CopilotAgent
    const { tool, runs } = pageTool()
    const slow: ToolSpec = {
      ...tool,
      preview: async () => {
        agent.stop()
        return 'Looks up the page'
      },
    }
    agent = makeAgent({ tools: [slow] })
    ai.script = [{ toolCalls: [{ name: 'lookup_page', arguments: '{}' }] }]
    const { result } = await ask(agent, 'Which page am I on?')
    expect(result).toEqual({ status: 'stopped' })
    expect(runs).toEqual([])
  })

  it('a broken preview does not stop the call', async () => {
    const { tool, runs } = pageTool()
    ai.script = [{ toolCalls: [{ name: 'lookup_page', arguments: '{}' }] }, { reply: 'Done' }]
    const broken: ToolSpec = {
      ...tool,
      preview: () => {
        throw new Error('broken')
      },
    }
    const { updates } = await ask(makeAgent({ tools: [broken] }), 'Which page am I on?')
    expect(runs).toEqual([{}])
    expect(toolStatuses(updates)).toEqual(['done'])
  })

  it('[UC-AGENT-001-S10] a tool the user agrees to runs, and the answer uses its result', async () => {
    const { tool, runs } = renameTool()
    ai.script = [{ toolCalls: [RENAME_CALL] }, { reply: 'Renamed to Q4 Plan' }]
    const { result, updates, reply } = await ask(
      makeAgent({ tools: [tool] }),
      'Rename this page to Q4 Plan',
      async () => true,
    )

    expect(runs).toEqual([{ title: 'Q4 Plan' }])
    expect(toolStatuses(updates)).toEqual(['done'])
    expect(sentMessages(1).at(-1)).toMatchObject({ role: 'tool', content: 'Renamed.' })
    expect(result).toEqual({ status: 'done' })
    expect(reply).toBe('Renamed to Q4 Plan ')
  })

  it('a tool that needs confirmation does not run when nobody can be asked', async () => {
    const { tool, runs } = renameTool()
    ai.script = [{ toolCalls: [RENAME_CALL] }, { reply: 'I could not do that' }]
    const { result, updates } = await ask(makeAgent({ tools: [tool] }), 'Rename this page to Q4 Plan')
    expect(runs).toEqual([])
    // Not shown as declined: the user never said no.
    expect(toolStatuses(updates)).toEqual(['failed'])
    // The model is not told that the user said no: nobody was asked.
    expect(sentMessages(1).at(-1)).toMatchObject({
      role: 'tool',
      content: expect.stringContaining('could not be asked'),
    })
    expect(result).toEqual({ status: 'done' })
  })

  it('a prompt that fails is not reported to the model as the user declining', async () => {
    const { tool, runs } = renameTool()
    ai.script = [{ toolCalls: [RENAME_CALL] }, { reply: 'I could not do that' }]
    const { result, updates } = await ask(makeAgent({ tools: [tool] }), 'Rename this page to Q4 Plan', () =>
      Promise.reject(new Error('panel closed')),
    )
    expect(runs).toEqual([])
    expect(toolStatuses(updates)).toEqual(['failed'])
    expect(sentMessages(1).at(-1)).toMatchObject({
      role: 'tool',
      content: expect.stringContaining('could not be asked'),
    })
    expect(result).toEqual({ status: 'done' })
  })

  it('tools that change nothing run without asking', async () => {
    const { tool, runs } = pageTool()
    ai.script = [{ toolCalls: [{ name: 'lookup_page', arguments: '{}' }] }, { reply: 'You are on Q4 Roadmap' }]
    let asked = 0
    await ask(makeAgent({ tools: [tool] }), 'Which page am I on?', async () => {
      asked++
      return true
    })
    expect(asked).toBe(0)
    expect(runs).toEqual([{}])
  })

  it('[UC-AGENT-001-S12] stopping while the user is asked counts as no, ends the question, and keeps the call as stopped', async () => {
    const { tool, runs } = renameTool()
    const agent = makeAgent({ tools: [tool] })
    ai.script = [{ toolCalls: [RENAME_CALL] }]
    // The user never answers; they press Stop instead.
    const { result, updates } = await ask(agent, 'Rename this page to Q4 Plan', () => {
      agent.stop()
      return new Promise<boolean>(() => {})
    })
    expect(result).toEqual({ status: 'stopped' })
    expect(runs).toEqual([])
    expect(toolStatuses(updates)).toEqual(['stopped'])
    // The model is told the call never started, not that the user could not be asked.
    const notRun = 'Not run: the user stopped the question before this action started.'
    expect(agent.history().at(-1)).toMatchObject({ role: 'tool', status: 'stopped', result: notRun })

    await ask(agent, 'hi')
    expect(sentMessages(1).map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'user'])
    expect(sentMessages(1)[3]).toEqual({ role: 'tool', tool_call_id: 'chatcmpl-tool-0', content: notRun })
  })

  it('a new chat while the user is asked counts as no', async () => {
    const { tool, runs } = renameTool()
    const agent = makeAgent({ tools: [tool] })
    ai.script = [{ toolCalls: [RENAME_CALL] }]
    let reset: Promise<void> | undefined
    const { result, updates } = await ask(agent, 'Rename this page to Q4 Plan', () => {
      reset = agent.reset()
      return new Promise<boolean>(() => {})
    })
    await reset
    expect(result).toEqual({ status: 'stopped' })
    expect(runs).toEqual([])
    expect(toolStatuses(updates)).toEqual(['stopped'])

    // The new chat starts empty: nothing of the unanswered question carries over.
    await ask(agent, 'hi')
    expect(sentMessages(1).map((m) => m.role)).toEqual(['system', 'user'])
  })

  it('stop and new chat work while the agent is still being set up', async () => {
    for (const cancel of ['stop', 'reset'] as const) {
      let release!: () => void
      const gate = new Promise<void>((r) => (release = r))
      const agent = makeAgent({
        getToken: async () => {
          await gate
          return token
        },
      })
      const pending = agent.ask('hi', () => {})
      if (cancel === 'stop') agent.stop()
      else void agent.reset()
      release()
      expect(await pending).toEqual({ status: 'stopped' })
    }
    // No model call was made, and nothing was left in either conversation.
    expect(ai.calls).toHaveLength(0)
  })

  it('a panel left open across a model change looks the model up again', async () => {
    const agent = makeAgent()
    expect((await ask(agent, 'first')).result).toEqual({ status: 'done' })
    env.MODEL = '@cf/test/next-model'
    // The worker refuses the old model name before the model or the quota is used; the agent retries once.
    const { result, reply } = await ask(agent, 'second')
    expect(result).toEqual({ status: 'done' })
    expect(reply).toBe('你好 来自 worker ')
    expect(ai.calls.map((c) => c.model)).toEqual([MODEL, '@cf/test/next-model'])
    expect(sentMessages(1).map((m) => m.content)).toEqual(['You are Confluco.', 'first', '你好 来自 worker ', 'second'])
  })

  it('new chat works at once even if the old question has a tool that never finishes', async () => {
    const stuck: ToolSpec = { ...pageTool().tool, run: () => new Promise(() => {}) }
    const agent = makeAgent({ tools: [stuck] })
    ai.script = [{ toolCalls: [{ name: 'lookup_page', arguments: '{}' }] }]
    const first = agent.ask('Which page am I on?', () => {})
    await vi.waitFor(() => expect(ai.calls).toHaveLength(1))
    void agent.reset()
    expect((await ask(agent, 'hi')).result).toEqual({ status: 'done' })
    expect(sentMessages(1).map((m) => m.role)).toEqual(['system', 'user'])
    void first
  })

  it('a question set up after a New chat keeps its agent when an older lookup finishes later', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let calls = 0
    const agent = makeAgent({
      getToken: async () => {
        // Only the first question's lookup is slow.
        if (calls++ === 0) await gate
        return token
      },
    })
    const a = agent.ask('A', () => {})
    void agent.reset()
    expect((await ask(agent, 'B')).result).toEqual({ status: 'done' })
    release()
    expect(await a).toEqual({ status: 'stopped' })
    await ask(agent, 'C')
    expect(sentMessages(1).map((m) => m.content)).toEqual(['You are Confluco.', 'B', '你好 来自 worker ', 'C'])
  })

  it('a model change after a tool ran is reported, not retried', async () => {
    const { tool, runs } = pageTool()
    const changing: ToolSpec = {
      ...tool,
      run: async (args) => {
        env.MODEL = '@cf/test/next-model'
        return tool.run(args)
      },
    }
    ai.script = [{ toolCalls: [{ name: 'lookup_page', arguments: '{}' }] }, { reply: 'Q4 Roadmap' }]
    const agent = makeAgent({ tools: [changing] })
    const { result } = await ask(agent, 'Which page am I on?')
    expect(result).toEqual({ status: 'error', message: 'Copilot was just updated. Ask it to continue.' })
    // The tool ran once; running the question again would run it again.
    expect(runs).toHaveLength(1)
    // The new model was looked up, so asking again works straight away.
    ai.script = []
    expect((await ask(agent, 'Thanks')).result).toEqual({ status: 'done' })
    expect(ai.calls.at(-1)!.model).toBe('@cf/test/next-model')
  })

  it('[UC-SESSION-001-S01] a reopened session sends its earlier conversation, tool calls included', async () => {
    ai.script = [{ toolCalls: [{ name: 'lookup_page', arguments: '{}' }] }, { reply: 'You are on Q4 Roadmap' }]
    const first = makeAgent()
    await ask(first, 'Which page am I on?')
    // What the panel saves; stored sessions go through structured cloning, so keep only plain data.
    const saved = structuredClone(first.history())
    expect(saved).toEqual<HistoryMessage[]>([
      { role: 'user', text: 'Which page am I on?' },
      {
        role: 'assistant',
        parts: [{ type: 'tool_call', id: 'chatcmpl-tool-0', name: 'lookup_page', args: {} }],
      },
      { role: 'tool', id: 'chatcmpl-tool-0', name: 'lookup_page', status: 'done', result: PAGE_JSON },
      { role: 'assistant', parts: [{ type: 'text', text: 'You are on Q4 Roadmap ' }] },
    ])

    // Another panel, later: the session is reopened and continued.
    const resumed = makeAgent()
    await resumed.reset(saved)
    expect(resumed.history()).toEqual(saved)
    const { result } = await ask(resumed, 'And its URL?')
    expect(result).toEqual({ status: 'done' })
    expect(sentMessages(2)).toEqual([
      { role: 'system', content: 'You are Confluco.' },
      { role: 'user', content: 'Which page am I on?' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'chatcmpl-tool-0', type: 'function', function: { name: 'lookup_page', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'chatcmpl-tool-0', content: PAGE_JSON },
      { role: 'assistant', content: 'You are on Q4 Roadmap ' },
      { role: 'user', content: 'And its URL?' },
    ])
    expect(resumed.history()).toEqual([
      ...saved,
      { role: 'user', text: 'And its URL?' },
      { role: 'assistant', parts: [{ type: 'text', text: '你好 来自 worker ' }] },
    ])
  })

  it('[UC-SESSION-001-S02] a new or other session sends nothing from earlier sessions', async () => {
    const agent = makeAgent()
    await ask(agent, 'secret plans')
    const earlier = agent.history()

    await agent.reset()
    expect(agent.history()).toEqual([])
    await ask(agent, 'hi')
    expect(sentMessages(1).map((m) => m.content)).toEqual(['You are Confluco.', 'hi'])

    // Switching from one saved session to another leaves the first one behind.
    await agent.reset(earlier)
    await agent.reset([
      { role: 'user', text: 'other' },
      { role: 'assistant', parts: [{ type: 'text', text: 'ok' }] },
    ])
    await ask(agent, 'more')
    expect(sentMessages(2).map((m) => m.content)).toEqual(['You are Confluco.', 'other', 'ok', 'more'])
  })

  it('a saved session keeps how each tool call ended', async () => {
    ai.toolCalls = [
      { name: 'lookup_page', arguments: '{}' },
      { name: 'no_such_tool', arguments: '{}' },
    ]
    const first = makeAgent({ maxSteps: 2 })
    await ask(first, 'Which page am I on?')
    const statuses = (history: HistoryMessage[]) => history.flatMap((m) => (m.role === 'tool' ? [m.status] : []))
    // Step 1: one call runs and the unknown tool fails. Step 2 hits the step limit: the known tool is
    // refused, and the unknown one fails again.
    expect(statuses(first.history())).toEqual(['done', 'failed', 'skipped', 'failed'])

    ai.toolCalls = undefined
    const resumed = makeAgent()
    await resumed.reset(structuredClone(first.history()))
    await ask(resumed, 'Thanks')
    expect(statuses(resumed.history())).toEqual(['done', 'failed', 'skipped', 'failed'])
  })

  it('asks to sign in when there is no session', async () => {
    const { result } = await ask(makeAgent({ getToken: async () => null }), 'hi')
    expect(result).toEqual({ status: 'error', message: 'Please sign in first.' })
    expect(ai.calls).toHaveLength(0)
  })

  it('asks to sign in when the session is lost after the first question', async () => {
    let current: string | null = token
    const agent = makeAgent({ getToken: async () => current })
    expect((await ask(agent, 'first')).result).toEqual({ status: 'done' })
    current = null
    expect((await ask(agent, 'second')).result).toEqual({ status: 'error', message: 'Please sign in first.' })
    expect(ai.calls).toHaveLength(1)
  })

  it('shows the server reason for a rejected session', async () => {
    const { result } = await ask(makeAgent({ getToken: async () => 'not-a-jwt' }), 'hi')
    expect(result).toEqual({ status: 'error', message: 'invalid or expired session' })
  })

  it('[UC-CHAT-001-S04] shows when the daily quota resets, and drops the refused question', async () => {
    env.DAILY_REQUEST_LIMIT = '1'
    const agent = makeAgent()
    expect((await ask(agent, 'first')).result).toEqual({ status: 'done' })
    const { result } = await ask(agent, 'second')
    expect(result).toMatchObject({
      status: 'error',
      message: expect.stringContaining('The quota resets at 00:00 UTC.'),
    })

    env.DAILY_REQUEST_LIMIT = '100'
    await ask(agent, 'third')
    expect(sentMessages(1).map((m) => m.content)).toEqual(['You are Confluco.', 'first', '你好 来自 worker ', 'third'])
  })

  it('[UC-CHAT-001-S06] a question answered with one tool uses two requests from the quota', async () => {
    env.DAILY_REQUEST_LIMIT = '3'
    const { tool, runs } = pageTool()
    const agent = makeAgent({ tools: [tool] })
    ai.script = [{ toolCalls: [{ name: 'lookup_page', arguments: '{}' }] }]
    expect((await ask(agent, 'Which page am I on?')).result).toEqual({ status: 'done' })
    expect(runs).toHaveLength(1)
    expect(ai.calls).toHaveLength(2)

    // Exactly two counted: one request is left for a plain question, and then none.
    expect((await ask(agent, 'hi')).result).toEqual({ status: 'done' })
    expect(ai.calls).toHaveLength(3)
    const { result } = await ask(agent, 'again')
    expect(result).toMatchObject({
      status: 'error',
      message: expect.stringContaining('The quota resets at 00:00 UTC.'),
    })
    expect(ai.calls).toHaveLength(3)
  })

  /** Asks a question whose tool round trip runs into a quota of one request. */
  async function askIntoQuota() {
    env.DAILY_REQUEST_LIMIT = '1'
    const { tool, runs } = pageTool()
    const agent = makeAgent({ tools: [tool] })
    ai.script = [{ toolCalls: [{ name: 'lookup_page', arguments: '{}' }] }]
    const { result } = await ask(agent, 'Which page am I on?')
    return { agent, runs, result }
  }

  it('[UC-CHAT-001-S07] a quota that runs out after a tool ran ends the question with the reset message', async () => {
    const { runs, result } = await askIntoQuota()
    expect(result).toMatchObject({
      status: 'error',
      message: expect.stringContaining('The quota resets at 00:00 UTC.'),
    })
    expect(runs).toHaveLength(1)
    // The request that would have sent the result back was refused before the model.
    expect(ai.calls).toHaveLength(1)
  })

  it('keeps a tool used before the quota ran out for the next question', async () => {
    // UC-AGENT-001-S13 covers a model failure; this guards the same rule when the quota refuses the request.
    const { agent, runs } = await askIntoQuota()
    // The next day the quota allows it again.
    clock = new Date('2026-11-09T00:00:00Z')
    expect((await ask(agent, 'And now?')).result).toEqual({ status: 'done' })
    // The kept tool is part of the conversation; it does not run again.
    expect(runs).toHaveLength(1)
    expect(sentMessages(1)).toEqual([
      { role: 'system', content: 'You are Confluco.' },
      { role: 'user', content: 'Which page am I on?' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'chatcmpl-tool-0', type: 'function', function: { name: 'lookup_page', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'chatcmpl-tool-0', content: PAGE_JSON },
      { role: 'user', content: 'And now?' },
    ])
  })

  it('surfaces an error event in the stream', async () => {
    ai.rawSse = `data: ${JSON.stringify({ error: { message: 'model overloaded' } })}\n\n`
    const { result } = await ask(makeAgent(), 'hi')
    expect(result).toMatchObject({ status: 'error', message: expect.stringContaining('model overloaded') })
  })
})
