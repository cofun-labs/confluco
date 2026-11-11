import { z } from '../zod'
import { matchesInstance, type Instance } from './instance'

export interface PageTarget {
  tabId: number
  url: string
  instance: Instance
}

export function pageTarget(tab: chrome.tabs.Tab | undefined, instance: Instance | undefined): PageTarget | undefined {
  if (!instance || tab?.id === undefined || !tab.url) return
  try {
    const url = new URL(tab.url)
    if (!matchesInstance(url, instance)) return
    url.hash = ''
    return { tabId: tab.id, url: url.href, instance }
  } catch {
    return undefined
  }
}

const result = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ok'), pageId: z.string().regex(/^\d+$/), data: z.unknown() }),
  z.object({
    kind: z.enum(['changed', 'not-page', 'auth', 'forbidden', 'missing', 'limited', 'large', 'network', 'invalid']),
  }),
])

const page = z.object({
  id: z.string(),
  type: z.literal('page'),
  status: z.literal('current'),
  title: z.string().trim().min(1).max(1000),
  body: z.object({ view: z.object({ value: z.string() }) }),
})

const errors = {
  changed: 'The Confluence tab changed. Open the intended page and ask again.',
  'not-page': 'Open a published Confluence page before asking Confluco to read it.',
  auth: 'Sign in to Confluence in the page tab, then ask again.',
  forbidden: 'Your Confluence account does not have permission to read this page.',
  missing: 'The Confluence page is missing or is not visible to your account.',
  limited: 'Confluence rate-limited this request. Wait before asking again.',
  large: 'The Confluence response was too large to read.',
  network: 'Could not read the page from Confluence. Check the site and try again.',
  invalid: 'Confluence did not return the expected published page.',
} satisfies Record<Exclude<z.infer<typeof result>['kind'], 'ok'>, string>

function refuse(message: string): never {
  throw Object.assign(new Error(message), { stopsQuestion: message })
}

export async function readPage(target: PageTarget | undefined, signal?: AbortSignal) {
  if (!target) refuse('Connect a self-managed Confluence instance and open a page on it first.')
  signal?.throwIfAborted()
  if (!(await chrome.permissions.contains({ origins: [target.instance.permission] }))) {
    refuse('Confluco needs Chrome site access. Reconnect this Confluence instance and try again.')
  }
  signal?.throwIfAborted()

  const requestId = crypto.randomUUID()
  const injection = {
    target: { tabId: target.tabId },
    world: 'ISOLATED' as const,
  }
  let onAbort: (() => void) | undefined
  const stopped = new Promise<never>((_, reject) => {
    onAbort = () => {
      reject(signal?.reason)
      void chrome.scripting.executeScript({ ...injection, func: abortRead, args: [requestId] }).catch(() => {})
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })

  let raw: unknown
  try {
    const [frame] = await Promise.race([
      chrome.scripting.executeScript({
        ...injection,
        func: requestPage,
        args: [target.url, target.instance.path, requestId],
      }),
      stopped,
    ])
    raw = frame?.result
  } catch {
    signal?.throwIfAborted()
    refuse('Could not access the Confluence tab. Check its site permission and try again.')
  } finally {
    if (onAbort) signal?.removeEventListener('abort', onAbort)
  }
  signal?.throwIfAborted()

  const response = result.safeParse(raw)
  if (!response.success) refuse(errors.invalid)
  if (response.data.kind !== 'ok') refuse(errors[response.data.kind])
  const parsed = page.safeParse(response.data.data)
  if (!parsed.success || parsed.data.id !== response.data.pageId) refuse(errors.invalid)
  const text = readableText(parsed.data.body.view.value)
  const limit = 12_000
  return {
    title: parsed.data.title,
    url: `${target.instance.origin}${target.instance.path}/pages/viewpage.action?pageId=${parsed.data.id}`,
    text: text.slice(0, limit),
    truncated: text.length > limit,
  }
}

function readableText(html: string): string {
  // Template contents are inert, including images and embedded frames.
  const template = document.createElement('template')
  template.innerHTML = html
  for (const node of template.content.querySelectorAll('script, style, template, iframe, object, noscript, [hidden]')) {
    node.remove()
  }
  for (const node of template.content.querySelectorAll('p, div, h1, h2, h3, h4, h5, h6, li, pre, blockquote, tr, br')) {
    node.after('\n')
  }
  for (const node of template.content.querySelectorAll('th, td')) node.after(' ')
  return (template.content.textContent ?? '')
    .replace(/[\t\f\r ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

declare global {
  // These controllers exist only in the extension's isolated world for this tab.
  var conflucoPageReads: Map<string, AbortController> | undefined
}

function abortRead(requestId: string) {
  globalThis.conflucoPageReads?.get(requestId)?.abort()
}

/** Chrome serializes this function into the top-level page. Keep its dependencies inside it. */
async function requestPage(expectedUrl: string, contextPath: string, requestId: string) {
  const actual = new URL(location.href)
  actual.hash = ''
  if (actual.href !== expectedUrl) return { kind: 'changed' }
  const path = actual.pathname.slice(contextPath.length).replace(/;[^/]*|%3bjsessionid(?:=|%3d)[^/]*/gi, '')
  const metaId = document.querySelector<HTMLMetaElement>('meta[name="ajs-page-id"]')?.content
  const type = document.querySelector<HTMLMetaElement>('meta[name="ajs-content-type"]')?.content
  if (type && type !== 'page') return { kind: 'not-page' }

  let pageId: string | undefined
  if (path === '/pages/viewpage.action') {
    const ids = actual.searchParams.getAll('pageId')
    if (ids.length === 1 && (!metaId || metaId === ids[0])) pageId = ids[0]
  } else if (/^\/display\/[^/]+\/[^/]+\/?$/.test(path)) {
    pageId = metaId
  }
  if (!pageId || !/^\d+$/.test(pageId)) return { kind: 'not-page' }

  const controller = new AbortController()
  globalThis.conflucoPageReads ??= new Map()
  globalThis.conflucoPageReads.set(requestId, controller)
  const cap = 1_000_000
  try {
    const response = await fetch(`${actual.origin}${contextPath}/rest/api/content/${pageId}?expand=body.view`, {
      method: 'GET',
      credentials: 'same-origin',
      redirect: 'manual',
      referrerPolicy: 'no-referrer',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
    })
    if (
      response.type === 'opaqueredirect' ||
      response.status === 401 ||
      (response.status >= 300 && response.status < 400)
    )
      return { kind: 'auth' }
    if (response.status === 403) return { kind: 'forbidden' }
    if (response.status === 404) return { kind: 'missing' }
    if (response.status === 429) return { kind: 'limited' }
    if (!response.ok) return { kind: 'network' }
    const contentType = response.headers.get('content-type') ?? ''
    if (/text\/html/i.test(contentType)) return { kind: 'auth' }
    if (!/^application\/json(?:;|$)/i.test(contentType)) return { kind: 'invalid' }
    if (Number(response.headers.get('content-length')) > cap || !response.body) return { kind: 'large' }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let json = ''
    let size = 0
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > cap) {
        await reader.cancel()
        return { kind: 'large' }
      }
      json += decoder.decode(part.value, { stream: true })
    }
    try {
      const data: unknown = JSON.parse(json + decoder.decode())
      return { kind: 'ok', pageId, data }
    } catch {
      return { kind: 'invalid' }
    }
  } catch {
    return { kind: 'network' }
  } finally {
    globalThis.conflucoPageReads.delete(requestId)
  }
}
