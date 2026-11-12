import { z } from '../zod'
import { hasRestriction, restrictions } from './history'
import { requestedReference } from './page-writes'
import { pageLink, pageReference, pageResource, publishedPage, type PageReference } from './references'
import {
  getConfluence,
  refuse,
  requireTab,
  restoreConfluencePage,
  trashConfluencePage,
  type ConfluenceTab,
} from './transport'

const version = z.int().min(1).max(2_147_483_647)
const pageState = publishedPage.extend({
  status: z.enum(['current', 'trashed']),
  version: z.object({ number: version }),
  space: z.object({ key: z.string().min(1).max(255) }),
  ancestors: z.array(z.object({ id: pageReference.shape.id })),
})
type PageState = z.output<typeof pageState>
export type PageStatusRequest = { action: 'trash' | 'restore'; targetUrl?: string }
export const pageTrashUndo = z.strictObject({ kind: z.literal('trash'), page: pageReference, version })
export type PageTrashUndo = z.output<typeof pageTrashUndo>

const trashEnglish =
  /^(?:please\s+)?(?:trash\s+(?:page\s+)?(?:this\s+page|(?<target>https?:\/\/[^\s]+?))|move\s+this\s+page\s+to\s+(?:the\s+)?trash)[.!]?$/iu
const restoreEnglish = /^(?:please\s+)?restore\s+(?:page\s+)?(?<target>https?:\/\/[^\s]+?)[.!]?$/iu
const trashChinese = /^(?:请\s*)?(?:把|将)(?:当前页面?|本页|这页)(?:移动|移入|放入)(?:到)?回收站[。！!]?$/u
const restoreChinese = /^(?:请\s*)?恢复(?:页面)?\s*(?<target>https?:\/\/[^\s]+?)[。！!]?$/u

export function requestedPageStatus(message: string): PageStatusRequest | undefined {
  const text = message.trim()
  const trash = trashEnglish.exec(text) ?? trashChinese.exec(text)
  if (trash) return { action: 'trash', targetUrl: trash.groups?.target }
  const restore = (restoreEnglish.exec(text) ?? restoreChinese.exec(text))?.groups
  if (restore) return { action: 'restore', targetUrl: restore.target }
  return undefined
}

async function readState(tab: ConfluenceTab, ref: PageReference | undefined, signal?: AbortSignal) {
  const response = await getConfluence(
    tab,
    pageResource(tab, ref),
    { status: 'any', expand: 'version,space,ancestors' },
    signal,
  )
  const parsed = pageState.safeParse(response.data)
  if (!parsed.success || parsed.data.id !== (ref?.id ?? response.pageId))
    refuse('Confluence did not return the expected published or trashed page.')
  return parsed.data
}

async function requireEligibleTrash(tab: ConfluenceTab, page: PageState, signal?: AbortSignal) {
  if (!page.ancestors.length) refuse('Use Confluence to manage top-level pages in the trash.')
  const response = await getConfluence(tab, `content/${page.id}/child/page`, { limit: '1' }, signal)
  const parsed = z
    .object({
      results: z.array(z.unknown()).max(1),
      _links: z.object({ next: z.string().optional() }).optional(),
    })
    .safeParse(response.data)
  if (!parsed.success) refuse('Confluence did not report whether this page has children.')
  if (parsed.data.results.length || parsed.data._links?.next)
    refuse('This page has child pages. Use Confluence to review how they will be affected before trashing it.')
  for (const { id } of [...page.ancestors, page]) {
    const response = await getConfluence(tab, `content/${id}/restriction/byOperation`, {}, signal)
    const access = restrictions.safeParse(response.data)
    if (!access.success || hasRestriction(access.data.read) || (id === page.id && hasRestriction(access.data.update)))
      refuse('This page could lose an access restriction on restore. Review its access in Confluence.')
  }
}

export async function preparePageStatus(
  request: PageStatusRequest,
  target: ConfluenceTab | undefined,
  signal?: AbortSignal,
  undo?: PageTrashUndo,
) {
  const tab = requireTab(target)
  const ref = undo?.page ?? requestedReference(tab, request.targetUrl)
  if (!ref && request.action === 'restore') refuse('Use the canonical link of the trashed page to restore it.')
  const page = await readState(tab, ref, signal)
  if (undo && (page.status !== 'trashed' || page.version.number !== undo.version))
    refuse('The page state changed after the last trash action. Review the page before restoring it.')
  if (request.action === 'trash' && page.status === 'current') await requireEligibleTrash(tab, page, signal)
  const link = pageLink(tab.instance, page)
  const name = `"${page.title}" (${link.url}) in space ${page.space.key}`
  return {
    tab,
    ref: link.ref,
    page,
    action: request.action,
    preview:
      request.action === 'trash'
        ? `Move ${name} to the recoverable trash. Confluence restores pages at the space root and may move child pages that your account cannot see.`
        : `Restore ${name} from the trash at the space root.${undo ? '' : ' Review who can access the page there before allowing this change.'}`,
  }
}

function samePage(left: PageState, right: PageState): boolean {
  return left.id === right.id && left.title === right.title && left.space.key === right.space.key
}

export async function applyPageStatus(plan: Awaited<ReturnType<typeof preparePageStatus>>, signal?: AbortSignal) {
  const { tab, ref, page, action } = plan
  const current = await readState(tab, ref, signal)
  if (
    !samePage(current, page) ||
    current.status !== page.status ||
    current.version.number !== page.version.number ||
    current.ancestors.map(({ id }) => id).join('/') !== page.ancestors.map(({ id }) => id).join('/')
  )
    refuse('The page changed after the preview. Review its current state and ask again.')
  const desired = action === 'trash' ? 'trashed' : 'current'
  if (current.status === desired)
    return { page: pageLink(tab.instance, current), status: desired, version: current.version.number, changed: false }
  const nextVersion = action === 'restore' ? current.version.number + 1 : current.version.number
  if (nextVersion > 2_147_483_647) refuse('This Confluence page cannot be advanced to another version.')
  if (action === 'trash') await requireEligibleTrash(tab, current, signal)
  try {
    if (action === 'trash') await trashConfluencePage(tab, current.id, signal)
    else await restoreConfluencePage(tab, current.id, nextVersion, signal)
  } catch (error) {
    if (signal?.aborted || !(error instanceof Error) || !('mayHaveChanged' in error) || error.mayHaveChanged !== true)
      throw error
  }
  const unverified = () =>
    refuse('The page state may have changed. Check the page or space trash before asking again.', true)
  const verified = await readState(tab, ref, signal).catch(unverified)
  // Confluence 8.5 accepts the next version in the restore request, but can retain the current number.
  const verifiedVersion = verified.version.number
  if (
    !samePage(verified, current) ||
    verified.status !== desired ||
    (verifiedVersion !== nextVersion && verifiedVersion !== current.version.number)
  )
    unverified()
  return {
    page: pageLink(tab.instance, verified),
    status: desired,
    version: verifiedVersion,
    changed: true,
    ...(action === 'restore' && { atSpaceRoot: verified.ancestors.length === 0 }),
  }
}
