import { z } from '../zod'
import type { Instance } from './instance'
import { readableText } from './readable-text'
import { pageLink, pageReference, publishedPage } from './references'
import { getConfluence, refuse, requireTab, restUrl, type ConfluenceTab } from './transport'

const pageSize = 10
const maxStart = 990
const start = z.int().min(0).max(maxStart).default(0).describe('Omit on the first call. Use the returned nextStart.')
const spaceKey = z
  .string()
  .regex(/^(?:~[\w.@-]+|[a-zA-Z0-9][a-zA-Z0-9_-]*)$/)
  .max(255)

export const searchArgs = z.strictObject({
  query: z.string().trim().min(1).max(200).describe('Text to find in published pages.'),
  field: z.enum(['text', 'title']).default('text').describe('Search the full page or only its title.'),
  spaceKey: spaceKey.optional().describe('Restrict the search to this space key.'),
  start,
})
export const listSpacesArgs = z.strictObject({ start })
export const spaceArgs = z.strictObject({ key: spaceKey.describe('The space key, including ~ for a personal space.') })
export const treeArgs = z.strictObject({
  page: pageReference.optional().describe('Omit to browse the published page in the active tab.'),
  start,
})

const space = z.object({ key: spaceKey, name: z.string().trim().min(1).max(1000) })
const searchHit = z.object({ content: publishedPage, excerpt: z.string().max(16_000).optional() })
const spaceDetail = space.extend({ homepage: publishedPage.nullish() })
const treePage = publishedPage.extend({ ancestors: z.array(publishedPage) })

function cqlString(value: string): string {
  return `"${value.replace(/\s+/g, ' ').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function spaceLink(instance: Instance, value: z.infer<typeof space>) {
  return {
    ...value,
    url: `${instance.origin}${instance.path}/display/${encodeURIComponent(value.key)}`,
  }
}

async function collection<S extends z.ZodType>(
  tab: ConfluenceTab,
  resource: string,
  query: Record<string, string>,
  offset: number,
  item: S,
  signal?: AbortSignal,
) {
  const params = { ...query, start: String(offset), limit: String(pageSize) }
  const response = await getConfluence(tab, resource, params, signal)
  const schema = z.object({
    results: z.array(item).max(pageSize),
    _links: z.object({ next: z.string().max(4096).optional() }).optional(),
  })
  const parsed = schema.safeParse(response.data)
  if (!parsed.success) refuse('Confluence did not return the expected results.')
  const next = parsed.data._links?.next
  const request = restUrl(tab.instance, resource, params)
  return { items: parsed.data.results, ...pagination(tab.instance, request, next, offset) }
}

/** Read an offset from the response link. The next request always uses the original API and filters. */
function pagination(instance: Instance, request: URL, next: string | undefined, offset: number) {
  if (next === undefined) return {}
  const invalid = { paginationNotice: 'Confluence returned an invalid next page link.' }
  let url: URL
  try {
    // Confluence can return an API-relative path without the deployment context.
    url = next.startsWith('/rest/api/') ? new URL(instance.origin + instance.path + next) : new URL(next, request)
  } catch {
    return invalid
  }
  if (url.origin !== request.origin || url.pathname !== request.pathname || url.username || url.password || url.hash)
    return invalid
  const [value, ...duplicate] = url.searchParams.getAll('start')
  if (value === undefined || duplicate.length || !/^\d+$/.test(value)) return invalid
  const nextStart = Number(value)
  if (nextStart <= offset || nextStart > offset + pageSize) return invalid
  if (nextStart > maxStart) return { paginationNotice: 'The result limit was reached. Refine the request for more.' }
  return { nextStart }
}

export async function searchPages(
  input: z.output<typeof searchArgs>,
  target: ConfluenceTab | undefined,
  signal?: AbortSignal,
) {
  const tab = requireTab(target)
  const spaceFilter = input.spaceKey ? ` AND space = ${cqlString(input.spaceKey)}` : ''
  const cql = `type = page AND ${input.field} ~ ${cqlString(input.query)}${spaceFilter}`
  const { items, ...next } = await collection(tab, 'search', { cql }, input.start, searchHit, signal)
  const results = items.map(({ content, excerpt }) => ({
    ...pageLink(tab.instance, content),
    ...(excerpt && { excerpt: readableText(excerpt.replace(/@@@(?:end)?hl@@@/gi, '')).slice(0, 320) }),
  }))
  return { results, ...next }
}

export async function listSpaces(offset: number, target: ConfluenceTab | undefined, signal?: AbortSignal) {
  const tab = requireTab(target)
  const { items, ...next } = await collection(tab, 'space', {}, offset, space, signal)
  return { spaces: items.map((item) => spaceLink(tab.instance, item)), ...next }
}

export async function getSpace(key: string, target: ConfluenceTab | undefined, signal?: AbortSignal) {
  const tab = requireTab(target)
  const response = await getConfluence(tab, `space/${encodeURIComponent(key)}`, { expand: 'homepage' }, signal)
  const parsed = spaceDetail.safeParse(response.data)
  if (!parsed.success || parsed.data.key !== key) refuse('Confluence did not return the requested space.')
  const { homepage, ...item } = parsed.data
  return { ...spaceLink(tab.instance, item), homepage: homepage ? pageLink(tab.instance, homepage) : null }
}

export async function browseTree(
  input: z.output<typeof treeArgs>,
  target: ConfluenceTab | undefined,
  signal?: AbortSignal,
) {
  const tab = requireTab(target)
  if (input.page && input.page.instance !== tab.instance.origin + tab.instance.path)
    refuse('This page reference belongs to a different Confluence instance.')

  const resource = input.page ? `content/${input.page.id}` : null
  const response = await getConfluence(tab, resource, { expand: 'ancestors' }, signal)
  const parsed = treePage.safeParse(response.data)
  if (!parsed.success || parsed.data.id !== (input.page?.id ?? response.pageId))
    refuse('Confluence did not return the requested published page.')

  const { items, ...next } = await collection(
    tab,
    `content/${parsed.data.id}/child/page`,
    {},
    input.start,
    publishedPage,
    signal,
  )
  const ancestors = parsed.data.ancestors.slice(-30)
  return {
    page: pageLink(tab.instance, parsed.data),
    ancestors: ancestors.map((ancestor) => pageLink(tab.instance, ancestor)),
    ancestorsTruncated: ancestors.length !== parsed.data.ancestors.length,
    children: items.map((child) => pageLink(tab.instance, child)),
    ...next,
  }
}
