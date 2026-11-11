// Defines a tool from one zod schema of its arguments: the JSON Schema the model is sent, the check
// before the tool runs, and the type its code works with all come from that schema.
import type { ToolSpec } from './agent'
import { z } from './zod'

/** A tool's arguments: an object schema, so the model is sent `type: "object"`. */
type ArgsSchema = z.ZodObject

export interface ToolDefinition<S extends ArgsSchema> extends Omit<ToolSpec, 'parameters' | 'run' | 'preview'> {
  /**
   * The arguments. Describe what the model should know with `.describe()`, and give `error` where
   * the model needs more than zod's own words to correct its call.
   */
  args: S
  /** Runs the tool with the arguments as the schema gives them. */
  run: (args: z.output<S>, signal?: AbortSignal) => Promise<unknown>
  /** What a call does, in words (see `ToolSpec.preview`), from the same arguments as `run` gets. */
  preview?: (args: z.output<S>, signal?: AbortSignal) => string | undefined | Promise<string | undefined>
}

/**
 * The tool as the agent takes it. Its `run` receives the arguments as an unknown value and parses
 * them first; arguments that don't parse are a plain error, which the model gets back and can correct.
 *
 * The agent runtime has already checked the model's arguments against `parameters` and converted
 * them where it could (see `toAgentTool` in agent.ts), so in a question this parse refuses next to
 * nothing (only what JSON Schema can't say, such as a whole number too large to be exact): it is
 * what turns the value into its type, and what a caller without the runtime gets.
 */
export function defineTool<S extends ArgsSchema>({ args, run, preview, ...rest }: ToolDefinition<S>): ToolSpec {
  return {
    ...rest,
    parameters: parametersOf(args),
    run: async (given: unknown, signal) => {
      const parsed = parseArgs(args, given)
      if (!parsed.ok) throw new Error(parsed.refusal)
      return run(parsed.args, signal)
    },
    ...(preview && {
      preview: (given: unknown, signal?: AbortSignal) => {
        // Arguments that don't parse have no preview: the run refuses them, and says why.
        const parsed = parseArgs(args, given)
        return parsed.ok ? preview(parsed.args, signal) : undefined
      },
    }),
  }
}

/** The JSON Schema of the arguments, as the model is sent it. */
function parametersOf(args: ArgsSchema): object {
  const { $schema: _, ...parameters } = z.toJSONSchema(args, {
    io: 'input',
    // What zod adds that tells the model nothing: an integer's bounds at what a JavaScript number
    // holds exactly, and that the keys of an object of values by name are text.
    override: ({ jsonSchema }) => {
      if (jsonSchema.maximum === Number.MAX_SAFE_INTEGER) delete jsonSchema.maximum
      if (jsonSchema.minimum === Number.MIN_SAFE_INTEGER) delete jsonSchema.minimum
      const names = jsonSchema.propertyNames
      if (typeof names === 'object' && Object.keys(names).length === 1 && names.type === 'string')
        delete jsonSchema.propertyNames
    },
  })
  return parameters
}

/** The arguments as the schema gives them, or what is wrong with each one, for the model. */
function parseArgs<S extends ArgsSchema>(
  args: S,
  given: unknown,
): { ok: true; args: z.output<S> } | { ok: false; refusal: string } {
  // zod leaves a key named `__proto__` out of an object of values by name without a word; a call
  // must not go ahead with part of what it asked for dropped.
  const dropped = protoKey(given)
  if (dropped) return { ok: false, refusal: `\`${argumentPath(dropped)}\`: "__proto__" can't be used as a name.` }
  const result = args.safeParse(given, {
    // For what a schema gives no `error` of its own: zod's words, with the argument they are about.
    error: (issue) => {
      // zod's own message, in English; `z.locales` would bundle every language.
      const said = z.config().localeError?.(issue)
      const text = typeof said === 'string' ? said : (said?.message ?? 'Invalid input')
      return issue.path?.length ? `\`${argumentPath(issue.path)}\`: ${text}` : text
    },
  })
  if (result.success) return { ok: true, args: result.data }
  return { ok: false, refusal: result.error.issues.map((issue) => issue.message).join('\n') }
}

/** The path of the first key named `__proto__` anywhere in a value, if it has one. */
function protoKey(value: unknown, path: PropertyKey[] = []): PropertyKey[] | undefined {
  if (!value || typeof value !== 'object') return undefined
  if (Array.isArray(value)) {
    for (const [n, item] of value.entries()) {
      const found = protoKey(item, [...path, n])
      if (found) return found
    }
    return undefined
  }
  if (Object.hasOwn(value, '__proto__')) return [...path, '__proto__']
  for (const [key, item] of Object.entries(value)) {
    const found = protoKey(item, [...path, key])
    if (found) return found
  }
  return undefined
}

/** Where in the arguments an issue is, as the model would write it: `filter[0].property`. */
function argumentPath(path: PropertyKey[]): string {
  return path.map((key, n) => (typeof key === 'number' ? `[${key}]` : `${n ? '.' : ''}${String(key)}`)).join('')
}
