/** Minimal key-value storage, the slice of Durable Object storage the quota uses. */
export interface QuotaStorage {
  get<T>(key: string): Promise<T | undefined>
  put<T>(key: string, value: T): Promise<void>
}

/** One user's daily request counter. */
export interface QuotaCounter {
  /** Counts one request for `day` (YYYY-MM-DD, UTC). Returns false, without counting, when `limit` is used up. */
  consume(day: string, limit: number): Promise<boolean>
}

/** Finds a user's counter. In production this is the Durable Object namespace binding. */
export interface QuotaNamespace {
  getByName(name: string): QuotaCounter
}

type Usage = { day: string; count: number }

/**
 * Counting logic for one user, kept apart from the Durable Object class so tests can run it
 * over in-memory storage. A Durable Object handles one request at a time, so get-then-put is safe.
 */
export async function consume(storage: QuotaStorage, day: string, limit: number): Promise<boolean> {
  const usage = await storage.get<Usage>('usage')
  // Worker instances' clocks can differ slightly around midnight. Never move back to an
  // earlier day, or alternating instances would reset the count again and again.
  const current = usage && usage.day > day ? usage.day : day
  const count = usage?.day === current ? usage.count : 0
  if (count >= limit) return false
  await storage.put<Usage>('usage', { day: current, count: count + 1 })
  return true
}
