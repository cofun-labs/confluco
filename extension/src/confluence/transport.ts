import { z } from '../zod'
import { matchesInstance, type Instance } from './instance'

export interface ConfluenceTab {
  tabId: number
  url: string
  instance: Instance
}

export function confluenceTab(
  tab: chrome.tabs.Tab | undefined,
  instance: Instance | undefined,
): ConfluenceTab | undefined {
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
  z.object({ kind: z.literal('ok'), pageId: z.string().regex(/^\d+$/).optional(), data: z.unknown() }),
  z.object({
    kind: z.enum([
      'changed',
      'not-page',
      'auth',
      'rejected',
      'forbidden',
      'missing',
      'unsupported',
      'conflict',
      'limited',
      'large',
      'network',
      'invalid',
    ]),
  }),
])

const errors = {
  changed: 'The Confluence tab changed. Open the intended page and ask again.',
  'not-page': 'Open a published Confluence page before asking Confluco to read it.',
  auth: 'Sign in to Confluence in the page tab, then ask again.',
  rejected: 'Confluence rejected the request. Check the search text, space key or page reference.',
  forbidden: 'Your Confluence account does not have permission for this request.',
  missing: 'The requested Confluence item is missing or is not visible to your account.',
  unsupported: 'This Confluence instance does not support the requested operation.',
  conflict: 'The Confluence page has a newer version. Check the current page before trying again.',
  limited: 'Confluence rate-limited this request. Wait before asking again.',
  large: 'The Confluence response was too large to read.',
  network: 'Could not complete the request to Confluence. Check the site and try again.',
  invalid: 'Confluence did not return the expected response.',
} satisfies Record<Exclude<z.infer<typeof result>['kind'], 'ok'>, string>

export function refuse(message: string, mayHaveChanged = false): never {
  throw Object.assign(new Error(message), { stopsQuestion: message, mayHaveChanged })
}

type Query = Record<string, string>
export type RestArea = 'api' | 'experimental'
type RestRequest = {
  area: RestArea
  resource: string
  query: Query
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  body?: string
}

export class ConfluenceRequestError extends Error {
  readonly stopsQuestion: string

  constructor(readonly kind: keyof typeof errors) {
    super(errors[kind])
    this.stopsQuestion = this.message
  }
}

export function requireTab(tab: ConfluenceTab | undefined): ConfluenceTab {
  if (!tab) refuse('Connect a self-managed Confluence instance and open a page on it first.')
  return tab
}

const selectionLimit = 4000
const editorSelectionResult = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('selection'), text: z.string().min(1).max(selectionLimit), truncated: z.boolean() }),
  z.object({ kind: z.enum(['changed', 'not-editor', 'empty']) }),
])

export async function readEditorSelection(target: ConfluenceTab | undefined) {
  const tab = requireTab(target)
  if (!(await chrome.permissions.contains({ origins: [tab.instance.permission] })))
    refuse('Confluco needs Chrome site access. Reconnect this Confluence instance and try again.')
  const [frame] = await chrome.scripting
    .executeScript({
      target: { tabId: tab.tabId },
      world: 'ISOLATED',
      func: readSelection,
      args: [tab.url, tab.instance.path, selectionLimit],
    })
    .catch(() => refuse('Could not access the editor. Open the intended Confluence tab and try again.'))
  const parsed = editorSelectionResult.safeParse(frame?.result)
  if (!parsed.success) refuse('Confluence did not return the expected editor selection.')
  switch (parsed.data.kind) {
    case 'selection':
      return { tab, text: parsed.data.text, truncated: parsed.data.truncated }
    case 'changed':
      refuse('The active tab changed. Select text in the intended editor and try again.')
    case 'not-editor':
      refuse('Open a supported Confluence editor and select text in the page body.')
    case 'empty':
      refuse('Select text in the Confluence editor before attaching it.')
  }
}

/** Runs in the isolated world of the captured top-level tab. */
function readSelection(expectedUrl: string, contextPath: string, limit: number) {
  const current = new URL(location.href)
  current.hash = ''
  if (current.href !== expectedUrl) return { kind: 'changed' }
  const path = current.pathname.slice(contextPath.length).replace(/;[^/]*|%3bjsessionid(?:=|%3d)[^/]*/gi, '')
  if (!/^\/pages\/(?:editpage|resumedraft|createpage)\.action$/.test(path)) return { kind: 'not-editor' }

  const frame = document.querySelector<HTMLIFrameElement>('iframe#wysiwygTextarea_ifr')
  const editor = frame?.contentDocument?.body
  if (!editor || editor.getAttribute('contenteditable') !== 'true') return { kind: 'not-editor' }
  const selection = editor.ownerDocument.getSelection()
  if (
    !selection?.anchorNode ||
    !selection.focusNode ||
    selection.isCollapsed ||
    !editor.contains(selection.anchorNode) ||
    !editor.contains(selection.focusNode)
  )
    return { kind: 'empty' }
  const text = selection.toString().trim()
  if (!text) return { kind: 'empty' }
  return { kind: 'selection', text: text.slice(0, limit), truncated: text.length > limit }
}

