// The command line of `pnpm e2e`.
import * as z from 'zod'

export const WebUrl = z.url({ protocol: /^https?$/ })

export type Answer = 'allow' | 'deny'
const LockActionSchema = z.enum(['acquire', 'refresh', 'release', 'status'])
type LockAction = z.infer<typeof LockActionSchema>

export type Command =
  | { name: 'help' }
  | { name: 'reload' }
  | { name: 'panel'; url?: string }
  | { name: 'ask'; question?: string; answer?: Answer; timeoutMs: number; json: boolean }
  | { name: 'close' }
  | { name: 'lock'; action: LockAction; purpose?: string }

export interface Parsed {
  command: Command
  /** `--owner`: who takes the Browser lock. */
  owner?: string
}

export const DEFAULT_TIMEOUT_S = 300

export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UsageError'
  }
}

export const USAGE = `Usage: pnpm e2e <command> [options]

Drives the shared Chrome for Testing (CDP port 9230) for ai-e2e scenarios. See docs/bdd.md.

Commands:
  reload                       Build this checkout into the extension folder the browser loads, reload it,
                               and check it is enabled
  panel [url]                  Open the side panel on a website URL in a tab owned by this tool.
                               Without a URL, reuse that tab; starts a new chat.
  ask [question]               Send the question in the side panel, wait for the reply, and print it
                               with each tool call; without a question, keep waiting for the last reply
      --allow | --deny         Answer every approval prompt this way (otherwise stop at the first one)
      --timeout <seconds>      How long to wait for the reply (default ${DEFAULT_TIMEOUT_S})
      --json                   Print the reply as JSON
  close                        Close the website tab this tool opened (and its side panel)
  lock acquire [purpose]       Hold the browser lock across several commands
  lock refresh|release|status

Options:
  --owner <name>               Lock owner (default: $E2E_OWNER, else the git branch)

Environment:
  E2E_EXTENSION_ID            Extension ID to control (default: the local development ID)
  E2E_CDP_PORT                 Browser DevTools port (default 9230)

Exit codes: 0 done, 1 failed, 2 usage error, 3 browser busy (prints the holder),
4 a reply is waiting for approval (run "pnpm e2e ask --allow" or "--deny").`

const ASK_FLAGS = new Set(['--allow', '--deny', '--timeout', '--json'])

export function parseArgs(argv: string[]): Parsed {
  const positional: string[] = []
  const flags = new Map<string, string | true>()
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--') {
      positional.push(...argv.slice(i + 1))
      break
    }
    if (arg === '-h' || arg === '--help') return { command: { name: 'help' } }
    if (!arg.startsWith('--')) {
      positional.push(arg)
      continue
    }
    const eq = arg.indexOf('=')
    const name = eq < 0 ? arg : arg.slice(0, eq)
    if (flags.has(name)) throw new UsageError(`${name} is given twice.`)
    if (name === '--owner' || name === '--timeout') {
      const value = eq < 0 ? argv[++i] : arg.slice(eq + 1)
      if (value === undefined || value === '') throw new UsageError(`${name} needs a value.`)
      flags.set(name, value)
    } else if (name === '--allow' || name === '--deny' || name === '--json') {
      if (eq >= 0) throw new UsageError(`${name} takes no value.`)
      flags.set(name, true)
    } else {
      throw new UsageError(`Unknown option ${name}.`)
    }
  }

  const ownerFlag = flags.get('--owner')
  const owner = typeof ownerFlag === 'string' ? ownerFlag : undefined
  flags.delete('--owner')
  const [name, ...rest] = positional
  if (!name) return { command: { name: 'help' }, owner }
  if (name !== 'ask') {
    const misplaced = [...flags.keys()].find((f) => ASK_FLAGS.has(f))
    if (misplaced) throw new UsageError(`${misplaced} only goes with ask.`)
  }
  const most = (n: number) => {
    if (rest.length > n) throw new UsageError(`Too many arguments for ${name}: ${rest.slice(n).join(' ')}`)
  }

  switch (name) {
    case 'help':
      return { command: { name: 'help' }, owner }
    case 'reload':
    case 'close':
      most(0)
      return { command: { name }, owner }
    case 'panel': {
      most(1)
      const [url] = rest
      if (url !== undefined && !WebUrl.safeParse(url).success) throw new UsageError(`Not an HTTP or HTTPS URL: ${url}`)
      return { command: { name, url }, owner }
    }
    case 'ask': {
      most(1)
      if (flags.has('--allow') && flags.has('--deny')) throw new UsageError('Give --allow or --deny, not both.')
      const timeout = flags.get('--timeout')
      const seconds = timeout === undefined ? DEFAULT_TIMEOUT_S : Number(timeout)
      if (!Number.isFinite(seconds) || seconds <= 0) throw new UsageError(`Not a number of seconds: ${timeout}`)
      const question = rest[0]?.trim()
      if (rest[0] !== undefined && !question) throw new UsageError('The question is empty.')
      return {
        command: {
          name,
          question,
          answer: flags.has('--allow') ? 'allow' : flags.has('--deny') ? 'deny' : undefined,
          timeoutMs: seconds * 1000,
          json: flags.has('--json'),
        },
        owner,
      }
    }
    case 'lock': {
      const [action, ...purpose] = rest
      const parsed = LockActionSchema.safeParse(action)
      if (!parsed.success) throw new UsageError('lock needs acquire, refresh, release, or status.')
      if (action !== 'acquire' && purpose.length) throw new UsageError(`Too many arguments for lock ${action}.`)
      return {
        command: { name, action: parsed.data, purpose: purpose.join(' ').trim() || undefined },
        owner,
      }
    }
    default:
      throw new UsageError(`Unknown command: ${name}`)
  }
}
