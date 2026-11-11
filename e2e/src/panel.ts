// The Confluence tab this tool opens, the side panel next to it, and asking questions there.
import * as z from 'zod'
import { confluenceUrl } from '../../extension/src/confluence/tab'
import type { Answer } from './args'
import { type Browser, type Target, sleep, until } from './cdp'
import { E2eError } from './errors'
import { EXTENSION_ID } from './extension'
import { type PanelSnapshot, type ReplyPart, nextStep, readPanel, PanelSnapshotSchema } from './reply'
import type { State } from './state'

const PANEL_URL = `chrome-extension://${EXTENSION_ID}/sidepanel.html`
/** The Confluence tab this tool opened, if it is still open. */
export async function ownPageTab(browser: Browser, state: State): Promise<string | undefined> {
  // Chrome's own id for the tab, not the remembered one: only a tab that is still open is used.
  return (await browser.find(state.pageTarget))?.targetId
}

/** Opens or navigates the tool's Confluence tab, or reuses it without a URL. */
export async function pageTab(browser: Browser, state: State, url: string | undefined): Promise<Target> {
  let id = await ownPageTab(browser, state)
  if (url && !confluenceUrl(url)) throw new E2eError(`Not a Confluence URL: ${url}.`)
  if (!id) {
    if (!url) throw new E2eError('No Confluence tab opened by pnpm e2e yet: pass a Confluence page URL.')
    // The initial document can look loaded before navigation starts. Attach first and navigate explicitly.
    id = await browser.open('about:blank')
    state.pageTarget = id
    state.panelTarget = undefined
  }
  const tab = await browser.attach(id)
  if (url) {
    // A marker identifies the old document while the new one loads.
    await tab.evaluate(() => document.documentElement.setAttribute('data-confluco-e2e-old', 'true'), [], z.undefined())
    const { loaderId, errorText } = z
      .object({ loaderId: z.string().optional(), errorText: z.string().optional() })
      .parse(await tab.send('Page.navigate', { url }))
    if (errorText) throw new E2eError(`Could not open the Confluence page: ${errorText}`)
    // Same-document navigation, such as an anchor change, does not give a new loader ID.
    if (!loaderId)
      await tab.evaluate(() => document.documentElement.removeAttribute('data-confluco-e2e-old'), [], z.undefined())
  }
  // A parsed document is enough: Confluence's app can keep a resource loading, so `complete` may never come.
  const loaded = await until(
    () =>
      tab.evaluate(
        () =>
          document.readyState !== 'loading' && !document.documentElement.hasAttribute('data-confluco-e2e-old')
            ? { url: location.href }
            : undefined,
        [],
        z.object({ url: z.string() }).optional(),
      ),
    { ms: 30_000, onTimeout: () => new E2eError('The Confluence tab did not finish loading.') },
  )
  if (!loaded || !confluenceUrl(loaded.url)) throw new E2eError('The Confluence tab is not on Confluence any more.')
  return tab
}

/** Opens the side panel for the tool's Confluence tab, starts a new chat, and returns the panel. */
export async function openPanel(browser: Browser, state: State, wiki: Target): Promise<Target> {
  // The panel works on the active tab of its window.
  await browser.activate(wiki.targetId)

  // chrome.sidePanel.open needs a user gesture in an extension page: open one of ours in a helper
  // tab, call it there as a click, and close the tab.
  const helperId = await browser.open(PANEL_URL, { background: true })
  let tabId: number
  try {
    const helper = await browser.attach(helperId)
    await until(
      () =>
        helper.evaluate(
          () => (typeof chrome?.tabs?.query === 'function' ? true : undefined),
          [],
          z.boolean().optional(),
        ),
      {
        ms: 10_000,
        onTimeout: () =>
          new E2eError('The extension page did not load. Is the extension enabled? Run pnpm e2e reload to check.'),
      },
    )
    // Other tabs may show the same page, so mark ours by a title of its own for a moment and find
    // it by that.
    const marker = `confluco-e2e-${crypto.randomUUID()}`
    const title = await wiki.evaluate(
      (m: string) => {
        const before = document.title
        document.title = m
        return before
      },
      [marker],
      z.string(),
    )
    let tabs: number[]
    try {
      tabs = await until(
        () =>
          helper.evaluate(
            (m: string) =>
              chrome.tabs.query({ title: m }).then((found) => (found.length ? found.map((t) => t.id!) : undefined)),
            [marker],
            z.array(z.number()).optional(),
          ),
        { ms: 5_000, onTimeout: () => new E2eError('Could not find the Confluence tab among the browser’s tabs.') },
      )
    } finally {
      await wiki.evaluate(
        (m: string, t: string) => {
          if (document.title === m) document.title = t
        },
        [marker, title],
        z.undefined(),
      )
    }
    if (tabs.length !== 1) throw new E2eError('Several tabs carry the marker of the Confluence tab.')
    tabId = tabs[0]
    await helper.evaluate((id: number) => chrome.sidePanel.open({ tabId: id }), [tabId], z.undefined(), {
      userGesture: true,
    })
  } finally {
    await browser.close(helperId)
  }

  // The panel is the shown extension page whose window's active tab is ours (a hidden one may be
  // another tab's).
  const panel = await until(
    async () => {
      for (const t of await browser.targets()) {
        if (!t.url.startsWith(PANEL_URL) || t.targetId === helperId) continue
        const page = await browser.attach(t.targetId)
        const active = await page.evaluate(
          () =>
            document.visibilityState === 'visible'
              ? chrome.tabs.query({ active: true, currentWindow: true }).then(([t]) => t?.id)
              : undefined,
          [],
          z.number().optional(),
        )
        if (active === tabId) return page
      }
      return undefined
    },
    { ms: 10_000, onTimeout: () => new E2eError('The side panel did not open.') },
  )
  state.panelTarget = panel.targetId

  const snap = await until(
    async () => {
      const s = await panel.evaluate(readPanel, [], PanelSnapshotSchema)
      if (s.ready) return s
      const signIn = await panel.evaluate(
        () => [...document.querySelectorAll('button')].some((b) => /sign in/i.test(b.textContent ?? '')),
        [],
        z.boolean(),
      )
      return signIn ? s : undefined
    },
    { ms: 20_000, onTimeout: () => new E2eError('The side panel did not finish loading.') },
  )
  if (!snap.ready) throw new E2eError('Confluco is signed out in the side panel. Sign in by hand, then try again.')
  if (snap.busy) throw new E2eError('A reply is still running in the side panel; wait for it with pnpm e2e ask.')
  if (snap.replies > 0) await clickButton(panel, '.toolbar button', 'New chat')
  return panel
}

