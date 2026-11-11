// The lock on the dedicated shared Chrome for Testing profile: `mkdir` is the lock, an `owner`
// file inside says who holds it ("<owner> | <purpose> | since <time>"), and a lock not refreshed for
// 30 minutes counts as abandoned.
import { mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const LOCK_DIR = join(homedir(), '.cache', 'confluco', 'browser.lock')
export const STALE_MS = 30 * 60_000

/** How old a takeover guard must be to count as left behind by a session that died taking over. */
const GUARD_STALE_MS = 60_000

export type Acquired =
  /** Taken now; `tookOver` names the holder of the stale lock it replaced. */
  | { status: 'acquired'; tookOver?: string }
  /** Already held by this owner, for example across several steps. */
  | { status: 'held' }
  | { status: 'busy'; holder: string }

export class BrowserLock {
  constructor(
    readonly dir = LOCK_DIR,
    private readonly now = () => new Date(),
  ) {}

  /** Who holds the lock ("<owner> | <purpose> | since <time>"), or undefined when it is free. */
  async holder(): Promise<string | undefined> {
    if (!(await this.exists())) return undefined
    const text = await readFile(join(this.dir, 'owner'), 'utf8').catch(() => '')
    return text.trim() || '(unknown holder)'
  }

  async acquire(owner: string, purpose: string): Promise<Acquired> {
    checkOwner(owner)
    let tookOver: string | undefined
    const modified = await stat(this.dir).then(
      (s) => s.mtime.getTime(),
      () => undefined,
    )
    if (modified !== undefined) {
      if (await this.isOwner(owner)) {
        await this.touch()
        return { status: 'held' }
      }
      if (this.isStale(modified)) {
        tookOver = await this.takeOver()
      }
    }
    await mkdir(join(this.dir, '..'), { recursive: true })
    try {
      await mkdir(this.dir)
    } catch (err) {
      if (!(err instanceof Error && 'code' in err && err.code === 'EEXIST')) throw err
      return { status: 'busy', holder: (await this.holder()) ?? '(unknown holder)' }
    }
    await writeFile(join(this.dir, 'owner'), `${owner} | ${oneLine(purpose)} | since ${stamp(this.now())}\n`)
    return { status: 'acquired', tookOver }
  }

  /**
   * Removes a stale lock and returns its holder; undefined when another session got there first.
   * Only one session takes over at a time, behind a guard directory, and checks again behind it
   * that the lock is still the stale one: without that, a session that saw it stale could remove
   * the fresh lock another session had just taken, and both would hold it.
   */
  private async takeOver(again = true): Promise<string | undefined> {
    const guard = `${this.dir}.takeover`
    try {
      await mkdir(guard)
    } catch (err) {
      if (!(err instanceof Error && 'code' in err && err.code === 'EEXIST')) throw err
      // A guard left by a session that died while taking over is cleared, and the takeover tried once more.
      const since = await stat(guard).then(
        (s) => s.mtime.getTime(),
        () => undefined,
      )
      if (!again || since === undefined || this.now().getTime() - since <= GUARD_STALE_MS) return undefined
      await rm(guard, { recursive: true, force: true })
      return this.takeOver(false)
    }
    try {
      const modified = await stat(this.dir).then(
        (s) => s.mtime.getTime(),
        () => undefined,
      )
      if (modified === undefined || !this.isStale(modified)) return undefined
      const holder = (await readFile(join(this.dir, 'owner'), 'utf8').catch(() => '')).trim() || '(unknown holder)'
      await rm(this.dir, { recursive: true, force: true })
      return holder
    } finally {
      await rm(guard, { recursive: true, force: true })
    }
  }

  private isStale(modified: number): boolean {
    return this.now().getTime() - modified > STALE_MS
  }

  /** Marks the lock as still in use; false if this owner doesn't hold it. */
  async refresh(owner: string): Promise<boolean> {
    if (!(await this.isOwner(owner))) return false
    await this.touch()
    return true
  }

  /** Frees the lock; false if this owner doesn't hold it. */
  async release(owner: string): Promise<boolean> {
    if (!(await this.isOwner(owner))) return false
    await rm(this.dir, { recursive: true, force: true })
    return true
  }

  async isOwner(owner: string): Promise<boolean> {
    return (await this.holder())?.startsWith(`${owner} |`) ?? false
  }

  private async exists(): Promise<boolean> {
    return stat(this.dir).then(
      (s) => s.isDirectory(),
      () => false,
    )
  }

  private async touch(): Promise<void> {
    const now = this.now()
    await utimes(this.dir, now, now)
  }
}

/** Owners are matched as the text before the first " |", in the owner file. */
export function checkOwner(owner: string): void {
  if (!owner || owner.trim() !== owner || /[|\n\r]/.test(owner))
    throw new Error(`Not a usable lock owner: ${JSON.stringify(owner)}`)
}

function oneLine(text: string): string {
  return text.replace(/\s*[\r\n|][\s\r\n|]*/g, ' ').trim()
}

/** Local time as the shell script writes it: 2026-11-10 08:11. */
function stamp(d: Date): string {
  const two = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`
}
