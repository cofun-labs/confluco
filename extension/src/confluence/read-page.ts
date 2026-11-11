import { z } from '../zod'
import { readableText } from './readable-text'
import { pageLink, publishedPage } from './references'
import { getConfluence, refuse, requireTab, type ConfluenceTab } from './transport'

const page = publishedPage.extend({
  body: z.object({ view: z.object({ value: z.string() }) }),
})

export async function readPage(tab: ConfluenceTab | undefined, signal?: AbortSignal) {
  const target = requireTab(tab)
  const response = await getConfluence(target, null, { expand: 'body.view' }, signal)
  const parsed = page.safeParse(response.data)
  if (!parsed.success || parsed.data.id !== response.pageId)
    refuse('Confluence did not return the expected published page.')
  const text = readableText(parsed.data.body.view.value)
  const limit = 12_000
  return {
    ...pageLink(target.instance, parsed.data),
    text: text.slice(0, limit),
    truncated: text.length > limit,
  }
}
