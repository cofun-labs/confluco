// Loads the built extension (extension/dist-smoke) into Chromium and checks that it still works there.
// Nothing leaves the machine: Confluence, the other site, and Clerk's Frontend API are answered from
// fixtures/, and any other request fails the test. The extension's own code and its bundled
// dependencies run unchanged.
import { chromium, expect, test as base, type BrowserContext, type Request, type Worker } from '@playwright/test'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const DIST = path.resolve(import.meta.dirname, '../../extension/dist-smoke')
const FIXTURES = path.resolve(import.meta.dirname, '../fixtures')

const CONFLUENCE_URLS = [
  'https://team.atlassian.net/wiki',
  'https://another.atlassian.net/wiki/spaces/ENG/pages/123/Smoke-Test',
]
const OTHER_URL = 'https://example.com/'
const PAGE_HOSTS = [...CONFLUENCE_URLS, OTHER_URL].map((url) => new URL(url).hostname)

// What Clerk asks its Frontend API for while loading, answered as a signed-out client would be.
const CLERK_FIXTURES: Record<string, string> = {
  '/v1/environment': 'clerk-environment.json',
  '/v1/client': 'clerk-client.json',
}

/**
 * Hosts the built extension may call besides Confluence: Clerk's Frontend API and the sign-in page,
 * as its manifest lists them. Clerk's fixtures answer only there, so a request for the same
 * path on any other host is blocked like the rest.
 */
function apiHosts(): string[] {
  const manifest = JSON.parse(readFileSync(path.join(DIST, 'manifest.json'), 'utf8')) as { host_permissions: string[] }
  return manifest.host_permissions
    .map((pattern) => new URL(pattern.replace('*.', '')).hostname)
    .filter((host) => !PAGE_HOSTS.includes(host))
}

function corsHeaders(request: Request): Record<string, string> {
  return {
    'access-control-allow-origin': request.headers().origin ?? '*',
    'access-control-allow-credentials': 'true',
  }
}

interface Fixtures {
  context: BrowserContext
  /** The extension's service worker (background.ts). */
  background: Worker
  /** Requests the fixtures don't answer. They are blocked, and a test expects none. */
  blocked: string[]
  /**
   * What the service worker logged with console.error, which is how background.ts reports
   * failures. Collected by the background fixture, from as early as Playwright sees the worker.
   */
  backgroundErrors: string[]
}

const test = base.extend<Fixtures>({
  // Playwright reads a fixture's dependencies from this destructuring pattern, so it can't be `_`.
  // oxlint-disable-next-line no-empty-pattern
  blocked: async ({}, use) => {
    await use([])
  },
  context: async ({ blocked }, use) => {
    if (!existsSync(path.join(DIST, 'manifest.json'))) {
      throw new Error(`No built extension at ${DIST}. Run pnpm build:smoke first.`)
    }
    // Extensions need a persistent context, and Playwright's own Chromium: Chrome and Edge
    // no longer take --load-extension.
    const clerkHosts = apiHosts()
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
    })
    await context.route('**/*', async (route) => {
      const request = route.request()
      const url = new URL(request.url())
      if (url.protocol === 'chrome-extension:') return route.continue()
      if (PAGE_HOSTS.includes(url.hostname)) return route.fulfill({ path: path.join(FIXTURES, 'page.html') })
      const clerkFixture =
        request.method() === 'GET' && clerkHosts.includes(url.hostname) ? CLERK_FIXTURES[url.pathname] : undefined
      if (clerkFixture) {
        return route.fulfill({ path: path.join(FIXTURES, clerkFixture), headers: corsHeaders(request) })
      }
      blocked.push(`${request.method()} ${request.url()}`)
      return route.abort()
    })
    await use(context)
    await context.close()
  },
  // Playwright reads a fixture's dependencies from this destructuring pattern, so it can't be `_`.
  // oxlint-disable-next-line no-empty-pattern
  backgroundErrors: async ({}, use) => {
    await use([])
  },
  background: async ({ context, backgroundErrors }, use) => {
    const background = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'))
    // Listen from the first moment Playwright has the worker, so failures during start-up are
    // seen too. A message logged before that moment can still be missed; start-up's results are
    // also checked directly (the flag below, and the panel behavior in the first test).
    background.on('console', (message) => {
      if (message.type() === 'error') backgroundErrors.push(message.text())
    })
    // background.ts sets this flag once its start-up has run without failing. Tests wait for it
    // before opening tabs: start-up applies the tab list it read earlier, and applied late that
    // would turn the panel off again on a tab a test has just opened.
    await expect
      .poll(() => background.evaluate(() => chrome.storage.session.get('panelInit')))
      .toEqual({ panelInit: true })
    await use(background)
  },
})

