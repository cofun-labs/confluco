// The side panel's UI tests run the whole panel: the page sidepanel.html loads, with the real agent,
// tools, and session store behind it, and the real worker answering its model calls. Only the edges
// are fakes: chrome.* (with a tab), Clerk (see clerk.tsx), IndexedDB, and the model binding.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { act } from '@testing-library/react'
import { IDBFactory } from 'fake-indexeddb'
import { vi } from 'vitest'
import { createApp, type Env } from '../../worker/src/app'
import { FakeClerk } from '../../worker/test/clerk'
import { FakeAiBinding, FakeQuotaNamespace, FakeUsageDataset } from '../../worker/test/fakes'
import type { FakeSession } from './clerk'

const EXTENSION = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
/** When every test starts. Tests move the clock themselves (`vi.setSystemTime`); nothing waits for real time. */
export const START = new Date('2026-11-08T12:00:00Z')

const globals = globalThis as Record<string, unknown>
const realFetch = globalThis.fetch
export const PAGE_URL = 'https://team.atlassian.net/wiki/spaces/ENG/pages/123/Fixture+page?tracking=local'
type TestTab = { id?: number; title?: string; url?: string; meta?: string }
type Injection = { target: { tabId: number }; func: (...args: never[]) => unknown; args: unknown[] }
// jsdom lays nothing out, so it has no scrolling; the panel scrolls its messages to the newest one.
Element.prototype.scrollTo ??= () => {}
const app = createApp()
// One key pair for the whole file: making one takes longer than a test.
let clerk: Promise<FakeClerk> | undefined

/**
 * A browser with the extension installed and one tab: its chrome.* APIs, its IndexedDB, who is
 * signed in to Copilot, and the worker the panel talks to. Lives for one test.
 */
export class FakeBrowser {
  /** The model behind the worker; script its replies, and read what it was sent. */
  readonly ai = new FakeAiBinding()
  /** URLs the panel opened in new tabs. */
  readonly openedTabs: string[] = []

  readonly workspaceRequests: { url: string; init?: RequestInit }[] = []
  readonly requestedOrigins: string[] = []
  grantSiteAccess = true
  confluenceResponse: (url: string, init?: RequestInit) => Response | Promise<Response> = () =>
    new Response(null, { status: 404 })
  private readonly sites = new Set<string>()
  private readonly settings: Record<string, unknown> = {}
  private readonly tabs = new Map<number, TestTab>()
  private readonly worlds = new Map<number, Record<string, unknown>>()
  private active?: TestTab

  private constructor(private readonly session: FakeSession | undefined) {}

  selectTab(tab: TestTab) {
    this.tabs.set(tab.id ?? 1, tab)
    this.active = tab
  }

  setConnectionFromAnotherPanel(userId: string, base: string, permission: string) {
    this.settings[`confluence-instance:${userId}`] = base
    this.sites.add(permission)
  }

  revokeSiteAccess(permission: string) {
    this.sites.delete(permission)
  }

  private async executeScript({ target, func, args }: Injection) {
    const tab = this.tabs.get(target.tabId)
    if (!tab?.url) throw new Error('No such tab')
    const world = this.worlds.get(target.tabId) ?? {}
    this.worlds.set(target.tabId, world)
    Object.assign(world, {
      location: new URL(tab.url),
      document: new DOMParser().parseFromString(tab.meta ?? '', 'text/html'),
      URL,
      URLSearchParams,
      AbortSignal,
      AbortController,
      TextDecoder,
      fetch: async (url: string, init?: RequestInit) => {
        this.workspaceRequests.push({ url, init })
        return this.confluenceResponse(url, init)
      },
    })
    const result: unknown = await runInNewContext(`(${func.toString()})(...args)`, Object.assign(world, { args }))
    return [{ result }]
  }