/** The side panel `panel` opened, if it is still open. */
export async function ownPanel(browser: Browser, state: State): Promise<Target> {
  const panel = await browser.find(state.panelTarget)
  if (!panel) throw new E2eError('No side panel opened by pnpm e2e is open: run pnpm e2e panel first.')
  return browser.attach(panel.targetId)
}

export interface AskResult {
  status: 'done' | 'needs_answer'
  parts: ReplyPart[]
}

/**
 * Sends `question` (or, without one, keeps watching the last reply) and waits until the reply is
 * done or asks for an approval nobody said how to answer.
 */
export async function ask(
  panel: Target,
  question: string | undefined,
  answer: Answer | undefined,
  timeoutMs: number,
): Promise<AskResult> {
  let snap = await panel.evaluate(readPanel, [], PanelSnapshotSchema)
  if (!snap.ready) throw new E2eError('Confluco is signed out in the side panel. Sign in by hand, then try again.')
  let expected = snap.replies
  if (question !== undefined) {
    if (snap.busy) {
      throw new E2eError('A reply is still running; run pnpm e2e ask without a question to wait for it.')
    }
    await panel.evaluate(
      (text: string) => {
        const box = document.querySelector<HTMLTextAreaElement>('#composer textarea')!
        // React tracks the value itself; set it the way typing does, so onChange sees it.
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, text)
        box.dispatchEvent(new Event('input', { bubbles: true }))
      },
      [question],
      z.undefined(),
    )
    await sleep(100)
    await clickButton(panel, '#composer button[type=submit]', 'Send')
    expected++
  } else if (expected === 0) throw new E2eError('Nothing has been asked in the side panel yet.')

  const started = Date.now()
  for (;;) {
    snap = await panel.evaluate(readPanel, [], PanelSnapshotSchema)
    const step = nextStep(snap, expected, answer)
    if (step === 'done' || step === 'needs_answer') return { status: step, parts: snap.parts }
    if (step === 'unanswerable') {
      throw new E2eError('A tool call waits for approval, but the side panel shows no Allow or Deny for it.')
    }
    if (typeof step === 'object') {
      await clickButton(panel, '#messages .msg.assistant:last-child .tool-confirm button', label(step.click))
    } else if (snap.replies < expected && Date.now() - started > 5_000) {
      throw new E2eError('The question was not sent.')
    }
    if (Date.now() - started > timeoutMs) {
      throw new TimeoutError(snap)
    }
    await sleep(500)
  }
}

export class TimeoutError extends E2eError {
  constructor(readonly snapshot: PanelSnapshot) {
    super('Timed out waiting for the reply; run pnpm e2e ask without a question to keep waiting.')
  }
}

function label(answer: Answer): string {
  return answer === 'allow' ? 'Allow' : 'Deny'
}

async function clickButton(page: Target, selector: string, text: string): Promise<void> {
  const clicked = await page.evaluate(
    (sel: string, t: string) => {
      const button = [...document.querySelectorAll<HTMLButtonElement>(sel)].find((b) => b.textContent?.trim() === t)
      button?.click()
      return !!button
    },
    [selector, text],
    z.boolean(),
  )
  if (!clicked) throw new E2eError(`No "${text}" button in the side panel.`)
}
