import { z } from '../zod'
import {
  findTitleInSpace,
  readWrittenPage,
  requestedReference,
  samePageLocation,
  storedFields,
  storedPage,
  title,
  unverifiedWrite,
} from './page-writes'
import { fetchPublishedPage, pageLink, publishedPage } from './references'
import {
  createConfluencePage,
  getConfluence,
  refuse,
  requireTab,
  updateConfluencePage,
  type ConfluenceTab,
} from './transport'

type Source = z.output<typeof storedPage>
const parentPage = storedPage.pick({ id: true, type: true, status: true, title: true, space: true, ancestors: true })
type Parent = z.output<typeof parentPage>
type OrganizationTarget = { sourceUrl?: string; destinationUrl: string }
export type OrganizationRequest = OrganizationTarget & ({ action: 'move' } | { action: 'copy'; title: string })

const moveEnglish =
  /^(?:please\s+)?move\s+(?:this\s+page|(?<source>https?:\/\/[^\s]+))\s+under\s+(?<destination>https?:\/\/[^\s]+?)[.!]?$/iu
const copyEnglish =
  /^(?:please\s+)?copy\s+(?:this\s+page|(?<source>https?:\/\/[^\s]+))\s+under\s+(?<destination>https?:\/\/[^\s]+)\s+as\s+(?<title>"[^"\r\n]+"|“[^”\r\n]+”|`[^`\r\n]+`)[.!]?$/iu
const moveChinese =
  /^(?:请\s*)?(?:把|将)(?:当前页面?|本页|这页)移动到\s*(?<destination>https?:\/\/[^\s]+?)(?:\s*下)?[。！!]?$/u
const copyChinese =
  /^(?:请\s*)?(?:把|将)(?:当前页面?|本页|这页)复制到\s*(?<destination>https?:\/\/[^\s]+?)\s*(?:下)?[，,]?\s*(?:命名为|标题为)\s*(?<title>"[^"\r\n]+"|“[^”\r\n]+”|`[^`\r\n]+`)[。！!]?$/u

export function requestedOrganization(message: string): OrganizationRequest | undefined {
  const text = message.trim()
  const copy = (copyEnglish.exec(text) ?? copyChinese.exec(text))?.groups
  if (copy) {
    const parsed = title.safeParse(copy.title.slice(1, -1))
    if (!parsed.success) return undefined
    return { action: 'copy', title: parsed.data, destinationUrl: copy.destination, sourceUrl: copy.source }
  }
  const move = (moveEnglish.exec(text) ?? moveChinese.exec(text))?.groups
  if (move) return { action: 'move', destinationUrl: move.destination, sourceUrl: move.source }
  return undefined
}

const subjects = z.object({
  results: z.array(z.unknown()),
  size: z.int().min(0).optional(),
  _links: z.object({ next: z.string().optional() }).optional(),
})
const operation = z.object({ restrictions: z.object({ user: subjects, group: subjects }) })
const restrictions = z.object({ read: operation, update: operation })

function restricted({ restrictions }: z.output<typeof operation>): boolean {
  return [restrictions.user, restrictions.group].some(({ results, size, _links }) =>
    Boolean(results.length || size || _links?.next),
  )
}

function lineage(parent: Parent) {
  return [...parent.ancestors, { id: parent.id }]
}

async function requireCompatibleAccess(
  tab: ConfluenceTab,
  source: Source,
  parent: Parent,
  request: OrganizationRequest,
  signal?: AbortSignal,
) {
  const retained = new Set(lineage(parent).map(({ id }) => id))
  const omitted = source.ancestors.filter(({ id }) => !retained.has(id)).map(({ id }) => id)
  if (request.action === 'copy') omitted.push(source.id)
  for (const id of new Set(omitted)) {
    const response = await getConfluence(tab, `content/${id}/restriction/byOperation`, {}, signal)
    const parsed = restrictions.safeParse(response.data)
    if (!parsed.success)
      refuse('Confluence did not report restrictions on the source or an ancestor. Check access before trying again.')
    if (restricted(parsed.data.read) || (id === source.id && restricted(parsed.data.update)))
      refuse('This destination could drop an existing page restriction. Choose a destination with the same access.')
  }
}