export function restUrl(instance: Instance, resource: string, query: Query, area: RestArea): URL {
  const endpoint = new URL(`${instance.origin}${instance.path}/rest/${area}/${resource}`)
  endpoint.search = new URLSearchParams(query).toString()
  return endpoint
}

export function getConfluence(
  target: ConfluenceTab,
  resource: string | null,
  query: Query,
  signal?: AbortSignal,
  area: RestArea = 'api',
) {
  // Chrome drops null properties when serializing injected arguments.
  return sendConfluence(target, { area, resource: resource ?? 'current-page', query, method: 'GET' }, signal)
}

type LabelWrite = { method: 'POST'; body: unknown } | { method: 'DELETE'; query: Query }

export function writeConfluenceLabel(target: ConfluenceTab, id: string, write: LabelWrite, signal?: AbortSignal) {
  return sendConfluence(
    target,
    {
      area: 'api',
      resource: `content/${id}/label`,
      method: write.method,
      query: write.method === 'DELETE' ? write.query : {},
      ...(write.method === 'POST' && { body: JSON.stringify(write.body) }),
    },
    signal,
  )
}

export function createConfluenceContent<T extends { type: 'page' | 'comment' }>(
  target: ConfluenceTab,
  body: T,
  signal?: AbortSignal,
) {
  return sendConfluence(
    target,
    { area: 'api', resource: 'content', method: 'POST', query: {}, body: JSON.stringify(body) },
    signal,
    body.type === 'comment' ? 'Confluence rejected the comment. Check the page and reply target.' : undefined,
  )
}

export function updateConfluencePage(target: ConfluenceTab, id: string, body: unknown, signal?: AbortSignal) {
  return sendConfluence(
    target,
    { area: 'api', resource: `content/${id}`, method: 'PUT', query: {}, body: JSON.stringify(body) },
    signal,
  )
}

export function trashConfluencePage(target: ConfluenceTab, id: string, signal?: AbortSignal) {
  return sendConfluence(
    target,
    { area: 'api', resource: `content/${id}`, method: 'DELETE', query: { status: 'current' } },
    signal,
  )
}

export function restoreConfluencePage(target: ConfluenceTab, id: string, nextVersion: number, signal?: AbortSignal) {
  return sendConfluence(
    target,
    {
      area: 'api',
      resource: `content/${id}`,
      method: 'PUT',
      query: { status: 'trashed' },
      body: JSON.stringify({ id, status: 'current', version: { number: nextVersion } }),
    },
    signal,
  )
}

