import { z } from '../zod'
import { collection, collectionStart } from './collection'
import { requestedReference } from './page-writes'
import { readableText } from './readable-text'
import { fetchPublishedPage, pageLink, pageReference, publishedPage } from './references'
import { createConfluenceContent, getConfluence, refuse, requireTab, type ConfluenceTab } from './transport'

const contentId = pageReference.shape.id
const commentIdentity = z.object({ id: contentId, type: z.literal('comment'), status: z.literal('current') })
const comment = commentIdentity.extend({
  ancestors: z.array(z.object({ id: contentId, type: z.literal('comment') })).max(200),
  container: z.object({ id: contentId, type: z.literal('page') }),
  body: z.object({ storage: z.object({ value: z.string() }) }),
  extensions: z.object({ location: z.string().nullish(), inlineProperties: z.object({}).nullish() }).nullish(),
  history: z.object({ createdBy: z.object({ displayName: z.string().max(300).nullish() }).nullish() }).nullish(),
})
const fields = 'ancestors,container,body.storage,history,extensions.inlineProperties'
const textLimit = 2000
const escaped: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }

function commentStorage(text: string): string {
  return '<p>' + text.replace(/[&<>"]/g, (character) => escaped[character]).replace(/\n/g, '<br />') + '</p>'
}

function matchesCommentText(value: string, text: string): boolean {
  // Only the plain-text paragraph and line breaks we wrote can appear in a verified comment.
  if (!/^<p>(?:[^<]|<br\s*\/?>)*<\/p>$/u.test(value)) return false
  const template = document.createElement('template')
  template.innerHTML = value.slice(3, -4).replace(/<br\s*\/?>/g, '\n')
  return template.content.textContent === text
}

export const commentsArgs = z.strictObject({
  page: pageReference.optional().describe('Omit to use the current published page.'),
  start: collectionStart,
})

export interface CommentRequest {
  text: string
  targetUrl?: string
  parentId?: string
}

const addEnglish =
  /^(?:please\s+)?(?:add|post)\s+(?:a\s+)?(?:footer\s+)?comment\s+(?<text>"[^"]+"|“[^”]+”|`[^`]+`)\s+(?:on|to)\s+(?:this\s+page|(?<target>https?:\/\/[^\s]+?))[.!]?$/iu
const replyEnglish =
  /^(?:please\s+)?reply\s+to\s+comment\s+(?<parent>\d{1,20})\s+with\s+(?<text>"[^"]+"|“[^”]+”|`[^`]+`)\s+(?:on|to)\s+(?:this\s+page|(?<target>https?:\/\/[^\s]+?))[.!]?$/iu
const commentChinese =
  /^(?:请\s*)?在(?:当前页面?|本页|这页)(?:上)?\s*(?:评论|添加评论|回复评论\s*(?<parent>\d{1,20})\s*[：:]?)\s*(?<text>"[^"]+"|“[^”]+”|`[^`]+`)[。！!]?$/u

export function requestedComment(message: string): CommentRequest | undefined {
  const input = message.trim()
  const match = (addEnglish.exec(input) ?? replyEnglish.exec(input) ?? commentChinese.exec(input))?.groups
  if (!match) return undefined
  return { text: match.text.slice(1, -1).replace(/\r\n?/g, '\n'), targetUrl: match.target, parentId: match.parent }
}

function location(value: z.output<typeof comment>): 'footer' | 'inline' | 'unknown' {
  if (value.extensions?.location === 'footer') return 'footer'
  return value.extensions?.location === 'inline' || value.extensions?.inlineProperties ? 'inline' : 'unknown'
}

function summary(pageUrl: string, value: z.output<typeof comment>) {
  const text = readableText(value.body.storage.value)
  return {
    id: value.id,
    url: `${pageUrl}&focusedCommentId=${value.id}#comment-${value.id}`,
    parentId: value.ancestors[0]?.id ?? null,
    location: location(value),
    author: value.history?.createdBy?.displayName,
    text: text.slice(0, textLimit),
    truncated: text.length > textLimit,
  }
}

export async function listPageComments(
  args: z.output<typeof commentsArgs>,
  target: ConfluenceTab | undefined,
  signal?: AbortSignal,
) {
  const tab = requireTab(target)
  const page = await fetchPublishedPage(tab, args.page, publishedPage, 'version', signal)
  const link = pageLink(tab.instance, page)
  const { items, ...next } = await collection(
    tab,
    `content/${page.id}/child/comment`,
    { depth: 'all', expand: fields },
    args.start,
    comment,
    { signal },
  )
  if (items.some((item) => item.container.id !== page.id)) refuse('Confluence returned comments from a different page.')
  return { page: link, comments: items.map((item) => summary(link.url, item)), ...next }
}

async function readComment(tab: ConfluenceTab, id: string, pageId: string, signal?: AbortSignal) {
  const response = await getConfluence(tab, `content/${id}`, { expand: fields }, signal)
  const parsed = comment.safeParse(response.data)
  if (!parsed.success || parsed.data.id !== id || parsed.data.container.id !== pageId)
    refuse('Confluence did not return that comment on the intended page.')
  return parsed.data
}

export async function prepareComment(request: CommentRequest, target: ConfluenceTab | undefined, signal?: AbortSignal) {
  if (!request.text.trim() || request.text.length > 4000)
    refuse('Write a non-empty comment of at most 4,000 characters.')
  const tab = requireTab(target)
  const ref = requestedReference(tab, request.targetUrl)
  const page = await fetchPublishedPage(tab, ref, publishedPage, 'version', signal)
  const link = pageLink(tab.instance, page)
  const parent = request.parentId ? await readComment(tab, request.parentId, page.id, signal) : undefined
  if (parent && location(parent) !== 'footer') refuse('Replies can only be added to a verified footer comment.')
  const destination = `"${page.title}" (${link.url})`
  const heading = parent
    ? `Reply to comment ${parent.id} on ${destination}.\nParent: ${summary(link.url, parent).text}\n`
    : `Add a footer comment to ${destination}.\n`
  return { tab, ref, page, link, request, parent, preview: heading + `Comment: ${JSON.stringify(request.text)}` }
}

function unverified(): never {
  refuse('The comment may have been posted. Check the page discussion before asking again.', true)
}

export async function applyComment(plan: Awaited<ReturnType<typeof prepareComment>>, signal?: AbortSignal) {
  const { tab, ref, page, link, request, parent } = plan
  const current = await fetchPublishedPage(tab, ref, publishedPage, 'version', signal)
  if (current.id !== page.id || current.title !== page.title) refuse('The target page changed after the preview.')
  if (parent) {
    const currentParent = await readComment(tab, parent.id, page.id, signal)
    if (location(currentParent) !== 'footer' || currentParent.body.storage.value !== parent.body.storage.value)
      refuse('The parent comment changed after the preview. Review it and ask again.')
  }
  const value = commentStorage(request.text)
  const created = await createConfluenceContent(
    tab,
    {
      type: 'comment',
      container: { id: page.id, type: 'page' },
      ...(parent && { ancestors: [{ id: parent.id, type: 'comment' }] }),
      body: { storage: { value, representation: 'storage' } },
    },
    signal,
  )
  const identity = commentIdentity.safeParse(created.data)
  if (!identity.success) unverified()
  let verified: z.output<typeof comment>
  try {
    verified = await readComment(tab, identity.data.id, page.id, signal)
  } catch {
    unverified()
  }
  if (
    location(verified) !== 'footer' ||
    verified.ancestors[0]?.id !== parent?.id ||
    !matchesCommentText(verified.body.storage.value, request.text)
  )
    unverified()
  const { text: _text, ...result } = summary(link.url, verified)
  return { page: link, comment: result, changed: true }
}
