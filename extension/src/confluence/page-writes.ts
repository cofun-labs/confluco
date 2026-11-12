import { z } from '../zod'
import { readableText } from './readable-text'
import {
  fetchPublishedPage,
  pageLink,
  pageReference,
  pageResource,
  publishedPage,
  type PageReference,
} from './references'
import { replaceStorageText } from './storage-edit'
import {
  createConfluenceContent,
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
const historicalStorage = storedPage.extend({
  status: z.literal('historical'),
  version: pageVersion.shape.version.extend({ hidden: z.boolean().optional() }),
})
export const pageEditUndo = z.strictObject({
  page: pageReference,
  version: pageVersion.shape.version.shape.number.min(2),
  before: z.string().min(1).max(2000),
  after: z.string().max(2000),
})
export type PageEditUndo = z.output<typeof pageEditUndo>

export type PageWriteRequest =
  | { action: 'create'; title: string; targetUrl?: string; spaceKey?: string; text: string }
  | { action: 'rename'; title: string; targetUrl?: string }

const createEnglish =
  /^(?:please\s+)?create\s+(?:a\s+)?(?:published\s+)?(?:child\s+)?page\s+(?:(?:called|named|titled)\s+)?(?<title>"[^"\r\n]+"|“[^”\r\n]+”|`[^`\r\n]+`)(?:\s+in\s+space\s+(?<space>"[^"]+"|[^\s]+))?\s+under\s+(?:this\s+page|(?<target>https?:\/\/[^\s]+?))(?:\s+with\s+text\s+(?<text>"[^"]*"|“[^”]*”|`[^`]*`))?[.!]?$/iu
const renameEnglish =
  /^(?:please\s+)?rename\s+(?:this\s+page|(?:page\s+)?(?<target>https?:\/\/[^\s]+))\s+to\s+(?<title>"[^"\r\n]+"|“[^”\r\n]+”|`[^`\r\n]+`)[.!]?$/iu
const createChinese =
  /^(?:请\s*)?在(?:当前(?:的)?页面?|本页|这(?:个)?页面?)下\s*创建(?:一个)?(?:子)?页面\s*(?<title>"[^"\r\n]+"|“[^”\r\n]+”|`[^`\r\n]+`)(?:\s*[，,]?\s*(?:正文|内容)(?:是|为)?\s*[：:]?\s*(?<text>"[^"]*"|“[^”]*”|`[^`]*`))?[。！!]?$/u
const renameChinese =
  /^(?:请\s*)?(?:把|将)?(?:当前(?:的)?页面?|本页|这(?:个)?页面?)\s*(?:重命名为|改名为|改成)\s*(?<title>"[^"\r\n]+"|“[^”\r\n]+”|`[^`\r\n]+`)[。！!]?$/u

const editEnglish =
  /^(?:please\s+)?replace\s+(?<before>"[^"\r\n]+"|“[^”\r\n]+”|`[^`\r\n]+`)\s+with\s+(?<after>"[^"\r\n]*"|“[^”\r\n]*”|`[^`\r\n]*`)\s+on\s+(?:this\s+page|(?<target>https?:\/\/[^\s]+?))[.!]?$/iu
const editChinese =
  /^(?:请\s*)?在(?:当前(?:的)?页面?|本页|这(?:个)?页面?)(?:上)?\s*(?:把|将)\s*(?<before>"[^"\r\n]+"|“[^”\r\n]+”|`[^`\r\n]+`)\s*(?:替换为|改为|改成)\s*(?<after>"[^"\r\n]*"|“[^”\r\n]*”|`[^`\r\n]*`)[。！!]?$/u

export interface PageEditRequest {
  before: string
  after: string
  targetUrl?: string
}

export function requestedPageEdit(message: string): PageEditRequest | undefined {
  const text = message.trim()
  const match = (editEnglish.exec(text) ?? editChinese.exec(text))?.groups
  if (!match) return undefined
  return { before: match.before.slice(1, -1), after: match.after.slice(1, -1), targetUrl: match.target }
}

export function requestedUndo(message: string): boolean {
  return /^(?:(?:please\s+)?undo (?:the |my )?(?:last|previous) (?:operation|change|edit)|(?:请\s*)?撤销(?:上次|上一次|上一条)(?:操作|改动|编辑))[.!。！]?$/iu.test(
    message.trim(),
  )
}

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
  return { action: 'create', title: name.data, targetUrl, spaceKey, text: match.text?.slice(1, -1) ?? '' }
}