  /** Starts a browser on `tab`, signed in to Copilot as `signedInAs` or signed out. */
  static async start(options: { signedInAs?: string; tab?: TestTab } = {}): Promise<FakeBrowser> {
    vi.useFakeTimers({ toFake: ['Date'], now: START })
    const issuer = await (clerk ??= FakeClerk.create())
    const userId = options.signedInAs
    const session = userId && { userId, getToken: () => issuer.sessionToken({ userId, azp: EXTENSION }) }
    const browser = new FakeBrowser(session || undefined)

    const env: Env = {
      AI: browser.ai,
      QUOTA: new FakeQuotaNamespace(),
      USAGE: new FakeUsageDataset(),
      DAILY_REQUEST_LIMIT: '100',
      MODEL: '@cf/test/model',
      CLERK_JWT_KEY: issuer.publicKeyPem,
      CLERK_AUTHORIZED_PARTIES: EXTENSION,
    }
    // The panel calls fetch(); route it into the worker app.
    globals.fetch = (input: RequestInfo | URL, init?: RequestInit) =>
      app.request(new Request(input, init), undefined, env)
    // A new browser profile: no saved sessions.
    globals.indexedDB = new IDBFactory()
    let lockQueue = Promise.resolve()
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: {
        request: <T>(_name: string, action: () => Promise<T>) => {
          const result = lockQueue.then(action)
          lockQueue = result.then(
            () => {},
            () => {},
          )
          return result
        },
      },
    })

    browser.selectTab(options.tab ?? { url: PAGE_URL, title: 'Fixture page' })
    globals.chrome = {
      runtime: { getURL: (path: string) => `${EXTENSION}/${path}` },
      tabs: {
        query: async () => (browser.active ? [{ id: 1, ...browser.active }] : []),
        create: async ({ url }: { url: string }) => void browser.openedTabs.push(url),
      },
      storage: {
        local: {
          get: async (key: string | null) =>
            key === null ? { ...browser.settings } : { [key]: browser.settings[key] },
          set: async (items: Record<string, unknown>) => Object.assign(browser.settings, items),
          remove: async (key: string) => {
            delete browser.settings[key]
          },
        },
      },
      permissions: {
        request: async ({ origins }: { origins: string[] }) => {
          browser.requestedOrigins.push(...origins)
          if (!browser.grantSiteAccess) return false
          origins.forEach((origin) => browser.sites.add(origin))
          return true
        },
        contains: async ({ origins }: { origins: string[] }) => origins.every((origin) => browser.sites.has(origin)),
        remove: async ({ origins }: { origins: string[] }) => origins.every((origin) => browser.sites.delete(origin)),
      },
      scripting: { executeScript: (details: Injection) => browser.executeScript(details) },
      // The sign-in cookie the panel watches for a change in session state.
      cookies: {
        getAll: async ({ name }: { name: string }) => [{ name, value: session ? '1762603200' : '0' }],
        onChanged: { addListener: () => {} },
      },
    }
    return browser
  }

  /**
   * Opens the side panel: loads sidepanel.html into the document and runs the script it names, so
   * the panel starts as it does in Chrome. Opening it again closes the one before: a new document with new modules;
   * what the browser keeps (IndexedDB, chrome.storage, the sign-in) stays.
   */
  async openPanel(): Promise<void> {
    await closePanel()
    vi.resetModules()
    const page = new DOMParser().parseFromString(
      readFileSync(fileURLToPath(import.meta.resolve('../sidepanel.html')), 'utf8'),
      'text/html',
    )
    const script = page.querySelector('script[type="module"]')!
    script.remove()
    document.body.innerHTML = page.body.innerHTML
    const { fakeClerk } = await import('./clerk')
    if (this.session) fakeClerk.signIn(this.session)
    await act(() => import(/* @vite-ignore */ script.getAttribute('src')!))
  }

  /** What the model was sent with its latest call. */
  sentToModel(): { role: string; content?: string }[] {
    return this.ai.calls.at(-1)!.inputs.messages as { role: string; content?: string }[]
  }
}

/** Closes the open panel, if there is one, as Chrome does when its page goes away. */
async function closePanel(): Promise<void> {
  await act(async () => void window.dispatchEvent(new Event('pagehide')))
  document.body.innerHTML = ''
}

/** Closes the panel and puts back what a FakeBrowser replaced. Call it after each test. */
export async function closeBrowser(): Promise<void> {
  await closePanel()
  globals.fetch = realFetch
  delete globals.chrome
  delete globals.indexedDB
  Reflect.deleteProperty(navigator, 'locks')
  vi.useRealTimers()
}
