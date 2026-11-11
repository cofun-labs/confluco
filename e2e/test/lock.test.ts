import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, stat, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BrowserLock, STALE_MS, checkOwner } from '../src/lock'

let root: string
let dir: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'e2e-lock-'))
  dir = join(root, 'browser.lock')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const at = (iso: string) => () => new Date(iso)

describe('BrowserLock', () => {
  it('takes a free lock and writes the owner line the shell script writes', async () => {
    const lock = new BrowserLock(dir, at('2026-11-10T08:11:00'))
    expect(await lock.holder()).toBeUndefined()
    expect(await lock.acquire('issue-106', 'UC-AGENT-001-S16')).toEqual({ status: 'acquired' })
    expect(await readFile(join(dir, 'owner'), 'utf8')).toBe('issue-106 | UC-AGENT-001-S16 | since 2026-11-10 08:11\n')
    expect(await lock.holder()).toBe('issue-106 | UC-AGENT-001-S16 | since 2026-11-10 08:11')
  })

  it('reports a lock held by someone else as busy, and leaves it alone', async () => {
    const other = new BrowserLock(dir)
    await other.acquire('issue-96', 'e2e')
    const lock = new BrowserLock(dir)
    expect(await lock.acquire('issue-106', 'e2e')).toEqual({
      status: 'busy',
      holder: expect.stringMatching(/^issue-96 \| e2e \| since /),
    })
    expect(await lock.release('issue-106')).toBe(false)
    expect(await lock.refresh('issue-106')).toBe(false)
    expect(await lock.holder()).toMatch(/^issue-96 \|/)
  })

  it('does not take an owner whose name is a prefix of the holder', async () => {
    await new BrowserLock(dir).acquire('issue-106-b', 'e2e')
    expect(await new BrowserLock(dir).acquire('issue-106', 'e2e')).toMatchObject({ status: 'busy' })
  })

  it('counts a lock its owner already holds as held, and refreshes it', async () => {
    const lock = new BrowserLock(dir)
    await lock.acquire('issue-106', 'several steps')
    const old = new Date(Date.now() - 10 * 60_000)
    await utimes(dir, old, old)
    expect(await lock.acquire('issue-106', 'pnpm e2e ask')).toEqual({ status: 'held' })
    expect((await stat(dir)).mtime.getTime()).toBeGreaterThan(old.getTime())
    // The first purpose stays: the lock wasn't taken again.
    expect(await lock.holder()).toMatch(/^issue-106 \| several steps \|/)
  })

  it('takes over a lock not refreshed for 30 minutes', async () => {
    await new BrowserLock(dir).acquire('issue-96', 'forgotten')
    const old = new Date(Date.now() - STALE_MS - 60_000)
    await utimes(dir, old, old)
    const r = await new BrowserLock(dir).acquire('issue-106', 'e2e')
    expect(r).toEqual({ status: 'acquired', tookOver: expect.stringMatching(/^issue-96 \| forgotten/) })
    expect(await new BrowserLock(dir).holder()).toMatch(/^issue-106 \|/)
  })

  it('lets only one of several sessions take over the same stale lock', async () => {
    await new BrowserLock(dir).acquire('issue-96', 'forgotten')
    const old = new Date(Date.now() - STALE_MS - 60_000)
    await utimes(dir, old, old)
    const owners = ['issue-1', 'issue-2', 'issue-3', 'issue-4']
    const results = await Promise.all(owners.map((o) => new BrowserLock(dir).acquire(o, 'e2e')))
    const winners = owners.filter((_, i) => results[i].status === 'acquired')
    expect(winners).toHaveLength(1)
    expect(await new BrowserLock(dir).holder()).toMatch(new RegExp(`^${winners[0]} \\|`))
    expect(results.filter((r) => r.status === 'busy')).toHaveLength(3)
  })

  it('lets only one of many sessions take over a stale lock, round after round', async () => {
    // Takeovers in the same millisecond once picked the same name to move the lock to, and failed.
    for (let round = 0; round < 20; round++) {
      await rm(dir, { recursive: true, force: true })
      await new BrowserLock(dir).acquire('issue-96', 'forgotten')
      const old = new Date(Date.now() - STALE_MS - 60_000)
      await utimes(dir, old, old)
      const owners = Array.from({ length: 12 }, (_, i) => `issue-${i + 1}`)
      const results = await Promise.all(owners.map((o) => new BrowserLock(dir).acquire(o, 'e2e')))
      expect(results.filter((r) => r.status === 'acquired')).toHaveLength(1)
    }
  })

  it('waits while another session takes over, and clears a guard left by one that died doing it', async () => {
    await new BrowserLock(dir).acquire('issue-96', 'forgotten')
    const old = new Date(Date.now() - STALE_MS - 60_000)
    await utimes(dir, old, old)
    const guard = `${dir}.takeover`
    await mkdir(guard)
    // Another session is taking over the stale lock right now.
    expect(await new BrowserLock(dir).acquire('issue-1', 'e2e')).toMatchObject({ status: 'busy' })
    // That session died two minutes ago, leaving its guard behind.
    const left = new Date(Date.now() - 2 * 60_000)
    await utimes(guard, left, left)
    expect(await new BrowserLock(dir).acquire('issue-1', 'e2e')).toEqual({
      status: 'acquired',
      tookOver: expect.stringMatching(/^issue-96 \|/),
    })
    expect(existsSync(guard)).toBe(false)
  })

  it('releases only its own lock', async () => {
    const lock = new BrowserLock(dir)
    await lock.acquire('issue-106', 'e2e')
    expect(await lock.release('issue-106')).toBe(true)
    expect(await lock.holder()).toBeUndefined()
    expect(await lock.release('issue-106')).toBe(false)
  })

  it('keeps purposes on one line, so the owner file stays parseable', async () => {
    await new BrowserLock(dir, at('2026-11-10T08:11:00')).acquire('issue-106', 'a | b\nc')
    expect(await readFile(join(dir, 'owner'), 'utf8')).toBe('issue-106 | a b c | since 2026-11-10 08:11\n')
  })

  it('reports a lock directory without an owner file as held', async () => {
    await mkdir(dir)
    expect(await new BrowserLock(dir).holder()).toBe('(unknown holder)')
  })
})

describe('checkOwner', () => {
  it('refuses owners the owner file could not tell apart', () => {
    expect(() => checkOwner('issue-106')).not.toThrow()
    for (const bad of ['', '  ', ' issue-106', 'issue-106 ', 'a | b', 'a\nb']) expect(() => checkOwner(bad)).toThrow()
  })
})
