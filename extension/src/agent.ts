// The side panel's agent: asks the worker's model, runs the tools it calls in the extension, and
// sends the results back until the model answers. This is the only module that imports the agent
// runtime (pi); the rest of the extension uses the types below.
import { Agent, type AgentEvent, type AgentMessage, type AgentTool } from '@earendil-works/pi-agent-core'
import type { AssistantMessage, Model, ToolCall, ToolResultMessage } from '@earendil-works/pi-ai'
import { streamSimple } from '@earendil-works/pi-ai/api/openai-completions'
import { z } from './zod'

export interface AgentConfig {
  /** Base URL including /v1. */
  apiUrl: string
  /** Returns a fresh Clerk session token. Called before every model request. */
  getToken: () => Promise<string | null>
  systemPrompt: string
  tools: ToolSpec[]
  /**
   * Read before each question and sent to the model ahead of it, e.g. which page is open. It is saved
   * with the question but is not part of what the user typed.
   */
  context?: () => Promise<string | undefined>
  /** Model calls allowed per question. */
  maxSteps?: number
  /** How much of a long conversation to send. Defaults stay well under the worker's limits. */
  history?: { messages: number; chars: number }
  /**
   * Called as each question starts, to count the requests its tools make to the user's workspace. `ask` puts a yes/no question to the user on the card of the tool that is running, and
   * resolves false when the question is stopped or nobody can be asked.
   */
  meter?: (ask: (question: string) => Promise<boolean>) => QuestionMeter
}

/** What a question's tools sent, read when it ends. */
interface QuestionMeter {
  readonly requests: number
  /** A request that changes the user's data was sent and may have landed. */
  readonly wrote: boolean
}

/** A tool the model can ask the extension to run. */
export interface ToolSpec {
  name: string
  description: string
  /**
   * JSON Schema of the arguments object. The model is sent it, and the agent runtime checks each
   * call against it before the tool runs (see `toAgentTool`). Define a tool with `defineTool`
   * (tool.ts), which derives this from the schema it parses the arguments with.
   */
  parameters: object
  /**
   * Runs the tool. Throw to report a failure to the model. An error with a `stopsQuestion` string
   * (on it or a cause) also stops the question: nothing more runs, and the user is told that string.
   * The arguments come from the model: a tool parses them before it uses them.
   */
  run: (args: unknown, signal?: AbortSignal) => Promise<unknown>
  /** Whether the tool requires consent before running. A function can inspect the prepared preview. */
  needsConfirmation?: boolean | (() => boolean)
  /**
   * The tool changes the user's data. When a question stops after such a tool ran and changed
   * something, or may have (its error has `mayHaveChanged`), the user is told to check before
   * asking again, so they don't ask for a change twice. A predicate can distinguish a verified
   * no-op from a successful write. A tool that cannot make that distinction can use `true`.
   */
  changesData?: boolean | ((result: unknown) => boolean)
  /**
   * What a call does, in words, from the state before it runs: shown on the call's card, and to the
   * user before agreeing when the tool needs confirmation. It may look things up first.
   */
  preview?: (args: unknown, signal?: AbortSignal) => string | undefined | Promise<string | undefined>
}

/** A tool call waiting for the user's OK. */
export interface ToolCallRequest {
  id: string
  name: string
  args: unknown
  /** What the call would change, in words, when the tool can say. */
  preview?: string
  /**
   * Set when the call is already running and asks the user this instead, such as whether to go on
   * at the question's request budget; resolves true for yes.
   */
  question?: string
}

/** Asks the user whether a tool may run, or what `question` asks; resolves true for yes. */
export type ConfirmTool = (call: ToolCallRequest) => Promise<boolean>

/**
 * How a tool call ended. `skipped`: refused without running, because the question reached its step
 * limit. `stopped`: the user stopped the question while the tool ran or waited for their OK.
 * `declined`: the user did not let it run.
 */
export type ToolStatus = 'done' | 'failed' | 'skipped' | 'stopped' | 'declined'

/** What the side panel shows while the agent works on a question. */
export type AgentUpdate =
  | { type: 'text'; delta: string }
  | { type: 'tool_start'; id: string; name: string; args: unknown }
  /**
   * The call passed validation and runs next, or is put to the user first: `args` as the tool gets
   * them (the model's, checked and converted to the schema), and what it changes, when the tool can say.
   */
  | { type: 'tool_ready'; id: string; args: unknown; preview?: string }
  /** `result`: what the model got back, the error message when the tool failed. */
  | { type: 'tool_end'; id: string; name: string; status: ToolStatus; result: string }

