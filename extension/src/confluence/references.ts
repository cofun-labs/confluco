import { z } from '../zod'
import type { Instance } from './instance'
import { getConfluence, refuse, type ConfluenceTab } from './transport'

const pageId = z.string().regex(/^\d{1,20}$/)

export const pageReference = z.strictObject({
  instance: z.string().min(1).max(2048).describe('The instance base URL from the page reference.'),
  id: pageId.describe('The page ID from the same reference.'),
})
export type PageReference = z.output<typeof pageReference>

export const publishedPage = z.object({
  id: pageId,
  type: z.literal('page'),
  status: z.literal('current'),
  title: z.string().trim().min(1).max(1000),
})
export type PublishedPage = z.output<typeof publishedPage>

export function pageLink(instance: Instance, page: Pick<PublishedPage, 'id' | 'title'>) {
  const base = instance.origin + instance.path
  return {
    title: page.title,
    url: `${base}/pages/viewpage.action?pageId=${page.id}`,
    ref: { instance: base, id: page.id },
  }
}

export function pageResource(tab: ConfluenceTab, reference: PageReference | undefined): string | null {
  if (!reference) return null
  if (reference.instance !== tab.instance.origin + tab.instance.path)
    refuse('This page reference belongs to a different Confluence instance.')
  return `content/${reference.id}`
}

export async function fetchPublishedPage<S extends z.ZodType<PublishedPage>>(
  tab: ConfluenceTab,
  reference: PageReference | undefined,
  schema: S,
  expand: string,
  signal?: AbortSignal,
): Promise<z.output<S>> {
  const response = await getConfluence(tab, pageResource(tab, reference), { expand }, signal)
  const parsed = schema.safeParse(response.data)
  if (!parsed.success || parsed.data.id !== (reference?.id ?? response.pageId))
    refuse('Confluence did not return the expected published page.')
  return parsed.data
}
