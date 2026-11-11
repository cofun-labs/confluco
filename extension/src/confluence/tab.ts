const CLOUD_HOST = /\.atlassian\.net$/
const CLOUD_WIKI = /^\/wiki(?:\/|$)/
const CLOUD_PAGE = /^\/wiki\/spaces\/[^/]+\/pages\/\d+(?=\/|$)/
const CONFLUENCE_HOST = /(?:^|[.-])confluence(?:[.-]|$)/i
const CONFLUENCE_PATH = /\/confluence(?:\/|$)/i

/** A page link for the model and session labels, derived only from browser tab metadata. */
export function confluencePageUrl(url: URL): string | undefined {
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return
  const { origin, hostname, pathname } = url
  if (CLOUD_HOST.test(hostname)) {
    if (url.protocol === 'https:' && CLOUD_WIKI.test(pathname)) {
      return origin + (pathname.match(CLOUD_PAGE)?.[0] ?? pathname)
    }
    return
  }
  if (!CONFLUENCE_HOST.test(hostname) && !CONFLUENCE_PATH.test(pathname)) return

  // Self-hosted viewpage links use this numeric parameter to identify the page.
  const [pageId, duplicate] = url.searchParams.getAll('pageId')
  const pageQuery =
    pathname.endsWith('/pages/viewpage.action') && pageId && duplicate === undefined && /^\d+$/.test(pageId)
      ? `?pageId=${pageId}`
      : ''
  return origin + pathname + pageQuery
}

export async function currentConfluencePage(): Promise<{ title: string; url: string } | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.url) return
  try {
    const url = confluencePageUrl(new URL(tab.url))
    if (url) return { title: tab.title?.trim() || 'Untitled page', url }
  } catch {
    return undefined
  }
}

/** Read again for each question, so switching tabs updates the model's context. */
export async function openPageNote(): Promise<string> {
  const page = await currentConfluencePage()
  if (!page) return '[No supported Confluence page is open in the current tab.]'
  // The page author controls the title. Keep it inside this one metadata note.
  const title = Array.from(page.title.replace(/[[\]]/g, '')).slice(0, 200).join('')
  const url = page.url.replaceAll('[', '%5B').replaceAll(']', '%5D')
  return `[The Confluence page open in the current tab: ${JSON.stringify(title)}, ${url}]`
}