async function sendConfluence(target: ConfluenceTab, request: RestRequest, signal?: AbortSignal, rejection?: string) {
  signal?.throwIfAborted()
  if (!(await chrome.permissions.contains({ origins: [target.instance.permission] }))) {
    refuse('Confluco needs Chrome site access. Reconnect this Confluence instance and try again.')
  }
  signal?.throwIfAborted()

  const writing = request.method !== 'GET'
  const uncertain = () =>
    refuse('The Confluence change may have been applied. Check the page before trying again.', true)
  const requestId = crypto.randomUUID()
  const injection = {
    target: { tabId: target.tabId },
    world: 'ISOLATED' as const,
  }
  let onAbort: (() => void) | undefined
  const stopped = new Promise<never>((_, reject) => {
    onAbort = () => {
      reject(signal?.reason)
      void chrome.scripting.executeScript({ ...injection, func: abortRequest, args: [requestId] }).catch(() => {})
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })

  let raw: unknown
  try {
    const [frame] = await Promise.race([
      chrome.scripting.executeScript({
        ...injection,
        func: requestConfluence,
        args: [target.url, target.instance.path, request, requestId],
      }),
      stopped,
    ])
    raw = frame?.result
  } catch {
    if (writing) uncertain()
    signal?.throwIfAborted()
    refuse('Could not access the Confluence tab. Check its site permission and try again.')
  } finally {
    if (onAbort) signal?.removeEventListener('abort', onAbort)
  }
  if (signal?.aborted && writing) uncertain()
  signal?.throwIfAborted()

  const response = result.safeParse(raw)
  if (!response.success) {
    if (writing) uncertain()
    refuse(errors.invalid)
  }
  if (response.data.kind !== 'ok') {
    const { kind } = response.data
    if (writing && ['auth', 'large', 'network', 'invalid'].includes(kind)) uncertain()
    if (kind === 'rejected' && rejection) refuse(rejection)
    if (kind === 'rejected' && request.method === 'PUT' && request.query.status === 'trashed')
      refuse('Confluence rejected the restore. Check the page in the space trash before trying again.')
    if (kind === 'rejected' && request.method === 'DELETE' && request.query.status === 'current')
      refuse('Confluence rejected moving this page to the trash. Review the page in Confluence before trying again.')
    if (
      kind === 'rejected' &&
      (request.method === 'PUT' || (request.method === 'POST' && request.resource === 'content'))
    )
      refuse('Confluence rejected the page change. Check that the title is valid and unique in the chosen space.')
    throw new ConfluenceRequestError(kind)
  }
  return response.data
}

declare global {
  // These controllers exist only in the extension's isolated world for this tab.
  var conflucoReads: Map<string, AbortController> | undefined
}

function abortRequest(requestId: string) {
  globalThis.conflucoReads?.get(requestId)?.abort()
}

/** Chrome serializes this function into the top-level page. Keep its dependencies inside it. */
async function requestConfluence(expectedUrl: string, contextPath: string, request: RestRequest, requestId: string) {
  const actual = new URL(location.href)
  actual.hash = ''
  if (actual.href !== expectedUrl) return { kind: 'changed' }
  const { area, query, method, body } = request
  let { resource } = request
  let pageId: string | undefined
  if (resource === 'current-page') {
    if (area !== 'api' || method !== 'GET') return { kind: 'invalid' }
    const path = actual.pathname.slice(contextPath.length).replace(/;[^/]*|%3bjsessionid(?:=|%3d)[^/]*/gi, '')
    const metaId = document.querySelector<HTMLMetaElement>('meta[name="ajs-page-id"]')?.content
    const type = document.querySelector<HTMLMetaElement>('meta[name="ajs-content-type"]')?.content
    if (type && type !== 'page') return { kind: 'not-page' }

    if (path === '/pages/viewpage.action') {
      const ids = actual.searchParams.getAll('pageId')
      if (ids.length === 1 && (!metaId || metaId === ids[0])) pageId = ids[0]
    } else if (/^\/display\/[^/]+\/[^/]+\/?$/.test(path)) {
      pageId = metaId
    }
    if (!pageId || !/^\d+$/.test(pageId)) return { kind: 'not-page' }
    resource = 'content/' + pageId
  }

  if (area === 'experimental' && (method !== 'GET' || !/^content\/\d{1,20}\/version$/.test(resource)))
    return { kind: 'invalid' }
  const labelResource = /^content\/\d{1,20}\/label$/.test(resource)
  const pageResource = /^content\/\d{1,20}$/.test(resource)
  if (method === 'POST' && resource !== 'content' && !labelResource) return { kind: 'invalid' }
  if (method === 'PUT' && !pageResource) return { kind: 'invalid' }
  if (method === 'DELETE' && !labelResource) {
    // Deleting content in any other status could purge it. Only a current page may enter the trash.
    if (!pageResource || query.status !== 'current' || Object.keys(query).length !== 1) return { kind: 'invalid' }
  }
  const apiPath = `${contextPath}/rest/${area}/`
  const endpoint = new URL(actual.origin + apiPath + resource)
  if (endpoint.origin !== actual.origin || !endpoint.pathname.startsWith(apiPath) || endpoint.hash || endpoint.search)
    return { kind: 'invalid' }
  endpoint.search = new URLSearchParams(query).toString()

  const controller = new AbortController()
  globalThis.conflucoReads ??= new Map()
  globalThis.conflucoReads.set(requestId, controller)
  const cap = 1_000_000
  try {
    const response = await fetch(endpoint.href, {
      method,
      credentials: 'same-origin',
      redirect: 'manual',
      referrerPolicy: 'no-referrer',
      headers: { Accept: 'application/json', ...(body !== undefined && { 'Content-Type': 'application/json' }) },
      body,
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
    })
    if (
      response.type === 'opaqueredirect' ||
      response.status === 401 ||
      (response.status >= 300 && response.status < 400)
    )
      return { kind: 'auth' }
    if (response.status === 400) return { kind: 'rejected' }
    if (response.status === 403) return { kind: 'forbidden' }
    if (response.status === 404) return { kind: 'missing' }
    if (response.status === 405 || response.status === 501) return { kind: 'unsupported' }
    if (response.status === 409) return { kind: 'conflict' }
    if (response.status === 429) return { kind: 'limited' }
    if (!response.ok) return { kind: 'network' }
    if (response.status === 204 && method === 'DELETE') return { kind: 'ok', data: null }
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
    globalThis.conflucoReads.delete(requestId)
  }
}