async function requireBodyOnlyCopy(tab: ConfluenceTab, source: Source, signal?: AbortSignal) {
  if (/<(?:ri:attachment|ac:inline-comment-marker)(?:\s|\/?>)/i.test(source.body.storage.value))
    refuse('This page uses attachment or inline comment references. Use Confluence to copy those with the page.')
  const response = await getConfluence(tab, `content/${source.id}/child/attachment`, { limit: '1' }, signal)
  const parsed = z.object({ results: z.array(z.unknown()) }).safeParse(response.data)
  if (!parsed.success) refuse('Confluence did not report whether the page has attachments.')
  if (parsed.data.results.length)
    refuse('This page has attachments. Use Confluence to copy the page with its attachments.')
}

export async function prepareOrganization(
  request: OrganizationRequest,
  target: ConfluenceTab | undefined,
  signal?: AbortSignal,
) {
  const tab = requireTab(target)
  const sourceRef = requestedReference(tab, request.sourceUrl)
  const parentRef = requestedReference(tab, request.destinationUrl)
  const source = await fetchPublishedPage(tab, sourceRef, storedPage, storedFields, signal)
  const parent = await fetchPublishedPage(tab, parentRef, parentPage, 'space,ancestors', signal)
  if (source.space.key !== parent.space.key) refuse('Choose a destination in the same Confluence space.')
  if (request.action === 'move') {
    if (!source.ancestors.length) refuse('Move a page with an existing parent. Use Confluence for top-level pages.')
    if (lineage(parent).some(({ id }) => id === source.id))
      refuse('A page cannot be moved under itself or its descendants.')
  } else await requireBodyOnlyCopy(tab, source, signal)
  await requireCompatibleAccess(tab, source, parent, request, signal)
  const from = pageLink(tab.instance, source)
  const to = pageLink(tab.instance, parent)
  const preview =
    request.action === 'move'
      ? `Move "${from.title}" (${from.url}) and its children under "${to.title}" (${to.url}) in space ${source.space.key}.`
      : `Copy the body of "${from.title}" (${from.url}) under "${to.title}" (${to.url}) as "${request.title}". The copy is one page with its own history, comments and properties.`
  return { tab, request, sourceRef, parentRef, source, parent, preview }
}

export async function applyOrganization(plan: Awaited<ReturnType<typeof prepareOrganization>>, signal?: AbortSignal) {
  const { tab, request, sourceRef, parentRef, source, parent } = plan
  const current = await fetchPublishedPage(tab, sourceRef, storedPage, storedFields, signal)
  const destination = await fetchPublishedPage(tab, parentRef, parentPage, 'space,ancestors', signal)
  if (
    !samePageLocation(current, source) ||
    !samePageLocation(destination, parent) ||
    current.version.number !== source.version.number ||
    current.body.storage.value !== source.body.storage.value
  )
    refuse('The source or destination changed after the preview. Review both pages and ask again.')
  const parentLink = pageLink(tab.instance, destination)
  const expected = { ...source, ancestors: lineage(destination) }
  const ancestors = [{ id: destination.id }]
  await requireCompatibleAccess(tab, current, destination, request, signal)

  if (request.action === 'copy') {
    await requireBodyOnlyCopy(tab, current, signal)
    const existing = await findTitleInSpace(tab, request.title, destination.space.key, signal)
    if (existing) refuse('A page with that title already exists in the destination space. Choose a different title.')
    const response = await createConfluencePage(
      tab,
      { type: 'page', title: request.title, space: destination.space, ancestors, body: source.body },
      signal,
    )
    const created = publishedPage.safeParse(response.data)
    if (!created.success || created.data.id === source.id) unverifiedWrite()
    const verified = await readWrittenPage(tab, created.data.id, signal)
    if (
      !samePageLocation(verified, { ...expected, id: created.data.id, title: request.title }) ||
      verified.version.number !== 1 ||
      verified.body.storage.value !== source.body.storage.value
    )
      unverifiedWrite()
    return { page: pageLink(tab.instance, verified), parent: parentLink, version: 1, changed: true }
  }

  if (source.ancestors.at(-1)?.id === parent.id)
    return { page: pageLink(tab.instance, source), parent: parentLink, changed: false }
  if (source.version.number === 2_147_483_647) refuse('This Confluence page cannot be advanced to another version.')
  const version = source.version.number + 1
  await updateConfluencePage(
    tab,
    source.id,
    {
      type: 'page',
      title: source.title,
      space: source.space,
      version: { number: version },
      ancestors,
      body: source.body,
    },
    signal,
  )
  const verified = await readWrittenPage(tab, source.id, signal)
  if (
    !samePageLocation(verified, expected) ||
    verified.version.number !== version ||
    verified.body.storage.value !== source.body.storage.value
  )
    unverifiedWrite()
  return { page: pageLink(tab.instance, verified), parent: parentLink, version, changed: true }
}
