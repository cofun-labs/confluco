import type { AiBinding } from '../src/app'
import { consume, type QuotaCounter, type QuotaNamespace, type QuotaStorage } from '../src/quota'
import type { UsageDataset } from '../src/usage'

type Call = { model: string; inputs: Record<string, unknown>; options?: Record<string, unknown> }

/** Token counts the fake model reports for every reply. */
export const FAKE_USAGE = { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 }

/** A tool call the fake model makes: which tool, and its arguments as a JSON string. */
export interface FakeToolCall {
  name: string
  arguments: string
}

/** One scripted model reply: text, tool calls, or text followed by tool calls. */
export interface FakeTurn {
  reply?: string
  toolCalls?: FakeToolCall[]
}

/**
 * Stands in for the Workers AI binding (env.AI) with the same `run` signature,
 * replying in the OpenAI chat-completion shape that current models use.
 * Streams arrive in small byte slices, so lines and characters split across chunks.
 */
export class FakeAiBinding implements AiBinding {
  calls: Call[] = []
  failWith?: Error
  /** When set, a streamed call returns this raw SSE text instead of the reply. */
  rawSse?: string
  /** When set, a streamed call fails with this error after sending the first slice. */
  streamFailWith?: Error
  /** When set, a streamed reply stops once `after` bytes are sent, until `until` resolves: a model still writing. */
  pause?: { after: number; until: Promise<void> }
  /** When set, the model writes the reply as a preamble and then asks the client to run these tools. */
  toolCalls?: FakeToolCall[]
  /**
   * Replies for the next calls, one per call, used before `reply` and `toolCalls`:
   * a turn with tool calls asks the client to run them, one without answers with its text.
   */
  script: FakeTurn[] = []
  private nextToolCallId = 0

  constructor(private reply = 'Hello from Workers AI') {}

  async run(model: string, inputs: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ model, inputs, options })
    if (this.failWith) throw this.failWith

    const turn = this.script.shift()
    const reply = turn ? (turn.reply ?? '') : this.reply
    const toolCalls = turn ? turn.toolCalls : this.toolCalls
    if (toolCalls) return this.toolCallReply(model, toolCalls, inputs, reply)

    if (!inputs.stream) {
      return {
        object: 'chat.completion',
        model,
        choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
        usage: FAKE_USAGE,
      }
    }

    if (this.rawSse !== undefined) return new Response(this.rawSse).body

    const events: unknown[] = reply.split(' ').map((w) => ({ choices: [{ index: 0, delta: { content: w + ' ' } }] }))
    events.push({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
    // Like OpenAI, usage comes in a last chunk with no choices, only when asked for.
    const streamOptions = inputs.stream_options as { include_usage?: boolean } | undefined
    if (streamOptions?.include_usage) events.push({ choices: [], usage: FAKE_USAGE })
    return sliced(new TextEncoder().encode(toSse(events)), this.streamFailWith, this.pause)
  }

  /**
   * A reply that asks the client to run tools, in the shapes the real model returns (recorded in #35).
   * Streamed, each call's name comes first and its arguments follow in pieces, and usage arrives the
   * Workers AI way: per-chunk counts, a zeroed chunk, then a `response` chunk with the totals.
   */
  private toolCallReply(model: string, toolCalls: FakeToolCall[], inputs: Record<string, unknown>, reply: string) {
    // Like the real model's random ids, these don't repeat across replies.
    const ids = toolCalls.map(() => `chatcmpl-tool-${this.nextToolCallId++}`)
    if (!inputs.stream) {
      return {
        object: 'chat.completion',
        model,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: reply,
              tool_calls: toolCalls.map((t, i) => ({
                id: ids[i],
                type: 'function',
                function: { name: t.name, arguments: t.arguments },
              })),
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: FAKE_USAGE,
      }
    }

    const chunk = (delta: Record<string, unknown>, finish_reason: string | null = null) => ({
      choices: [{ index: 0, delta, finish_reason }],
      usage: { prompt_tokens: 0, completion_tokens: 1, total_tokens: 1 },
    })
    const events: unknown[] = [
      {
        choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
        usage: {
          prompt_tokens: FAKE_USAGE.prompt_tokens,
          completion_tokens: 0,
          total_tokens: FAKE_USAGE.prompt_tokens,
        },
      },
      ...(reply ? reply.split(' ').map((w) => chunk({ content: w + ' ' })) : []),
    ]
    // Short arguments (`{}`) come with the name; longer ones follow it in pieces, and the last piece
    // carries the finish reason. After short arguments the finish reason comes in a chunk of its own.
    let finishedOnPiece = false
    toolCalls.forEach((t, index) => {
      const head = { id: ids[index], type: 'function', index, function: { name: t.name } }
      finishedOnPiece = false
      if (t.arguments.length <= 2) {
        events.push(chunk({ tool_calls: [{ ...head, function: { ...head.function, arguments: t.arguments } }] }))
        return
      }
      events.push(chunk({ tool_calls: [head] }))
      for (let i = 0; i < t.arguments.length; i += 8) {
        const last = i + 8 >= t.arguments.length && index === toolCalls.length - 1
        const piece = { tool_calls: [{ index, function: { arguments: t.arguments.slice(i, i + 8) } }] }
        events.push(chunk(piece, last ? 'tool_calls' : null))
        finishedOnPiece ||= last
      }
    })
    if (!finishedOnPiece) events.push(chunk({}, 'tool_calls'))
    const streamOptions = inputs.stream_options as { include_usage?: boolean } | undefined
    if (streamOptions?.include_usage) {
      events.push({ choices: [], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } })
      events.push({ response: '', usage: FAKE_USAGE })
    }
    return sliced(new TextEncoder().encode(toSse(events)), this.streamFailWith, this.pause)
  }
}

const toSse = (events: unknown[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n'

function sliced(
  bytes: Uint8Array,
  failWith?: Error,
  pause?: { after: number; until: Promise<void> },
  size = 16,
): ReadableStream<Uint8Array> {
  let offset = 0
  return new ReadableStream({
    async pull(controller) {
      if (failWith && offset > 0) return controller.error(failWith)
      if (pause && offset >= pause.after) await pause.until
      if (offset >= bytes.length) return controller.close()
      controller.enqueue(bytes.slice(offset, (offset += size)))
    },
  })
}

/** In-memory storage with the same get/put shape as Durable Object storage. */
class MemoryStorage implements QuotaStorage {
  private data = new Map<string, unknown>()
  async get<T>(key: string) {
    return this.data.get(key) as T | undefined
  }
  async put<T>(key: string, value: T) {
    this.data.set(key, structuredClone(value))
  }
}

/**
 * Stands in for the UserQuota Durable Object namespace (env.QUOTA): one counter per name,
 * running the worker's real counting logic over in-memory storage.
 */
export class FakeQuotaNamespace implements QuotaNamespace {
  private storages = new Map<string, MemoryStorage>()
  /** When set, every counter call fails with this error, like an unavailable Durable Object. */
  failWith?: Error

  getByName(name: string): QuotaCounter {
    let storage = this.storages.get(name)
    if (!storage) this.storages.set(name, (storage = new MemoryStorage()))
    return {
      consume: async (day, limit) => {
        if (this.failWith) throw this.failWith
        return consume(storage, day, limit)
      },
    }
  }
}

type DataPoint = Parameters<UsageDataset['writeDataPoint']>[0]

/** Stands in for the Analytics Engine dataset (env.USAGE): keeps every data point written. */
export class FakeUsageDataset implements UsageDataset {
  points: DataPoint[] = []

  writeDataPoint(point: DataPoint): void {
    this.points.push(structuredClone(point))
  }
}
