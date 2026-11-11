// Tabs owned by this CLI run, stored separately for each browser lock owner.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import * as z from 'zod'

const StateSchema = z.object({ pageTarget: z.string().optional(), panelTarget: z.string().optional() })
export type State = z.infer<typeof StateSchema>
const STATE_DIR = join(homedir(), '.cache', 'confluco', 'e2e')

export function statePath(owner: string, dir = STATE_DIR): string {
  const name = owner.replace(/[^\w.-]/gu, (c) => `%${c.codePointAt(0)!.toString(16).padStart(6, '0')}`)
  return join(dir, `${name}.json`)
}

export async function loadState(path: string): Promise<State> {
  try {
    return StateSchema.parse(JSON.parse(await readFile(path, 'utf8')))
  } catch {
    return {}
  }
}

export async function saveState(path: string, state: State): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`)
}
