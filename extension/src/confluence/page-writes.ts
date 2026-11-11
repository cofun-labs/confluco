import { z } from '../zod'
import { readableText } from './readable-text'
import { fetchPublishedPage, pageLink, pageReference, publishedPage, type PageReference } from './references'
import {
  createConfluencePage,
  getConfluence,
  refuse,
  requireTab,
  updateConfluencePage,
  type ConfluenceTab,
} from './transport'

const title = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .regex(/^[^\p{C}]+$/u)
export const pageTitleArgs = z.strictObject({ title: title.describe('The exact new title from the user request.') })
const pageLocation = publishedPage.extend({ space: z.object({ key: z.string().min(1).max(255) }) })
const pageVersion = pageLocation.extend({ version: z.object({ number: z.int().min(1).max(2_147_483_647) }) })
const storedPage = pageVersion.extend({
  ancestors: z.array(z.object({ id: pageReference.shape.id })),
  body: z.object({ storage: z.object({ value: z.string(), representation: z.literal('storage') }) }),
})
const storedFields = 'space,ancestors,version,body.storage'

export type PageWriteRequest =
  | { action: 'create'; title: string; targetUrl?: string; spaceKey?: string; text: string }
  | { action: 'rename'; title: string; targetUrl?: string }

const createEnglish =
  /^(?:please\s+)?create\s+(?:a\s+)?(?:published\s+)?(?:child\s+)?page\s+(?:(?:called|named|titled)\s+)?(?<title>"[^"\r\n]+"|“[^”\r\n]+”|`[^`\r\n]+`)(?:\s+in\s+space\s+(?<space>"[^"]+"|[^\s]+))?\s+under\s+(?:this\s+page|(?<target>https?:\/\/[^\s]+))(?:\s+with\s+text\s+(?<text>"[^"]*"|“[^”]*”|`[^`]*`))?[.!]?$/iu
const renameEnglish =
  /^(?:please\s+)?rename\s+(?:this\s+page|(?:page\s+)?(?<target>https?:\/\/[^\s]+))\s+to\s+(?<title>"[^"\r\n]+"|“[^”\r\n]+”|`[^`\r\n]+`)[.!]?$/iu
const createChinese =
  /^(?:请\s*)?在(?:当前(?:的)?页面?|本页|这(?:个)?页面?)下\s*创建(?:一个)?(?:子)?页面\s*(?<title>"[^"\r\n]+"|“[^”\r\n]+”|`[^`\r\n]+`)(?:\s*[，,]?\s*(?:正文|内容)(?:是|为)?\s*[：:]?\s*(?<text>"[^"]*"|“[^”]*”|`[^`]*`))?[。！!]?$/u
const renameChinese =
  /^(?:请\s*)?(?:把|将)?(?:当前(?:的)?页面?|本页|这(?:个)?页面?)\s*(?:重命名为|改名为|改成)\s*(?<title>"[^"\r\n]+"|“[^”\r\n]+”|`[^`\r\n]+`)[。！!]?$/u

export function requestedPageWrite(message: string): PageWriteRequest | undefined {
  const text = message.trim()
  const creation = (createEnglish.exec(text) ?? createChinese.exec(text))?.groups
  const rename = (renameEnglish.exec(text) ?? renameChinese.exec(text))?.groups
  const match = creation ?? rename
  const name = title.safeParse(match?.title?.slice(1, -1))
  if (!name.success || !match) return undefined
  const targetUrl = match.target
  if (!creation) return { action: 'rename', title: name.data, targetUrl }
  const spaceKey = match.space?.startsWith('"') ? match.space.slice(1, -1) : match.space
  const body = match.text?.slice(1, -1) ?? ''
  if (body.length > 40_000) return undefined
  return { action: 'create', title: name.data, targetUrl, spaceKey, text: body }
}

function requestedReference(tab: ConfluenceTab, target: string | undefined): PageReference | undefined {
  if (!target) return undefined
  const url = URL.parse(target)
  if (!url) refuse('Use a published page link from the connected Confluence instance.')
  const { origin, path } = tab.instance
  const [id, ...others] = url.searchParams.getAll('pageId')
  const ref = pageReference.safeParse({ instance: origin + path, id })
  if (
    !ref.success ||
    others.length ||
    url.origin !== origin ||
    url.username ||
    url.password ||
    url.pathname !== path + '/pages/viewpage.action'
  )
    refuse('Use a published page link from the connected Confluence instance.')
  return ref.data
}

interface PreparedCreate {
  action: 'create'
  tab: ConfluenceTab
  ref?: PageReference
  request: Extract<PageWriteRequest, { action: 'create' }>
  target: z.output<typeof pageLocation>
}

interface PreparedRename {
  action: 'rename'
  tab: ConfluenceTab
  ref?: PageReference
  request: Extract<PageWriteRequest, { action: 'rename' }>
  target: z.output<typeof storedPage>
}

export async function preparePageWrite(
  request: PageWriteRequest,
  current: ConfluenceTab | undefined,
  signal?: AbortSignal,
): Promise<PreparedCreate | PreparedRename> {
  const tab = requireTab(current)
  const ref = requestedReference(tab, request.targetUrl)
  if (request.action === 'rename') {
    const target = await fetchPublishedPage(tab, ref, storedPage, storedFields, signal)
    return { action: 'rename', tab, ref, request, target }
  }
  const target = await fetchPublishedPage(tab, ref, pageLocation, 'space', signal)
  if (request.spaceKey && request.spaceKey !== target.space.key)
    refuse('The chosen parent is not in the requested Confluence space.')
  return { action: 'create', tab, ref, request, target }
}

export function describePageWrite(plan: PreparedCreate | PreparedRename): string {
  const target = pageLink(plan.tab.instance, plan.target)
  const site = `${plan.tab.instance.origin}${plan.tab.instance.path}`
  const destination = `"${target.title}" (${target.url}) in space ${plan.target.space.key} on ${site}`
  return plan.action === 'create'
    ? `Create "${plan.request.title}" under ${destination}.`
    : `Rename ${destination} to "${plan.request.title}".`
}

const entities: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

function plainTextStorage(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n\n+/)
    .map((paragraph) => {
      const content = paragraph.replace(/[&<>"']/g, (character) => entities[character]).replace(/\n/g, '<br />')
      return `<p>${content}</p>`
    })
    .join('')
}

async function duplicatePage(plan: PreparedCreate, signal?: AbortSignal) {
  const response = await getConfluence(
    plan.tab,
    'content',
    {
      spaceKey: plan.target.space.key,
      title: plan.request.title,
      type: 'page',
      status: 'current',
      expand: 'space',
      limit: '2',
    },
    signal,
  )
  const parsed = z.object({ results: z.array(pageLocation).max(2) }).safeParse(response.data)
  if (
    !parsed.success ||
    parsed.data.results.some(
      (item) =>
        item.space.key !== plan.target.space.key || item.title.toLowerCase() !== plan.request.title.toLowerCase(),
    )
  )
    refuse('Confluence did not return the expected duplicate-title check.')
  return parsed.data.results[0]
}

function unverifiedWrite(): never {
  refuse('Confluence may have applied the change, but the resulting page could not be verified.', true)
}

async function readWrittenPage(tab: ConfluenceTab, id: string, signal?: AbortSignal) {
  try {
    const ref = { instance: tab.instance.origin + tab.instance.path, id }
    return await fetchPublishedPage(tab, ref, storedPage, storedFields, signal)
  } catch {
    unverifiedWrite()
  }
}

export async function applyPageWrite(plan: PreparedCreate | PreparedRename, signal?: AbortSignal) {
  const { tab, ref, request, target } = plan
  if (plan.action === 'create') {
    const duplicate = await duplicatePage(plan, signal)
    if (duplicate) return { page: pageLink(tab.instance, duplicate), changed: false, alreadyExists: true }
    const parent = await fetchPublishedPage(tab, ref, pageLocation, 'space', signal)
    if (parent.id !== target.id || parent.space.key !== target.space.key)
      refuse('The chosen parent changed. Ask again on the intended page.')
    const value = plainTextStorage(plan.request.text)
    const response = await createConfluencePage(
      tab,
      {
        type: 'page',
        title: request.title,
        space: { key: parent.space.key },
        ancestors: [{ id: parent.id }],
        body: { storage: { value, representation: 'storage' } },
      },
      signal,
    )
    const created = publishedPage.safeParse(response.data)
    if (!created.success || created.data.title !== request.title) unverifiedWrite()
    const verified = await readWrittenPage(tab, created.data.id, signal)
    if (
      verified.title !== request.title ||
      verified.space.key !== parent.space.key ||
      verified.ancestors.at(-1)?.id !== parent.id ||
      readableText(verified.body.storage.value) !== readableText(value)
    )
      unverifiedWrite()
    return {
      page: pageLink(tab.instance, verified),
      parent: pageLink(tab.instance, parent),
      space: parent.space.key,
      version: verified.version.number,
      changed: true,
      bodyVerified: true,
    }
  }

  if (target.title === request.title) return { page: pageLink(tab.instance, target), changed: false }
  const original = plan.target
  const current = await fetchPublishedPage(tab, ref, pageVersion, 'space,version', signal)
  if (
    current.id !== original.id ||
    current.title !== original.title ||
    current.space.key !== original.space.key ||
    current.version.number !== original.version.number
  )
    refuse('The Confluence page changed after the preview. Check its current version before trying again.')
  if (original.version.number === 2_147_483_647) refuse('This Confluence page cannot be advanced to another version.')
  const next = original.version.number + 1
  const response = await updateConfluencePage(
    tab,
    original.id,
    {
      type: 'page',
      title: request.title,
      version: { number: next },
      body: { storage: original.body.storage },
    },
    signal,
  )
  const updated = publishedPage.safeParse(response.data)
  if (!updated.success || updated.data.id !== original.id || updated.data.title !== request.title) unverifiedWrite()
  const verified = await readWrittenPage(tab, original.id, signal)
  if (
    verified.title !== request.title ||
    verified.version.number !== next ||
    verified.space.key !== original.space.key ||
    verified.ancestors.at(-1)?.id !== original.ancestors.at(-1)?.id ||
    verified.body.storage.value !== original.body.storage.value
  )
    unverifiedWrite()
  return {
    page: pageLink(tab.instance, verified),
    previousTitle: original.title,
    version: next,
    changed: true,
    contentPreserved: true,
  }
}
