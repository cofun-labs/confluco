const CLOUD_HOST = /\.atlassian\.net$/
const CLOUD_WIKI = /^\/wiki(?:\/|$)/
const CLOUD_PAGE = /^\/wiki\/spaces\/[^/]+\/pages\/\d+(?=\/|$)/
const CONFLUENCE_HOST = /(?:^|[.-])confluence(?:[.-]|$)/i
const CONFLUENCE_PATH = /\/confluence(?:\/|$)/i

const cleanPath = (path: string) => path.replace(/;[^/]*|%3bjsessionid(?:=|%3d)[^/]*/gi, '')

/** A page link for the model and session labels, derived only from browser tab metadata. */
export function confluencePageUrl(url: URL, connected = false): string | undefined {
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return
  const { origin, hostname } = url
  // Java servlet URLs can carry session IDs in the path.
  const pathname = cleanPath(url.pathname)
  if (CLOUD_HOST.test(hostname)) {
    if (url.protocol === 'https:' && CLOUD_WIKI.test(pathname)) {
      return origin + (pathname.match(CLOUD_PAGE)?.[0] ?? pathname)
    }
    return
  }
  if (!connected && !CONFLUENCE_HOST.test(hostname) && !CONFLUENCE_PATH.test(pathname)) return

  // Self-hosted viewpage links use this numeric parameter to identify the page.
  if (!pathname.endsWith('/pages/viewpage.action')) return origin + pathname
  const [pageId, duplicate] = url.searchParams.getAll('pageId')
  if (pageId && duplicate === undefined && /^\d+$/.test(pageId)) return `${origin}${pathname}?pageId=${pageId}`
}

export async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  return tab
}

export function tabPage(
  tab: chrome.tabs.Tab | undefined,
  connected = false,
): { title: string; url: string } | undefined {
  if (!tab?.url) return
  try {
    const link = confluencePageUrl(new URL(tab.url), connected)
    if (link) return { title: tab.title?.trim() || 'Untitled page', url: link }
  } catch {
    return undefined
  }
}

/** Read again for each question, so switching tabs updates the model's context. */
export function openPageNote(page: ReturnType<typeof tabPage>): string {
  if (!page) return '[No supported Confluence page is open in the current tab.]'
  // The page author controls the title. Keep it inside this one metadata note.
  const title = Array.from(page.title.replace(/[[\]]/g, '')).slice(0, 200).join('')
  const url = page.url.replaceAll('[', '%5B').replaceAll(']', '%5D')
  return `[The Confluence page open in the current tab: ${JSON.stringify(title)}, ${url}]`
}
