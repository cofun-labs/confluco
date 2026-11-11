import { z } from '../zod'
import type { Instance } from './instance'

const pageId = z.string().regex(/^\d{1,20}$/)

export const pageReference = z.strictObject({
  instance: z.string().min(1).max(2048).describe('The instance base URL from the page reference.'),
  id: pageId.describe('The page ID from the same reference.'),
})

export const publishedPage = z.object({
  id: pageId,
  type: z.literal('page'),
  status: z.literal('current'),
  title: z.string().trim().min(1).max(1000),
})

export function pageLink(instance: Instance, page: z.infer<typeof publishedPage>) {
  const base = instance.origin + instance.path
  return {
    title: page.title,
    url: `${base}/pages/viewpage.action?pageId=${page.id}`,
    ref: { instance: base, id: page.id },
  }
}
