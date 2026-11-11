// A small Chrome DevTools Protocol client: one WebSocket to the browser, with a flat session per
// target. No chrome.debugger and no extension of our own: Browser was started with a debugging port.

import * as z from 'zod'

const Reply = z.object({
  id: z.number().optional(),
  result: z.unknown().optional(),
  error: z.object({ message: z.string() }).optional(),
})
const TargetInfoSchema = z.object({ targetId: z.string(), type: z.string(), url: z.string(), attached: z.boolean() })

export const DEFAULT_PORT = 9230
/** How long Chrome may take to answer one request, so a wedged target can't hang a command (and hold the lock). */
const REQUEST_TIMEOUT_MS = 60_000

export type TargetInfo = z.infer<typeof TargetInfoSchema>

interface Pending {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
}

class CdpError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CdpError'
  }
}

export class Cdp {
  private nextId = 1
  private readonly pending = new Map<number, Pending>()

  private constructor(private readonly ws: WebSocket) {
    ws.addEventListener('message', (e) => {
      let msg: z.infer<typeof Reply>
      try {
        msg = Reply.parse(JSON.parse(String(e.data)))
      } catch {
        for (const pending of this.pending.values())
          pending.reject(new CdpError('Chrome sent an invalid protocol reply.'))
        this.pending.clear()
        this.ws.close()
        return
      }
      if (msg.id === undefined) return
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.error) p.reject(new CdpError(msg.error.message))
      else p.resolve(msg.result)
    })
    ws.addEventListener('close', () => {
      for (const p of this.pending.values()) p.reject(new CdpError('The connection to Chrome closed.'))
      this.pending.clear()
    })
  }

  static async connect(port = DEFAULT_PORT): Promise<Cdp> {
    let url: string
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(5_000) })
      url = z.object({ webSocketDebuggerUrl: z.url() }).parse(await res.json()).webSocketDebuggerUrl
    } catch {
      throw new CdpError(
        `Chrome for Testing is not listening for DevTools on port ${port}. Start it with ` +
          `--remote-debugging-port=${port} as the maintainer's local setup describes; this tool doesn't launch it.`,
      )
    }
    const ws = new WebSocket(url)
    await new Promise<void>((resolve, reject) => {
      const fail = () => {
        ws.close()
        reject(new CdpError(`Could not connect to ${url}`))
      }
      const timer = setTimeout(fail, 5_000)
      ws.addEventListener('open', () => (clearTimeout(timer), resolve()), { once: true })
      ws.addEventListener('error', () => (clearTimeout(timer), fail()), { once: true })
    })
    return new Cdp(ws)
  }

  send(method: string, params: object = {}, sessionId?: string): Promise<unknown> {
    const id = this.nextId++
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new CdpError(`Chrome did not answer ${method} within ${REQUEST_TIMEOUT_MS / 1000} s.`))
      }, REQUEST_TIMEOUT_MS)
      const settle =
        <V>(fn: (v: V) => void) =>
        (v: V) => {
          clearTimeout(timer)
          fn(v)
        }
      this.pending.set(id, { resolve: settle(resolve), reject: settle(reject) })
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  }

  close(): void {
    this.ws.close()
  }
}

/** One target (tab, side panel, extension page) to run code in. */
export class Target {
  constructor(
    private readonly cdp: Pick<Cdp, 'send'>,
    readonly targetId: string,
    private readonly sessionId: string,
  ) {}

  /**
   * Runs `fn(...args)` in the target and returns its (awaited) result. `fn` is sent as source, so it
   * must not use anything from outside its body; `args` go as values, never as code. `userGesture`
   * makes it count as a user's click.
   */
  async evaluate<A extends unknown[], S extends z.ZodType>(
    fn: (...args: A) => unknown,
    args: A,
    schema: S,
    options: { userGesture?: boolean; contextId?: number } = {},
  ): Promise<z.output<S>> {
    // The function runs on the context's global object, which callFunctionOn needs a handle to.
    const global = z.object({ result: z.object({ objectId: z.string().optional() }) }).parse(
      await this.send('Runtime.evaluate', {
        expression: 'globalThis',
        ...(options.contextId === undefined ? {} : { contextId: options.contextId }),
      }),
    )
    if (!global.result.objectId) throw new CdpError('Could not reach the page.')
    try {
      const res = z
        .object({
          result: z.object({ value: z.unknown().optional() }),
          exceptionDetails: z
            .object({ text: z.string(), exception: z.object({ description: z.string().optional() }).optional() })
            .optional(),
        })
        .parse(
          await this.send('Runtime.callFunctionOn', {
            // tsx may wrap a named function in this local helper.
            functionDeclaration: `function (...args) { const __name = (f) => f; return (${fn.toString()})(...args) }`,
            objectId: global.result.objectId,
            arguments: args.map((value) => ({ value })),
            awaitPromise: true,
            returnByValue: true,
            userGesture: options.userGesture ?? false,
          }),
        )
      if (res.exceptionDetails)
        throw new CdpError(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text)
      return schema.parse(res.result.value)
    } finally {
      await this.send('Runtime.releaseObject', { objectId: global.result.objectId }).catch(() => undefined)
    }
  }

  send(method: string, params: object = {}): Promise<unknown> {
    return this.cdp.send(method, params, this.sessionId)
  }
}

export class Browser {
  private readonly sessions = new Map<string, Target>()

  constructor(readonly cdp: Pick<Cdp, 'send'>) {}

  async targets(): Promise<TargetInfo[]> {
    const { targetInfos } = z
      .object({ targetInfos: z.array(TargetInfoSchema) })
      .parse(await this.cdp.send('Target.getTargets'))
    return targetInfos
  }

  /** The open target with this id, as Chrome lists it, or undefined if it has closed. */
  async find(targetId: string | undefined): Promise<TargetInfo | undefined> {
    return targetId ? (await this.targets()).find((t) => t.targetId === targetId) : undefined
  }

  /** Opens a tab; `background` keeps the current tab of its window in front. */
  async open(url: string, { background = false } = {}): Promise<string> {
    const { targetId } = z
      .object({ targetId: z.string() })
      .parse(await this.cdp.send('Target.createTarget', { url, background }))
    return targetId
  }

  async close(targetId: string): Promise<void> {
    this.sessions.delete(targetId)
    await this.cdp.send('Target.closeTarget', { targetId }).catch(() => undefined)
  }

  async activate(targetId: string): Promise<void> {
    await this.cdp.send('Target.activateTarget', { targetId })
  }

  async attach(targetId: string): Promise<Target> {
    const known = this.sessions.get(targetId)
    if (known) return known
    const { sessionId } = z.object({ sessionId: z.string() }).parse(
      await this.cdp.send('Target.attachToTarget', {
        targetId,
        flatten: true,
      }),
    )
    const target = new Target(this.cdp, targetId, sessionId)
    this.sessions.set(targetId, target)
    return target
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Calls `check` until it returns something other than undefined, or throws `onTimeout()` after `ms`. */
export async function until<T>(
  check: () => Promise<T | undefined>,
  { ms, every = 250, onTimeout }: { ms: number; every?: number; onTimeout: () => Error },
): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const value = await check().catch(() => undefined)
    if (value !== undefined) return value
    if (Date.now() > end) throw onTimeout()
    await sleep(every)
  }
}
