// Saved sessions, kept on this device in IndexedDB. Relevant messages are sent again when a saved conversation is continued.
import type { HistoryMessage } from './agent'

/** What the session list shows; the conversation itself is loaded only when a session opens. */
export interface SessionInfo {
  id: string
  /** The session's first question, for now. */
  title: string
  /** The Confluence page open when the session started, if there was one. */
  page?: { title: string; url: string }
  createdAt: number
  updatedAt: number
}

export interface Session extends SessionInfo {
  messages: HistoryMessage[]
}

// One database per account, so another account signed in on this browser never sees these sessions.
const DB_PREFIX = 'confluco-sessions-'
// Two stores, so the list never loads conversations: they grow with every tool result.
const INFO = 'sessions'
const MESSAGES = 'messages'
const TITLE_LENGTH = 100

/** The saved sessions of one signed-in user. */
export class SessionStore {
  private db?: Promise<IDBDatabase>

  constructor(private readonly userId: string) {}

  /**
   * Saves a session and resolves with its details as stored. `loaded` is the `updatedAt` the caller
   * loaded or last saved the session with; leave it out for a session that was never saved.
   *
   * Another panel may have saved the session since. Its conversation is then not overwritten:
   * this one is saved as a new session, under the new id in the result. The check and the write
   * are one transaction, so of two panels saving at once only one keeps the id.
   */
  async save({ messages, ...info }: Session, loaded?: number): Promise<SessionInfo> {
    let saved = info
    let failure: unknown
    try {
      await this.run('readwrite', (infos, all) => {
        const stored = infos.get(info.id) as IDBRequest<SessionInfo | undefined>
        stored.onsuccess = () => {
          try {
            // A session that is gone (deleted elsewhere) has nothing to overwrite.
            if (stored.result && stored.result.updatedAt !== loaded) saved = { ...info, id: crypto.randomUUID() }
            infos.put(saved)
            all.put({ id: saved.id, messages })
          } catch (err) {
            // A write that throws (e.g. data that can't be cloned) must not leave the other one committed.
            failure = err
            infos.transaction.abort()
          }
        }
        return () => undefined
      })
    } catch (err) {
      throw failure ?? err
    }
    return saved
  }

  async get(id: string): Promise<Session | undefined> {
    return this.run('readonly', (infos, all) => {
      const info = infos.get(id) as IDBRequest<SessionInfo | undefined>
      const stored = all.get(id) as IDBRequest<{ messages: HistoryMessage[] } | undefined>
      return () => info.result && { ...info.result, messages: stored.result?.messages ?? [] }
    })
  }

  async delete(id: string): Promise<void> {
    await this.run('readwrite', (infos, all) => {
      infos.delete(id)
      all.delete(id)
      return () => undefined
    })
  }

  /** All saved sessions, most recently used first. */
  async list(): Promise<SessionInfo[]> {
    const all = await this.run('readonly', (infos) => {
      const req = infos.getAll() as IDBRequest<SessionInfo[]>
      return () => req.result
    })
    return all.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  private open(): Promise<IDBDatabase> {
    this.db ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_PREFIX + this.userId, 1)
      req.onupgradeneeded = () => {
        req.result.createObjectStore(INFO, { keyPath: 'id' })
        req.result.createObjectStore(MESSAGES, { keyPath: 'id' })
      }
      req.onsuccess = () => {
        const db = req.result
        // Let a newer schema (another panel, or a later version) upgrade the database; reopen on next use.
        db.onversionchange = () => {
          db.close()
          this.db = undefined
        }
        // Closed by the browser (e.g. site data cleared): reopen on next use instead of failing.
        db.onclose = () => {
          this.db = undefined
        }
        resolve(db)
      }
      req.onerror = () => reject(req.error)
    }).catch((err) => {
      // Let the next call try again instead of failing forever.
      this.db = undefined
      throw err
    })
    return this.db
  }

  /** Runs one transaction over both stores; resolves with `fn`'s result once it has committed. */
  private async run<T>(
    mode: IDBTransactionMode,
    fn: (info: IDBObjectStore, messages: IDBObjectStore) => () => T,
  ): Promise<T> {
    const tx = (await this.open()).transaction([INFO, MESSAGES], mode)
    let result: () => T
    try {
      result = fn(tx.objectStore(INFO), tx.objectStore(MESSAGES))
    } catch (err) {
      // A write that throws (e.g. data that can't be cloned) must not leave the other one committed.
      tx.abort()
      throw err
    }
    return new Promise<T>((resolve, reject) => {
      tx.oncomplete = () => resolve(result())
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
  }
}

/** A session's title: its first question, on one line and cut to a readable length. */
export function titleFor(messages: HistoryMessage[]): string {
  const first = messages.find((m) => m.role === 'user')
  // By characters, not UTF-16 units, so an emoji is never cut in half.
  const chars = Array.from((first?.text ?? '').replace(/\s+/g, ' ').trim())
  return chars.length > TITLE_LENGTH ? `${chars.slice(0, TITLE_LENGTH - 1).join('')}…` : chars.join('')
}

/** The canonical site and page URL saved when the session started. */
export function pageKey(url: string): string {
  try {
    const u = new URL(url)
    return `${u.origin}${u.pathname}`
  } catch {
    return url
  }
}

/** The pages sessions started on, once each, with the newest title seen for each. */
export function sessionPages(sessions: SessionInfo[]): { key: string; title: string }[] {
  const pages = new Map<string, string>()
  for (const s of sessions) if (s.page && !pages.has(pageKey(s.page.url))) pages.set(pageKey(s.page.url), s.page.title)
  return [...pages].map(([key, title]) => ({ key, title }))
}

/** Sessions whose title contains `query` (ignoring case) and, if `page` is set, that started on that page. */
export function filterSessions<T extends SessionInfo>(sessions: T[], filter: { query?: string; page?: string }): T[] {
  const query = filter.query?.trim().toLowerCase()
  return sessions.filter(
    (s) =>
      (!query || s.title.toLowerCase().includes(query)) &&
      (!filter.page || (s.page !== undefined && pageKey(s.page.url) === filter.page)),
  )
}
