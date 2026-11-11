import { z } from '../zod'
import type { Instance } from './instance'
import { getConfluence, refuse, restUrl, type ConfluenceTab, type RestArea } from './transport'

const maxStart = 990
export const collectionStart = z
  .int()
  .min(0)
  .max(maxStart)
  .default(0)
  .describe('Omit on the first call. Use the returned nextStart.')

export async function collection<S extends z.ZodType>(
  tab: ConfluenceTab,
  resource: string,
  query: Record<string, string>,
  offset: number,
  item: S,
  { signal, area = 'api', limit = 10 }: { signal?: AbortSignal; area?: RestArea; limit?: number } = {},
) {
  const params = { ...query, start: String(offset), limit: String(limit) }
  const response = await getConfluence(tab, resource, params, signal, area)
  const schema = z.object({
    results: z.array(item).max(limit),
    _links: z.object({ next: z.string().max(4096).optional() }).optional(),
  })
  const parsed = schema.safeParse(response.data)
  if (!parsed.success) refuse('Confluence did not return the expected results.')
  const next = parsed.data._links?.next
  const request = restUrl(tab.instance, resource, params, area)
  return { items: parsed.data.results, ...pagination(tab.instance, request, next, offset, limit) }
}

/** Read an offset from the response link. The next request always uses the original API and filters. */
function pagination(
  instance: Instance,
  request: URL,
  next: string | undefined,
  offset: number,
  limit: number,
): { nextStart?: number; paginationNotice?: string } {
  if (next === undefined) return {}
  const invalid = { paginationNotice: 'Confluence returned an invalid next page link.' }
  let url: URL
  try {
    // Confluence can return an API-relative path without the deployment context.
    url = /^\/rest\/(?:api|experimental)\//.test(next)
      ? new URL(instance.origin + instance.path + next)
      : new URL(next, request)
  } catch {
    return invalid
  }
  if (url.origin !== request.origin || url.pathname !== request.pathname || url.username || url.password || url.hash)
    return invalid
  const [value, ...duplicate] = url.searchParams.getAll('start')
  if (value === undefined || duplicate.length || !/^\d+$/.test(value)) return invalid
  const nextStart = Number(value)
  if (nextStart <= offset || nextStart > offset + limit) return invalid
  if (nextStart > maxStart) return { paginationNotice: 'The result limit was reached. Refine the request for more.' }
  return { nextStart }
}
