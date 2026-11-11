import { z } from '../zod'
import { readableText } from './readable-text'
import { fetchPublishedPage, pageLink, publishedPage } from './references'
import { requireTab, type ConfluenceTab } from './transport'

const page = publishedPage.extend({
  body: z.object({ view: z.object({ value: z.string() }) }),
})

export async function readPage(tab: ConfluenceTab | undefined, signal?: AbortSignal) {
  const target = requireTab(tab)
  const published = await fetchPublishedPage(target, undefined, page, 'body.view', signal)
  const text = readableText(published.body.view.value)
  const limit = 12_000
  return {
    ...pageLink(target.instance, published),
    text: text.slice(0, limit),
    truncated: text.length > limit,
  }
}
