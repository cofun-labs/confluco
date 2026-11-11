import { z } from '../zod'
import { collection, collectionStart } from './collection'
import type { Instance } from './instance'
import { readableText } from './readable-text'
import { fetchPublishedPage, pageLink, pageReference, publishedPage } from './references'
import { getConfluence, refuse, requireTab, type ConfluenceTab } from './transport'

const spaceKey = z
  .string()
  .regex(/^(?:~[^\p{C}/\\%;?#]+|[a-zA-Z0-9][a-zA-Z0-9_-]*)$/u)
  .max(255)

export const searchArgs = z.strictObject({
  query: z.string().trim().min(1).max(200).describe('Text to find in published pages.'),
  field: z.enum(['text', 'title']).default('text').describe('Search the full page or only its title.'),
  spaceKey: spaceKey.optional().describe('Restrict the search to this space key.'),
  start: collectionStart,
})
export const listSpacesArgs = z.strictObject({ start: collectionStart })
export const spaceArgs = z.strictObject({ key: spaceKey.describe('The space key, including ~ for a personal space.') })
export const treeArgs = z.strictObject({
  page: pageReference.optional().describe('Omit to browse the published page in the active tab.'),
  start: collectionStart,
})

const space = z.object({ key: spaceKey, name: z.string().trim().min(1).max(1000) })
const searchHit = z.object({ content: publishedPage, excerpt: z.string().max(16_000).optional() })
const spaceDetail = space.extend({ homepage: publishedPage.nullish() })
const treePage = publishedPage.extend({ ancestors: z.array(publishedPage) })

function cqlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function spaceLink(instance: Instance, value: z.infer<typeof space>) {
  return {
    ...value,
    url: `${instance.origin}${instance.path}/display/${encodeURIComponent(value.key)}`,
  }
}

export async function searchPages(
  input: z.output<typeof searchArgs>,
  target: ConfluenceTab | undefined,
  signal?: AbortSignal,
) {
  const tab = requireTab(target)
  const spaceFilter = input.spaceKey ? ` AND space = ${cqlString(input.spaceKey)}` : ''
  const cql = `type = page AND ${input.field} ~ ${cqlString(input.query.replace(/\s+/g, ' '))}${spaceFilter}`
  const { items, ...next } = await collection(tab, 'search', { cql }, input.start, searchHit, { signal })
  const results = items.map(({ content, excerpt }) => ({
    ...pageLink(tab.instance, content),
    ...(excerpt && { excerpt: readableText(excerpt.replace(/@@@(?:end)?hl@@@/gi, '')).slice(0, 320) }),
  }))
  return { results, ...next }
}

export async function listSpaces(offset: number, target: ConfluenceTab | undefined, signal?: AbortSignal) {
  const tab = requireTab(target)
  const { items, ...next } = await collection(tab, 'space', {}, offset, space, { signal })
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
  const page = await fetchPublishedPage(tab, input.page, treePage, 'ancestors', signal)

  const { items, ...next } = await collection(tab, `content/${page.id}/child/page`, {}, input.start, publishedPage, {
    signal,
  })
  const ancestors = page.ancestors.slice(-30)
  return {
    page: pageLink(tab.instance, page),
    ancestors: ancestors.map((ancestor) => pageLink(tab.instance, ancestor)),
    ancestorsTruncated: ancestors.length !== page.ancestors.length,
    children: items.map((child) => pageLink(tab.instance, child)),
    ...next,
  }
}