/** The side panel options background.ts has set for the tab showing `url`. */
function panelOptions(background: Worker, url: string): Promise<chrome.sidePanel.PanelOptions | undefined> {
  return background.evaluate(async (tabUrl) => {
    const tabs = await chrome.tabs.query({})
    const tab = tabs.find((candidate) => candidate.url === tabUrl)
    return tab?.id === undefined ? undefined : chrome.sidePanel.getOptions({ tabId: tab.id })
  }, url)
}

test('the service worker starts and sets up the side panel', async ({ background, backgroundErrors, blocked }) => {
  // The background fixture has already waited for start-up to finish.
  expect(await background.evaluate(() => chrome.sidePanel.getPanelBehavior())).toEqual({
    openPanelOnActionClick: true,
  })
  expect(backgroundErrors).toEqual([])
  expect(blocked).toEqual([])
})

test('the side panel is enabled on Confluence tabs and on no other site', async ({
  context,
  background,
  backgroundErrors,
  blocked,
}) => {
  for (const url of CONFLUENCE_URLS) {
    const page = await context.newPage()
    await page.goto(url)
    await expect.poll(() => panelOptions(background, url), url).toMatchObject({ enabled: true, path: 'sidepanel.html' })
  }

  // A new tab on another site is off by default, so this alone would pass without background.ts
  // looking at the tab. The step after it is the one that needs the panel turned off.
  const page = await context.newPage()
  await page.goto(OTHER_URL)
  await expect.poll(() => panelOptions(background, OTHER_URL), OTHER_URL).toMatchObject({ enabled: false })

  // A Jira page on the same tenant is still outside the wiki.
  const jira = await context.newPage()
  const jiraUrl = 'https://team.atlassian.net/browse/ENG-123'
  await jira.goto(jiraUrl)
  await expect.poll(() => panelOptions(background, jiraUrl)).toMatchObject({ enabled: false })

  // Leaving Confluence in the same tab turns the panel off again.
  const confluencePage = context.pages().find((candidate) => candidate.url() === CONFLUENCE_URLS[0])!
  await confluencePage.goto(`${OTHER_URL}next`)
  await expect.poll(() => panelOptions(background, `${OTHER_URL}next`)).toMatchObject({ enabled: false })
  expect(backgroundErrors).toEqual([])
  expect(blocked).toEqual([])
})

test('the side panel page shows the signed-out state', async ({ context, background, blocked }) => {
  const errors: string[] = []
  const clerkRequests: string[] = []
  const page = await context.newPage()
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console.error: ${message.text()}`)
  })
  page.on('requestfinished', (request) => {
    const { pathname } = new URL(request.url())
    if (pathname in CLERK_FIXTURES) clerkRequests.push(pathname)
  })

  await page.goto(`chrome-extension://${new URL(background.url()).host}/sidepanel.html`)

  await expect(page.getByText('Confluco', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()
  // The button alone proves little: it also shows when Clerk fails to load. So check that Clerk
  // itself is ready, with the signed-out client from the fixture, after asking only once.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const clerk = (window as { Clerk?: { status?: string; user?: unknown; client?: { id?: string } } }).Clerk
        return { status: clerk?.status, user: clerk?.user, client: clerk?.client?.id }
      }),
    )
    .toEqual({ status: 'ready', user: null, client: 'client_smoke' })
  expect(clerkRequests.toSorted()).toEqual(Object.keys(CLERK_FIXTURES).toSorted())
  expect(errors).toEqual([])
  expect(blocked).toEqual([])
})