/**
 * The conversation as the agent keeps it, in a form of our own, so saved sessions don't depend on
 * the agent runtime. A reply is an assistant message followed by the results of the tools it called;
 * a question may take several such steps before the final answer.
 */
export type HistoryMessage =
  /**
   * `context`: what the model was told with the question, besides what the user typed.
   * `requests`: how many requests its tools made (see AgentConfig.meter), once it ended.
   */
  | { role: 'user'; text: string; context?: string; requests?: number }
  | { role: 'assistant'; parts: AssistantPart[] }
  /** The result of one tool call. `id` matches the call in the assistant message before it. */
  | { role: 'tool'; id: string; name: string; status: ToolStatus; result: string }

/** What the model wrote, in order: text and the tools it asked to run. */
type AssistantPart =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string; args: Record<string, unknown> }

/** `requests`: how many requests the question's tools made, when it ran and the agent counts them. */
export type AskResult = (
  | { status: 'done' }
  | { status: 'stopped'; mayHaveChanged?: true }
  | { status: 'step_limit'; steps: number }
  | { status: 'error'; message: string }
) & { requests?: number }

const DEFAULT_MAX_STEPS = 10
// The worker allows 200 messages and 200,000 characters, tools included.
const DEFAULT_HISTORY = { messages: 100, chars: 150_000 }

const SIGN_IN = 'Please sign in first.'
// What the model gets back for a call the user declined; it should not just try again.
const DECLINED = 'Not run: the user declined this action. Do not retry it; ask the user how to proceed instead.'
// The same when there was nobody to ask: the model must not claim the user said no.
const UNASKED = "Not run: this action needs the user's confirmation, and they could not be asked."
/** Added for the user when a question stops after a tool changed something, or may have. */
export const MAY_HAVE_CHANGED = 'Some changes in this question may already have been made: check before asking again.'
/** For the model: the reason itself is in the failed tool's result. */
const STOPPED_BY_ERROR = "Not run: an earlier tool's error stopped the question."
/** For the model, when the question stopped while this call, or an earlier one, was being prepared. */
function stoppedInPreview(reason: string, earlier: boolean): string {
  const which = earlier ? 'an earlier action' : 'this action'
  return `Not run: the question stopped while ${which} was being prepared. The user was told: ${reason}`
}
// What the model gets back for a call the user stopped: whether it may have done something matters
// for a tool that changes a page.
const STOPPED_BEFORE = 'Not run: the user stopped the question before this action started.'
const STOPPED_DURING =
  'Stopped by the user while this action was running; it may have partly happened. Check before trying it again.'

export class CopilotAgent {
  private agent?: Agent
  private model?: Model<'openai-completions'>
  private readonly maxSteps: number
  private readonly tools: Map<string, ToolSpec>
  /** Bumped by stop() and reset(), so a question still waiting to start knows it was cancelled. */
  private epoch = 0
  /** Aborted with each epoch bump, so waits that pi doesn't cut short end too. */
  private cancel = new AbortController()
  /** The question this agent is answering; reset() clears it, since the next one gets a new pi agent. */
  private running?: { changed: boolean }
  /** The conversation to start from, used when the next pi agent is set up. */
  private initial: HistoryMessage[] = []
  /** How each tool call ended, by its result message; pi itself only knows whether it failed. */
  private readonly statuses = new WeakMap<AgentMessage, ToolStatus>()
  /** What the model is told with each question, by its user message; see AgentConfig.context. */
  private readonly contexts = new WeakMap<AgentMessage, string>()
  /** The requests each question made, by its user message; see AgentConfig.meter. */
  private readonly requests = new WeakMap<AgentMessage, number>()
  /** Set by a tool whose error stops the question (see `stopsQuestion`): what the user is told. */
  private stopReason?: string
  constructor(private readonly config: AgentConfig) {
    this.maxSteps = config.maxSteps ?? DEFAULT_MAX_STEPS
    this.tools = new Map(config.tools.map((t) => [t.name, t]))
  }

  /**
   * Asks one question and resolves once the agent answered, stopped, hit the step limit, or failed.
   * The conversation carries over to the next question. A question that fails or is stopped keeps
   * only the tools it used and how they ended, so the model learns what already happened (a tool may
   * have changed a page) but never sees a half-finished reply. If it used no tool, it is dropped.
   *
   * `confirm` is asked before each run of a tool that needs confirmation. Without it, such tools
   * are declined.
   */
  async ask(text: string, onUpdate: (update: AgentUpdate) => void, confirm?: ConfirmTool): Promise<AskResult> {
    // One question at a time: an overlapping run would roll back the other's messages.
    if (this.running) return { status: 'error', message: 'Already answering a question.' }
    const question = { changed: false }
    this.running = question
    try {
      return await this.askWithRetry(text, onUpdate, confirm)
    } finally {
      if (this.running === question) this.running = undefined
    }
  }