export function requestedReference(tab: ConfluenceTab, target: string | undefined): PageReference | undefined {
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
  if (request.action === 'create' && request.text.length > 40_000)
    refuse('Shorten the requested page body to 40,000 characters or fewer.')
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

export function plainTextStorage(text: string): string {
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

export async function preparePageEdit(
  request: PageEditRequest,
  current: ConfluenceTab | undefined,
  signal?: AbortSignal,
) {
  const { before, after, targetUrl } = request
  if (!before.trim() || before.length > 2000 || after.length > 2000 || /\p{Cc}/u.test(before + after))
    refuse('Quote a non-empty passage and a replacement of at most 2,000 characters each, on one line.')
  if (before === after) refuse('The replacement is the same as the original text.')
  const tab = requireTab(current)
  const ref = requestedReference(tab, targetUrl)
  const original = await fetchPublishedPage(tab, ref, storedPage, storedFields, signal)
  const value = replaceStorageText(original.body.storage.value, before, after)
  return { tab, ref, original, value, preview: describeEdit('Edit', tab, original, before, after) }
}

export async function prepareUndoPageEdit(
  record: PageEditUndo,
  target: ConfluenceTab | undefined,
  signal?: AbortSignal,
) {
  const tab = requireTab(target)
  const ref = record.page
  const original = await fetchPublishedPage(tab, ref, storedPage, storedFields, signal)
  if (original.version.number !== record.version)
    refuse('The page has changed since the last edit. Review its version history to decide how to undo it.')
  const previous = await getConfluence(
    tab,
    pageResource(tab, ref),
    { status: 'historical', version: String(record.version - 1), expand: storedFields },
    signal,
  )
  const parsed = historicalStorage.safeParse(previous.data)
  if (
    !parsed.success ||
    parsed.data.version.hidden ||
    parsed.data.version.number !== record.version - 1 ||
    !samePageLocation(parsed.data, original)
  )
    refuse('Confluence did not return the matching prior version. Review the page history before undoing.')
  const value = parsed.data.body.storage.value
  if (replaceStorageText(value, record.before, record.after) !== original.body.storage.value)
    refuse('The earlier version does not match the last edit. Review the page history before undoing.')
  return {
    tab,
    ref,
    original,
    value,
    preview: describeEdit('Undo the edit on', tab, original, record.after, record.before),
  }
}

function describeEdit(
  action: string,
  tab: ConfluenceTab,
  original: z.output<typeof storedPage>,
  before: string,
  after: string,
): string {
  const page = pageLink(tab.instance, original)
  return (
    `${action} "${page.title}" (${page.url}) in space ${original.space.key}, version ${original.version.number}.\n` +
    `Before: ${JSON.stringify(before)}\nAfter: ${JSON.stringify(after)}`
  )
}

function samePageLocation(
  left: z.output<typeof historicalStorage> | z.output<typeof storedPage>,
  right: z.output<typeof storedPage>,
): boolean {
  return (
    left.id === right.id &&
    left.title === right.title &&
    left.space.key === right.space.key &&
    left.ancestors.length === right.ancestors.length &&
    left.ancestors.every(({ id }, index) => id === right.ancestors[index]?.id)
  )
}

export async function applyPageEdit(plan: Awaited<ReturnType<typeof preparePageEdit>>, signal?: AbortSignal) {
  const { tab, ref, original, value } = plan
  const current = await fetchPublishedPage(tab, ref, storedPage, storedFields, signal)
  if (
    !samePageLocation(current, original) ||
    current.version.number !== original.version.number ||
    current.body.storage.value !== original.body.storage.value
  )
    refuse('The Confluence page changed after the preview. Review the current page and ask for a new preview.')
  if (original.version.number === 2_147_483_647) refuse('This Confluence page cannot be advanced to another version.')

  const next = original.version.number + 1
  let recovered = false
  try {
    await updateConfluencePage(
      tab,
      original.id,
      {
        type: 'page',
        title: original.title,
        version: { number: next },
        body: { storage: { value, representation: 'storage' } },
      },
      signal,
    )
  } catch (error) {
    if (signal?.aborted || !(error instanceof Error) || !('mayHaveChanged' in error) || error.mayHaveChanged !== true)
      throw error
    recovered = true
  }
  const verified = await readWrittenPage(tab, original.id, signal)
  if (
    !samePageLocation(verified, original) ||
    verified.version.number !== next ||
    verified.body.storage.value !== value
  )
    unverifiedWrite()
  return { page: pageLink(tab.instance, verified), version: next, changed: true, bodyVerified: true, recovered }
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
    const response = await createConfluenceContent(
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
