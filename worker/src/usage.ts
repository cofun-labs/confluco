import * as z from './zod'

/** The slice of a Workers Analytics Engine dataset binding the usage records use. */
export interface UsageDataset {
  writeDataPoint(point: { indexes?: string[]; blobs?: string[]; doubles?: number[] }): void
}

/**
 * One chat request, described by size and outcome only. Never add message or reply text,
 * the system prompt, IP addresses, or raw request or response bodies.
 */
export interface UsageRecord {
  /** Clerk user id (pseudonymous). */
  userId: string
  model: string
  stream: boolean
  /** `ok`, `incomplete`, `cancelled`, `stream_error`, or the error code returned to the client. */
  outcome: string
  messages: number
  inputChars: number
  promptTokens: number
  completionTokens: number
  /** `stop`, `length`, `content_filter`, `tool_calls`, `other`, or empty when unknown. */
  finishReason: string
  /**
   * From the start of the request until it was refused, the reply was sent, or a stream ended.
   * For streams this includes the time the client takes to read the reply, or waited before cancelling.
   */
  durationMs: number
}

const FINISH_REASONS = new Set(['stop', 'length', 'content_filter', 'tool_calls'])

/** Keeps only known finish reasons, so nothing the model wrote can reach a record. */
export function finishReason(value: unknown): string {
  if (value === undefined || value === null || value === '') return ''
  return typeof value === 'string' && FINISH_REASONS.has(value) ? value : 'other'
}

/** A token count from the model, or 0 when missing or malformed. */
export function tokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0
}

/**
 * What a reply from the model, or one chunk of a streamed reply, says about itself. Only these
 * fields are read, loosely: a field that is not what is expected counts as missing, and anything
 * else in the reply is passed on unread.
 */
const Choice = z.object({ finish_reason: z.unknown().optional() }).catch({})

const ReplyInfo = z.object({
  error: z.unknown().optional(),
  usage: z
    .object({ prompt_tokens: z.unknown().optional(), completion_tokens: z.unknown().optional() })
    .optional()
    .catch(undefined),
  // The first choice, as `choices[0]` reads it: from a list, or from an object with a field named 0.
  choices: z.union([z.array(Choice), z.record(z.string(), Choice)]).catch([]),
})

/**
 * The fields of a reply or chunk that usage records read: its error, its token usage, and its first
 * choice's finish reason. Undefined when it is not an object.
 */
export function replyInfo(value: unknown) {
  const parsed = ReplyInfo.safeParse(value)
  if (!parsed.success) return undefined
  const { error, usage, choices } = parsed.data
  const first = Array.isArray(choices) ? choices[0] : choices['0']
  return { error, usage, finish_reason: first?.finish_reason }
}

/**
 * Writes one record. The column layout is what SQL queries rely on; append new columns, never reorder:
 *
 * - index1: user id
 * - blob1: model, blob2: outcome, blob3: finish reason, blob4: `stream` or `sync`
 * - double1: messages, double2: input characters, double3: prompt tokens,
 *   double4: completion tokens, double5: duration in ms
 *
 * Analytics Engine adds the timestamp itself.
 */
export function recordUsage(dataset: UsageDataset, r: UsageRecord): void {
  try {
    dataset.writeDataPoint({
      indexes: [r.userId],
      blobs: [r.model, r.outcome, r.finishReason, r.stream ? 'stream' : 'sync'],
      doubles: [r.messages, r.inputChars, r.promptTokens, r.completionTokens, r.durationMs],
    })
  } catch (err) {
    // A lost usage record must never fail the user's request.
    console.error('usage record failed', err)
  }
}

/** What the final chunks of an OpenAI-style stream say about the reply. */
interface StreamSummary {
  promptTokens: number
  completionTokens: number
  finishReason: string
}

/**
 * Passes an OpenAI-style SSE stream through unchanged, chunk by chunk, while reading the token
 * usage and finish reason from it. Calls `done` once, when the stream ends, fails, or is cancelled.
 * A stream that ends without `data: [DONE]` was cut short and is reported as `incomplete`; one
 * that carried an error event is reported as `provider_error`, like a failed non-streamed call.
 * Only the current incomplete line is held back for parsing; the reply itself is never buffered.
 */
export function meterStream(
  source: ReadableStream<Uint8Array>,
  done: (outcome: string, summary: StreamSummary) => void,
): ReadableStream<Uint8Array> {
  const reader = source.getReader()
  const decoder = new TextDecoder()
  const summary: StreamSummary = { promptTokens: 0, completionTokens: 0, finishReason: '' }
  let partial = ''
  let finished = false
  let sawDone = false
  let sawError = false
  const finish = (outcome: string) => {
    if (finished) return
    finished = true
    done(outcome, summary)
  }

  const scan = (line: string) => {
    if (!line.startsWith('data:')) return
    const data = line.slice(5).trim()
    if (data === '[DONE]') sawDone = true
    if (!data || data === '[DONE]') return
    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch {
      return
    }
    const event = replyInfo(parsed)
    if (!event) return
    // The model can report a failure inside the stream; the extension shows it as an error.
    if (event.error) sawError = true
    // OpenAI sends usage once, in the last chunk. Workers AI also adds per-chunk counts and a
    // zeroed chunk before its final totals, so keep the largest count seen.
    if (event.usage) {
      summary.promptTokens = Math.max(summary.promptTokens, tokenCount(event.usage.prompt_tokens))
      summary.completionTokens = Math.max(summary.completionTokens, tokenCount(event.usage.completion_tokens))
    }
    const reason = event.finish_reason
    if (reason) summary.finishReason = finishReason(reason)
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let result: ReadableStreamReadResult<Uint8Array>
      try {
        result = await reader.read()
      } catch (err) {
        // Once the client has cancelled, the stream is closed and must not be touched.
        if (finished) return
        finish(sawError ? 'provider_error' : 'stream_error')
        controller.error(err)
        return
      }
      if (finished) return
      if (result.done) {
        scan(partial + decoder.decode())
        finish(sawError ? 'provider_error' : sawDone ? 'ok' : 'incomplete')
        controller.close()
        return
      }
      const lines = (partial + decoder.decode(result.value, { stream: true })).split('\n')
      partial = lines.pop() ?? ''
      for (const line of lines) scan(line.trimEnd())
      controller.enqueue(result.value)
    },
    async cancel(reason) {
      // A client that reads an error event stops reading at once, so the error decides the outcome.
      finish(sawError ? 'provider_error' : 'cancelled')
      await reader.cancel(reason)
    },
  })
}