  private async askWithRetry(
    text: string,
    onUpdate: (update: AgentUpdate) => void,
    confirm?: ConfirmTool,
  ): Promise<AskResult> {
    const epoch = this.epoch
    const { result, kept, code } = await this.askOnce(text, onUpdate, epoch, confirm)
    // The worker's model changed since this panel looked it up (a deploy). The worker refuses the
    // request before using any quota, so look the model up again. Retry once if the question left
    // nothing behind; a retry runs the whole question again, so after it used a tool (which is now
    // in the conversation), ask the user to repeat it instead.
    if (code === 'unsupported_model' && epoch === this.epoch) {
      // What the first try sent counts even when the question goes no further.
      const counted = result.requests === undefined ? {} : { requests: result.requests }
      try {
        this.model = await this.loadModel()
      } catch (err) {
        return { status: 'error', message: (err as Error).message, ...counted }
      }
      if (this.agent) this.agent.state.model = this.model
      // The question stays in the conversation with the tools it used, so the model can pick up
      // where it left off; asking the same question again could run those tools twice.
      if (kept) return { status: 'error', message: 'Copilot was just updated. Ask it to continue.', ...counted }
      return (await this.askOnce(text, onUpdate, epoch, confirm)).result
    }
    return result
  }

  /** `kept`: the question is part of the conversation now, answered or not. */
  private async askOnce(
    text: string,
    onUpdate: (update: AgentUpdate) => void,
    epoch: number,
    confirm?: ConfirmTool,
  ): Promise<{ result: AskResult; kept: boolean; code?: string }> {
    const run = this.running
    let agent: Agent
    try {
      agent = await this.getAgent()
    } catch (err) {
      return { result: { status: 'error', message: (err as Error).message }, kept: false }
    }
    // Stopped, or a new chat started, while the agent was being set up.
    if (epoch !== this.epoch) return { result: { status: 'stopped' }, kept: false }
    const context = await this.readContext()
    if (epoch !== this.epoch) return { result: { status: 'stopped' }, kept: false }

    const before = agent.state.messages.length
    this.stopReason = undefined
    let steps = 0
    let hitLimit = false
    let failure: Failure | undefined
    let stopped = false
    // The model gave its final answer; a Stop after this point is too late to drop it.
    let answered = false
    const refused = new Set<string>()
    const declined = new Set<string>()
    // How the latest call with each id ended, kept with its result message when that arrives.
    const ended = new Map<string, { status: ToolStatus; result: string }>()
    // Calls allowed to run, so a Stop may have cut them short; the others never started. For a tool
    // that needs the user's OK, a Stop between the OK and the run counts as started: for a tool that
    // changes pages, "may have partly happened" is the safe thing to tell the model.
    const started = new Set<string>()
    // The call running now (tools run one at a time), for a question it puts to the user.
    let running: ToolCallRequest | undefined
    // Why the question stopped, when it stopped in a call's preview rather than in a tool's run.
    let previewStop: string | undefined
    const meter = this.config.meter?.(async (text) => {
      const call = running
      if (!call || epoch !== this.epoch) return false
      const answer = await askUser(confirm, { ...call, question: text }, this.cancel.signal)
      return answer === 'allow' && epoch === this.epoch
    })

    // On the last step, refuse the tools the model asks for instead of running them: the question
    // ends here, so the model would never see their results, and a tool could change a page.
    agent.beforeToolCall = async ({ toolCall, args }, signal) => {
      // A tool's error, or an earlier call's preview, stopped the question: nothing more runs.
      if (this.stopReason) {
        refused.add(toolCall.id)
        const reason = previewStop === undefined ? STOPPED_BY_ERROR : stoppedInPreview(previewStop, true)
        return { block: true, reason, terminate: true }
      }
      if (steps >= this.maxSteps) {
        hitLimit = true
        refused.add(toolCall.id)
        return {
          block: true,
          reason: `Not run: this question reached its limit of ${this.maxSteps} steps.`,
          terminate: true,
        }
      }
      const nulls = coercedNulls(toolCall.arguments, args)
      if (nulls.length) {
        return {
          block: true,
          reason:
            `Not run: null is not a value for ${nulls.map((path) => `\`${path}\``).join(', ')}. ` +
            'Give the call again with a value there, or ask the user for one.',
        }
      }
      // Running from here on: a preview's lookups count toward the question, so at its request budget
      // they ask the user on this call's card.
      running = { id: toolCall.id, name: toolCall.name, args }
      // From the arguments the tool runs with, and before it runs: the run may change what the preview reads.
      const tool = this.tools.get(toolCall.name)
      const { preview, stop } = await previewCall(tool, args, signal)
      // Stopped while the preview looked things up: the tool must not start.
      if (signal?.aborted || epoch !== this.epoch) {
        running = undefined
        return { block: true, reason: STOPPED_BEFORE }
      }
      // The workspace turned the preview's lookups away, or the user stopped at the budget: the question
      // stops here, before anyone is asked.
      if (stop) {
        running = undefined
        this.stopReason ??= stop
        previewStop = stop
        refused.add(toolCall.id)
        return { block: true, reason: stoppedInPreview(stop, false), terminate: true }
      }
      onUpdate({ type: 'tool_ready', id: toolCall.id, args, preview })
      const call: ToolCallRequest = { id: toolCall.id, name: toolCall.name, args, preview }
      running = call
      const needsConfirmation = tool?.needsConfirmation
      if (!(typeof needsConfirmation === 'function' ? needsConfirmation() : needsConfirmation)) {
        started.add(toolCall.id)
        return
      }
      const answer = await askUser(confirm, call, signal)
      if (answer === 'allow' && epoch === this.epoch) {
        started.add(toolCall.id)
        return
      }
      running = undefined
      // Only a no from the user shows as declined. Stopped while waiting shows as stopped, and a
      // prompt that could not be shown as failed, with the reason.
      if (answer === 'deny' && epoch === this.epoch) declined.add(toolCall.id)
      return { block: true, reason: answer === 'deny' ? DECLINED : UNASKED }
    }
    // The model gets no more turns once the steps are used up. beforeToolCall above only sees calls
    // that pi could prepare; unknown tools and invalid arguments get error results without it.
    agent.finishTurn = async ({ toolResults }) => {
      if (this.stopReason) return { action: 'end' }
      if (steps < this.maxSteps || toolResults.length === 0) return
      hitLimit = true
      return { action: 'end' }
    }
    const unsubscribe = agent.subscribe((event: AgentEvent) => {
      if (event.type === 'turn_start') steps++
      const update = toUpdate(event)
      if (update?.type === 'tool_end') {
        if (refused.has(update.id)) update.status = 'skipped'
        else if (declined.has(update.id)) update.status = 'declined'
        // A tool cut short by Stop reports an error; it did not fail on its own. A tool that
        // finished anyway keeps its result: what it did happened.
        else if (update.status === 'failed' && epoch !== this.epoch) {
          update.status = 'stopped'
          // Tell the model whether the tool could have done anything. One that ran keeps its own
          // error too: it may have failed on its own just as Stop landed.
          update.result = started.has(update.id) ? `${STOPPED_DURING}\n${update.result}` : STOPPED_BEFORE
        }
        started.delete(update.id)
        if (running?.id === update.id) running = undefined
        ended.set(update.id, { status: update.status, result: update.result })
      }
      if (update) onUpdate(update)
      if (event.type === 'message_end' && event.message.role === 'toolResult') {
        const end = ended.get(event.message.toolCallId)
        if (end) this.statuses.set(event.message, end.status)
        // pi keeps this same message in the conversation, so the model gets the text the panel shows.
        if (end?.status === 'stopped') event.message.content = [{ type: 'text', text: end.result }]
      }
      if (event.type === 'message_end' && event.message.role === 'assistant') {
        const m = event.message as AssistantMessage
        if (m.stopReason === 'error') failure = parseError(m.errorMessage)
        if (m.stopReason === 'aborted') stopped = true
        const final = !m.content.some((block) => block.type === 'toolCall')
        if (final && (m.stopReason === 'stop' || m.stopReason === 'length')) answered = true
      }
    })

    // String content: the worker accepts only text, and pi would otherwise send content parts.
    const question: AgentMessage = { role: 'user', content: text, timestamp: Date.now() }
    try {
      if (context) this.contexts.set(question, context)
      await agent.prompt(question)
    } catch (err) {
      failure ??= parseError((err as Error).message)
    } finally {
      unsubscribe()
      agent.beforeToolCall = undefined
      agent.finishTurn = undefined
    }
    // Kept with the question, so a saved session still has it.
    const counted = meter && { requests: meter.requests }
    if (meter) this.requests.set(question, meter.requests)

    // Also stopped when the abort landed after a model reply that asked for tools, e.g. while a tool
    // finished. A stop after the final answer keeps it: the user has already read it.
    stopped ||= epoch !== this.epoch && !answered
    // A write that was sent counts even when the tool that sent it does not say it changed data.
    const changed = run?.changed === true || meter?.wrote === true
    if (!stopped && this.stopReason) failure ??= { text: this.stopReason }
    if (failure || stopped) {
      const kept = usedTools(agent.state.messages.slice(before))
      agent.state.messages = [...agent.state.messages.slice(0, before), ...kept]
      const result: AskResult = stopped
        ? { status: 'stopped', ...(changed && { mayHaveChanged: true }) }
        : { status: 'error', message: changed ? `${failure!.text} ${MAY_HAVE_CHANGED}` : failure!.text }
      return { result: { ...result, ...counted }, kept: kept.length > 0, code: stopped ? undefined : failure?.code }
    }
    const result: AskResult = hitLimit ? { status: 'step_limit', steps } : { status: 'done' }
    return { result: { ...result, ...counted }, kept: true }
  }

  /**
   * A context that fails to load must not block the question; it goes without one. Stop ends the
   * wait even if the context never comes.
   */
  private async readContext(): Promise<string | undefined> {
    if (!this.config.context) return undefined
    const { signal } = this.cancel
    if (signal.aborted) return undefined
    let onAbort!: () => void
    const stopped = new Promise<undefined>((resolve) => (onAbort = () => resolve(undefined)))
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      return await Promise.race([this.config.context(), stopped])
    } catch (err) {
      console.error('Could not read the context for the question', err)
      return undefined
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }

  /** Stops the current model call and any running tool. */
  stop(): void {
    this.epoch++
    this.cancel.abort()
    this.cancel = new AbortController()
    this.agent?.abort()
  }

  /**
   * Starts another conversation: a new one, or `history` to continue a saved one. A question still
   * running is stopped first. It looks up the model again.
   */
  async reset(history: HistoryMessage[] = []): Promise<void> {
    this.epoch++
    this.cancel.abort()
    this.cancel = new AbortController()
    const agent = this.agent
    this.agent = undefined
    this.model = undefined
    this.running = undefined
    this.initial = history
    if (!agent) return
    agent.abort()
    await agent.waitForIdle()
  }

  /**
   * The conversation so far, to save and later continue with reset(). Of a question that failed or
   * was stopped, only the tools it used are part of it. Read it between questions: while one runs, it
   * is still changing.
   */
  history(): HistoryMessage[] {
    if (!this.agent) return this.initial
    return this.agent.state.messages.flatMap((m) => this.toHistory(m))
  }

  private toHistory(message: AgentMessage): HistoryMessage[] {
    switch (message.role) {
      case 'user': {
        const context = this.contexts.get(message)
        const requests = this.requests.get(message)
        return [
          {
            role: 'user',
            text: textOf(message.content),
            ...(context && { context }),
            ...(requests !== undefined && { requests }),
          },
        ]
      }
      case 'assistant':
        return [
          {
            role: 'assistant',
            parts: message.content.flatMap((block): AssistantPart[] => {
              if (block.type === 'text') return [{ type: 'text', text: block.text }]
              if (block.type === 'toolCall')
                return [{ type: 'tool_call', id: block.id, name: block.name, args: block.arguments }]
              return []
            }),
          },
        ]
      case 'toolResult':
        return [
          {
            role: 'tool',
            id: message.toolCallId,
            name: message.toolName,
            status: this.statuses.get(message) ?? (message.isError ? 'failed' : 'done'),
            result: textOf(message.content),
          },
        ]
      default:
        return []
    }
  }

  private fromHistory(history: HistoryMessage[], model: Model<'openai-completions'>): AgentMessage[] {
    const timestamp = Date.now()
    return history.map((m): AgentMessage => {
      if (m.role === 'user') {
        const question: AgentMessage = { role: 'user', content: m.text, timestamp }
        if (m.context) this.contexts.set(question, m.context)
        if (m.requests !== undefined) this.requests.set(question, m.requests)
        return question
      }
      if (m.role === 'assistant') {
        const content: AssistantMessage['content'] = m.parts.map((p) =>
          p.type === 'text'
            ? { type: 'text', text: p.text }
            : { type: 'toolCall', id: p.id, name: p.name, arguments: p.args as ToolCall['arguments'] },
        )
        return {
          role: 'assistant',
          content,
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: ZERO_COST },
          stopReason: content.some((c) => c.type === 'toolCall') ? 'toolUse' : 'stop',
          timestamp,
        }
      }
      const result: AgentMessage = {
        role: 'toolResult',
        toolCallId: m.id,
        toolName: m.name,
        content: [{ type: 'text', text: m.result }],
        isError: m.status !== 'done',
        timestamp,
      }
      this.statuses.set(result, m.status)
      return result
    })
  }

  /**
   * For a tool starting now: how it reports to the running question that it stops it (with a
   * reason for the user) or changed data. A tool still running from a question that was stopped
   * or reset reports nothing to the next one.
   */
  private reporter(): Reporter {
    const epoch = this.epoch
    const run = this.running
    return {
      stop: (reason) => {
        if (epoch === this.epoch) this.stopReason ??= reason
      },
      changed: () => {
        // A stopped write can report an uncertain outcome after the epoch changed.
        if (run) run.changed = true
      },
    }
  }

  private async getAgent(): Promise<Agent> {
    if (this.agent) return this.agent
    const model = (this.model ??= await this.loadModel())
    // Another question (after a New chat) may have set up the agent while this one waited.
    if (this.agent) return this.agent
    // The tool definitions go with every request and count toward the worker's size limit.
    const toolChars = JSON.stringify(
      this.config.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
    ).length
    this.agent = new Agent({
      initialState: {
        systemPrompt: this.config.systemPrompt,
        model,
        tools: this.config.tools.map((t) => toAgentTool(t, () => this.reporter())),
        messages: this.fromHistory(this.initial, model),
      },
      streamFn: (m, context, options) => streamSimple(m as Model<'openai-completions'>, context, options),
      // A fresh Clerk token for every model request; they expire within minutes.
      getApiKey: async () => {
        const token = await this.config.getToken()
        if (!token) throw new Error(SIGN_IN)
        return token
      },
      // No provider attribution headers; the worker is our own.
      identity: { attribution: null },
      // Tools may change data; run them one at a time, in the order the model asked.
      toolExecution: 'sequential',
      transformContext: async (messages) =>
        recent(
          messages.map((m) => this.withContext(m)),
          this.config.history ?? DEFAULT_HISTORY,
          toolChars,
        ),
    })
    return this.agent
  }

  /** The question as the model gets it: its context first, then what the user typed. */
  private withContext(message: AgentMessage): AgentMessage {
    const context = this.contexts.get(message)
    if (!context || message.role !== 'user') return message
    return { ...message, content: `${context}\n\n${textOf(message.content)}` }
  }

  /** The worker fixes the model; ask it which one, so requests name it. */
  private async loadModel(): Promise<Model<'openai-completions'>> {
    const token = await this.config.getToken()
    if (!token) throw new Error(SIGN_IN)
    const baseUrl = this.config.apiUrl.replace(/\/+$/, '')
    const res = await fetch(`${baseUrl}/me`, { headers: { authorization: `Bearer ${token}` } })
    const body = MeReply.safeParse(await res.json().catch(() => undefined)).data
    const model = body?.model
    if (!res.ok || !model) throw new Error(body?.error?.message ?? `HTTP ${res.status}`)
    return {
      id: model,
      name: model,
      api: 'openai-completions',
      provider: 'confluco',
      baseUrl,
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 16_384,
      // What the worker accepts: system (not developer) messages, max_tokens, no store field.
      compat: {
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        supportsStore: false,
        supportsStrictMode: false,
        maxTokensField: 'max_tokens',
      },
    }
  }
}

/**
 * What stays of a question that failed or was stopped (`tail`: its messages, starting with the
 * question): the question and each step's tool calls that ended, with their results, so every call
 * kept is still answered right after its message. A step's calls without a result are left out:
 * after a Stop, pi skips the calls that come after the one running. The reply that failed or was cut
 * off is left out with everything after it. Empty when the question used no tool.
 */
function usedTools(tail: AgentMessage[]): AgentMessage[] {
  // The question, with anything pi put before it.
  const start = tail.findIndex((m) => m.role === 'user') + 1
  const question = tail.slice(0, start)
  const rest = tail.slice(start)
  const kept: AgentMessage[] = []
  for (let i = 0; i < rest.length;) {
    const reply = rest[i]
    if (reply.role !== 'assistant' || reply.stopReason === 'error' || reply.stopReason === 'aborted') break
    let next = i + 1
    while (next < rest.length && rest[next].role === 'toolResult') next++
    const results = rest.slice(i + 1, next) as ToolResultMessage[]
    const answered = new Set(results.map((r) => r.toolCallId))
    const content = reply.content.filter((block) => block.type !== 'toolCall' || answered.has(block.id))
    if (!content.some((block) => block.type === 'toolCall')) break
    kept.push({ ...reply, content }, ...results)
    i = next
  }
  return kept.length ? [...question, ...kept] : []
}

/**
 * The leading system messages plus the newest part of the conversation that fits the limits.
 * The character budget also pays for the system prompt and the tool definitions (`overhead`).
 * It starts at a user message, so a reply or tool result is never sent without what led to it.
 * The newest question is always kept; if it alone is too long, the worker says so.
 */
function recent(
  messages: AgentMessage[],
  limits: { messages: number; chars: number },
  overhead: number,
): AgentMessage[] {
  let head = 0
  while (head < messages.length && messages[head].role === 'system') head++
  const rest = messages.slice(head)
  let start = rest.length
  let chars = overhead + messages.slice(0, head).reduce((n, m) => n + size(m), 0)
  for (let i = rest.length - 1; i >= 0 && rest.length - i <= limits.messages; i--) {
    chars += size(rest[i])
    if (chars > limits.chars) break
    if (rest[i].role === 'user') start = i
  }
  if (start === rest.length) {
    for (start = rest.length - 1; start > 0 && rest[start].role !== 'user'; start--);
  }
  return [...messages.slice(0, head), ...rest.slice(start)]
}

/** Characters a message adds to a request: its text, tool calls, and tool results. */
function size(message: AgentMessage): number {
  if (!('content' in message)) return 0
  const { content } = message
  if (typeof content === 'string') return content.length
  if (!Array.isArray(content)) return 0
  let n = 0
  for (const block of content) {
    if (block.type === 'text') n += block.text.length
    else if (block.type === 'toolCall') n += block.name.length + JSON.stringify(block.arguments).length
  }
  return n
}

/**
 * What a call changes, in words; a broken preview must not stop the call, so it gives none. A
 * preview error that stops the question (see `stopsQuestion`) comes back as `stop`.
 */
async function previewCall(
  tool: ToolSpec | undefined,
  args: unknown,
  signal?: AbortSignal,
): Promise<{ preview?: string; stop?: string }> {
  try {
    const preview = tool?.preview?.(args, signal)
    if (typeof preview === 'string' || preview === undefined) return { preview }
    // Stop must not wait for a preview that looks things up.
    return {
      preview: await new Promise<string | undefined>((resolve, reject) => {
        const onAbort = () => resolve(undefined)
        signal?.addEventListener('abort', onAbort, { once: true })
        preview.then(resolve, reject).finally(() => signal?.removeEventListener('abort', onAbort))
        if (signal?.aborted) onAbort()
      }),
    }
  } catch (err) {
    // A preview turned away by the workspace stops the question, like a tool's error would.
    const stop = stopsQuestion(err)
    if (stop) return { stop }
    console.error('Could not preview the tool call', err)
    return {}
  }
}

/**
 * The user's answer. `unasked` when there was no way to ask (no callback, or it failed) or the
 * question was stopped while waiting: the tool must not run, but the user did not say no.
 */
function askUser(
  confirm: ConfirmTool | undefined,
  call: ToolCallRequest,
  signal?: AbortSignal,
): Promise<'allow' | 'deny' | 'unasked'> {
  if (!confirm || signal?.aborted) return Promise.resolve('unasked')
  return new Promise((resolve) => {
    const onAbort = () => resolve('unasked')
    signal?.addEventListener('abort', onAbort, { once: true })
    confirm(call)
      .then(
        (allow) => resolve(allow ? 'allow' : 'deny'),
        () => resolve('unasked'),
      )
      .finally(() => signal?.removeEventListener('abort', onAbort))
  })
}

/**
 * The reason a tool's error stops the question, if it does: a `stopsQuestion` string on the error
 * or on one of its causes (a tool may wrap the error it got).
 */
function stopsQuestion(err: unknown): string | undefined {
  const reason = causes(err).find((e) => typeof e.stopsQuestion === 'string')?.stopsQuestion
  return reason as string | undefined
}

/** The error and its causes (a tool may wrap the error it got). */
function causes(err: unknown): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (let e = err; e && typeof e === 'object' && out.length < 5; e = (e as Error).cause) {
    out.push(e as Record<string, unknown>)
  }
  return out
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Compare the model's arguments with the validated copy. An optional null may be dropped and a
 * valid null stays null. Refuse conversions such as null to "null", 0 or false before the preview.
 */
function coercedNulls(raw: unknown, args: unknown, path = ''): string[] {
  if (raw === null) return args !== null && args !== undefined ? [path] : []
  if (Array.isArray(args)) {
    if (Array.isArray(raw)) {
      return raw.flatMap((value, i) => coercedNulls(value, args[i], `${path}[${i}]`))
    }
    // The validator can wrap one value in an array. Keep paths as the model wrote them.
    return args.length === 1 ? coercedNulls(raw, args[0], path) : []
  }
  if (!isRecord(raw) || !isRecord(args)) return []
  return Object.entries(raw).flatMap(([key, value]) =>
    coercedNulls(value, Object.hasOwn(args, key) ? args[key] : undefined, path ? `${path}.${key}` : key),
  )
}

interface Reporter {
  stop(reason: string): void
  changed(): void
}

/**
 * The tool as pi runs it. Before `execute`, pi converts the model's arguments where it can (a null
 * for an optional argument is dropped, "2" becomes 2 for a number, one value becomes a list of one)
 * and checks the result against `parameters`. A call that does not fit never reaches the tool or
 * `beforeToolCall`: the model gets pi's list of what is wrong with each argument. The tool gets the
 * converted copy, which it parses itself when it is defined with `defineTool` (tool.ts).
 */
function toAgentTool(spec: ToolSpec, reporter: () => Reporter): AgentTool {
  return {
    name: spec.name,
    label: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    execute: async (_id, params, signal) => {
      const report = reporter()
      let result: unknown
      try {
        result = await spec.run(params, signal)
      } catch (err) {
        const reason = stopsQuestion(err)
        if (reason) report.stop(reason)
        // An error that says data may have changed counts on its own, flag or not.
        if (causes(err).some((e) => e.mayHaveChanged === true)) report.changed()
        throw err
      }
      const changed = typeof spec.changesData === 'function' ? spec.changesData(result) : spec.changesData
      if (changed) report.changed()
      // JSON.stringify(undefined) is undefined; tool results must be strings.
      const text = typeof result === 'string' ? result : (JSON.stringify(result) ?? '')
      return { content: [{ type: 'text', text }], details: undefined }
    },
  }
}

function toUpdate(event: AgentEvent): AgentUpdate | undefined {
  switch (event.type) {
    case 'message_update':
      return event.assistantMessageEvent.type === 'text_delta'
        ? { type: 'text', delta: event.assistantMessageEvent.delta }
        : undefined
    case 'tool_execution_start':
      return { type: 'tool_start', id: event.toolCallId, name: event.toolName, args: event.args }
    case 'tool_execution_end':
      return {
        type: 'tool_end',
        id: event.toolCallId,
        name: event.toolName,
        status: event.isError ? 'failed' : 'done',
        result: resultText(event.result),
      }
    default:
      return undefined
  }
}

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }

/** The text of a message's content: a string, or text blocks among others. */
function textOf(content: string | { type: string; text?: string }[]): string {
  if (typeof content === 'string') return content
  return content.map((block) => (block.type === 'text' ? (block.text ?? '') : '')).join('\n')
}

/** The text a tool result gave the model. */
function resultText(result: { content?: { type: string; text?: string }[] } | undefined): string {
  return (result?.content ?? []).map((block) => (block.type === 'text' ? (block.text ?? '') : '')).join('\n')
}

// What the worker answers, as far as the agent reads it. Each field is read loosely: one that is not
// text counts as missing, so a reply the agent can't read ends in the fallback, never in a wrong value.
const text = z.string().optional().catch(undefined)

/** The worker's answer to `/me`: the model it uses, or why it refused. */
const MeReply = z.object({ model: text, error: z.object({ message: text }).optional().catch(undefined) })

/** An error as the worker words it. */
const ErrorFields = z.object({ code: text, message: text })
/** The body of a failed request: the error itself, or wrapped in `error`. */
const ErrorBody = ErrorFields.extend({ error: z.unknown().optional() })

/**
 * The worker's own error message and code when there are any. The SDK reports HTTP errors as
 * `<status>: <body>` or `<status> <message>`, and the worker's body is `{ error: { code, message } }`
 * (sometimes already unwrapped to `{ code, message }`).
 */
function parseError(message: string | undefined): Failure {
  if (!message) return { text: 'The model failed.' }
  const rest = message.replace(/^\d{3}:?\s+/, '')
  let json: unknown
  try {
    json = JSON.parse(rest)
  } catch {
    return { text: rest }
  }
  const body = ErrorBody.safeParse(json).data
  const inner = body?.error === undefined || body.error === null ? body : ErrorFields.safeParse(body.error).data
  return inner?.message ? { text: inner.message, code: inner.code } : { text: rest }
}

interface Failure {
  text: string
  /** The worker's error code, e.g. `unsupported_model`. */
  code?: string
}
