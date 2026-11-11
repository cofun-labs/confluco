// Tab metadata supports panel routing, local session labels, and per-question context.
export function confluenceUrl(value?: string): URL | undefined {
  if (!value) return
  try {
    const url = new URL(value)
    if (
      url.protocol === 'https:' &&
      url.hostname.endsWith('.atlassian.net') &&
      (url.pathname === '/wiki' || url.pathname.startsWith('/wiki/'))
    ) {
      return url
    }
  } catch {
    return undefined
  }
}

export async function currentConfluencePage(): Promise<{ title: string; url: string } | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  const url = confluenceUrl(tab?.url)
  const page = url?.pathname.match(/^\/wiki\/spaces\/[^/]+\/pages\/(\d+)(?:\/|$)/)
  if (!url || !page) return
  return { title: tab?.title?.trim() || 'Untitled page', url: `${url.origin}${page[0].replace(/\/$/, '')}` }
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
