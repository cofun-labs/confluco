import { z } from '../zod'
import { collection, collectionStart } from './collection'
import { readableText } from './readable-text'
import {
  fetchPublishedPage,
  pageLink,
  pageReference,
  pageResource,
  publishedPage,
  type PageReference,
} from './references'
import { ConfluenceRequestError, getConfluence, refuse, requireTab, type ConfluenceTab } from './transport'

const reference = pageReference.optional().describe('Omit to use the current published page.')
const versionNumber = z.int().min(1)
export const versionsArgs = z.strictObject({ page: reference, start: collectionStart })
export const historicalArgs = z.strictObject({ page: reference, version: versionNumber })
export const accessArgs = z.strictObject({ page: reference })

const version = z.object({
  number: versionNumber,
  when: z.string().max(80).optional(),
  message: z.string().optional(),
  minorEdit: z.boolean().optional(),
  hidden: z.boolean().optional(),
  by: z.object({ displayName: z.string().max(200).optional() }).optional(),
})
const versionedPage = publishedPage.extend({ version })
const historicalPage = versionedPage.extend({
  status: z.literal('historical'),
  body: z.object({ view: z.object({ value: z.string() }) }),
})
const operation = z.object({ operation: z.string().min(1).max(80), targetType: z.string().max(80).optional() })
const pageWithOperations = publishedPage.extend({ operations: z.array(operation).max(100).optional() })
const restrictionList = z.object({ results: z.array(z.unknown()) })
const restriction = z.object({ restrictions: z.object({ user: restrictionList, group: restrictionList }) })
const restrictions = z.object({ read: restriction, update: restriction })

function visibleVersion(value: z.output<typeof version>) {
  return {
    number: value.number,
    when: value.when,
    author: value.by?.displayName,
    message: value.message?.slice(0, 300),
    minorEdit: value.minorEdit,
  }
}

function historyLink(tab: ConfluenceTab, id: string) {
  return `${tab.instance.origin}${tab.instance.path}/pages/viewpreviousversions.action?pageId=${id}`
}

function unavailable(error: unknown) {
  return error instanceof ConfluenceRequestError && ['forbidden', 'missing', 'unsupported'].includes(error.kind)
}

export async function listVersions(
  input: z.output<typeof versionsArgs>,
  target: ConfluenceTab | undefined,
  signal?: AbortSignal,
) {
  const tab = requireTab(target)
  const page = await fetchPublishedPage(tab, input.page, versionedPage, 'version', signal)
  const context = {
    ...pageLink(tab.instance, page),
    historyUrl: historyLink(tab, page.id),
    currentVersion: visibleVersion(page.version),
  }
  try {
    const { items, ...next } = await collection(tab, `content/${page.id}/version`, {}, input.start, version, {
      signal,
      area: 'experimental',
    })
    return { ...context, versions: items.filter((item) => !item.hidden).map(visibleVersion), ...next }
  } catch (error) {
    if (!unavailable(error)) throw error
    return {
      ...context,
      versions: null,
      notice: 'The version list is unavailable. A known older version can be requested directly.',
    }
  }
}

export async function readHistoricalVersion(
  input: z.output<typeof historicalArgs>,
  target: ConfluenceTab | undefined,
  signal?: AbortSignal,
) {
  const tab = requireTab(target)
  const response = await getConfluence(
    tab,
    pageResource(tab, input.page),
    {
      status: 'historical',
      version: String(input.version),
      expand: 'body.view,version',
    },
    signal,
  )
  const parsed = historicalPage.safeParse(response.data)
  if (
    !parsed.success ||
    parsed.data.id !== (input.page?.id ?? response.pageId) ||
    parsed.data.version.number !== input.version ||
    parsed.data.version.hidden
  )
    refuse('Confluence did not return the requested historical version.')
  const page = parsed.data
  const text = readableText(page.body.view.value)
  const limit = 12_000
  return {
    ...pageLink(tab.instance, page),
    historyUrl: historyLink(tab, page.id),
    version: visibleVersion(page.version),
    text: text.slice(0, limit),
    truncated: text.length > limit,
  }
}

export async function pageAccess(
  reference: PageReference | undefined,
  target: ConfluenceTab | undefined,
  signal?: AbortSignal,
) {
  const tab = requireTab(target)
  const page = await fetchPublishedPage(tab, reference, pageWithOperations, 'operations', signal)
  const summary = { ...pageLink(tab.instance, page), operations: page.operations ?? null }
  try {
    const response = await getConfluence(tab, `content/${page.id}/restriction/byOperation`, {}, signal)
    const parsed = restrictions.safeParse(response.data)
    if (!parsed.success)
      return { ...summary, restrictions: null, notice: 'Page restrictions were unavailable in the response.' }
    const hasRestriction = ({ restrictions }: z.output<typeof restriction>) =>
      restrictions.user.results.length > 0 || restrictions.group.results.length > 0
    return {
      ...summary,
      restrictions: { read: hasRestriction(parsed.data.read), update: hasRestriction(parsed.data.update) },
      notice:
        'These are reported page restrictions. Confluence evaluates effective access, including inherited restrictions.',
    }
  } catch (error) {
    if (!unavailable(error)) throw error
    return { ...summary, restrictions: null, notice: 'This account or instance cannot report page restrictions.' }
  }
}
