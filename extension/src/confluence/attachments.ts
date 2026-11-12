import { z } from '../zod'
import { collection, collectionStart } from './collection'
import { parseInstance, type Instance } from './instance'
import { fetchPublishedPage, pageLink, pageReference, publishedPage } from './references'
import {
  attachmentSizeLimit,
  getConfluence,
  refuse,
  requireTab,
  uploadConfluenceAttachment,
  type ConfluenceTab,
} from './transport'

const filename = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (value) => value !== '.' && value !== '..' && !/[/\\\p{Cc}]/u.test(value),
    'Use a filename without path separators or control characters.',
  )
const versionNumber = z.int().min(1).max(2_147_483_647)
const attachmentIdentity = z.object({
  id: z.string().regex(/^(?:att)?\d{1,20}$/),
  type: z.literal('attachment'),
  status: z.literal('current'),
})
const attachment = attachmentIdentity.extend({
  title: filename,
  container: z.object({ id: pageReference.shape.id, type: z.literal('page') }),
  version: z.object({ number: versionNumber }),
  extensions: z.object({ fileSize: z.int().nonnegative().optional() }).optional(),
  _links: z.object({ download: z.string().min(1).max(4096).optional() }).optional(),
})
type Attachment = z.output<typeof attachment>
const postedAttachment = z.union([attachmentIdentity, z.object({ results: z.tuple([attachmentIdentity]) })])
const fields = 'version,container'
const attachmentResource = (pageId: string) => `content/${pageId}/child/attachment`

export const attachmentsArgs = z.strictObject({
  page: pageReference.optional().describe('Omit to use the current published page.'),
  filename: filename.optional().describe('An exact filename to find. Omit to list all attachments.'),
  start: collectionStart,
})

export interface AttachmentUpload {
  file: File
  mode: 'create' | 'replace'
}

function downloadUrl(instance: Instance, pageId: string, name: string, version: number, link?: string) {
  if (!link) return
  try {
    const base = instance.origin + instance.path
    const url = new URL(link, base + '/')
    if (url.origin !== instance.origin || url.username || url.password || url.hash) return
    const suffix = `/download/attachments/${pageId}/`
    const prefix = url.pathname.startsWith(instance.path + suffix) ? instance.path + suffix : suffix
    if (!url.pathname.startsWith(prefix)) return
    const segment = url.pathname.slice(prefix.length)
    if (decodeURIComponent(segment) !== name && decodeURIComponent(segment.replace(/\+/g, ' ')) !== name) return
    return `${base}${suffix}${encodeURIComponent(name)}?version=${version}&download=true`
  } catch {
    return undefined
  }
}

function summary(instance: Instance, pageId: string, value: Attachment) {
  return {
    id: value.id,
    filename: value.title,
    version: value.version.number,
    bytes: value.extensions?.fileSize,
    downloadUrl: downloadUrl(instance, pageId, value.title, value.version.number, value._links?.download),
  }
}

const listedDownloads = z.object({
  page: z.object({ ref: pageReference }),
  attachments: z
    .array(
      z.object({
        filename,
        version: versionNumber,
        downloadUrl: z.string().max(4096).optional(),
      }),
    )
    .max(50),
})

export function attachmentDownloads(result: string) {
  try {
    const data: unknown = JSON.parse(result)
    const parsed = listedDownloads.safeParse(data)
    if (!parsed.success) return []
    const { instance: base, id } = parsed.data.page.ref
    const instance = parseInstance(base)
    if (!instance) return []
    return parsed.data.attachments.flatMap(({ filename, version, downloadUrl: link }) => {
      const url = downloadUrl(instance, id, filename, version, link)
      return url ? [{ name: filename, url }] : []
    })
  } catch {
    return []
  }
}

export async function listPageAttachments(
  args: z.output<typeof attachmentsArgs>,
  target: ConfluenceTab | undefined,
  signal?: AbortSignal,
) {
  const tab = requireTab(target)
  const page = await fetchPublishedPage(tab, args.page, publishedPage, 'version', signal)
  const { items, ...next } = await collection(
    tab,
    attachmentResource(page.id),
    { expand: fields, ...(args.filename && { filename: args.filename }) },
    args.start,
    attachment,
    { signal },
  )
  if (items.some((item) => item.container.id !== page.id || (args.filename && item.title !== args.filename)))
    refuse('Confluence returned attachments outside the requested page or filename.')
  return {
    page: pageLink(tab.instance, page),
    attachments: items.map((item) => summary(tab.instance, page.id, item)),
    ...next,
  }
}

async function findAttachment(tab: ConfluenceTab, pageId: string, name: string, signal?: AbortSignal) {
  const response = await getConfluence(
    tab,
    attachmentResource(pageId),
    { expand: fields, filename: name, limit: '2' },
    signal,
  )
  const parsed = z
    .object({
      results: z.array(attachment).max(1),
      _links: z.object({ next: z.string().optional() }).optional(),
    })
    .safeParse(response.data)
  if (
    !parsed.success ||
    parsed.data._links?.next ||
    parsed.data.results.some((item) => item.container.id !== pageId || item.title !== name)
  )
    refuse('Confluence did not return an unambiguous attachment match on the intended page.')
  return parsed.data.results[0]
}

export async function prepareAttachmentUpload(
  upload: AttachmentUpload,
  target: ConfluenceTab | undefined,
  signal?: AbortSignal,
) {
  const { file, mode } = upload
  if (!filename.safeParse(file.name).success) refuse('Choose a file with a valid attachment filename.')
  if (file.size > attachmentSizeLimit) refuse('Choose an attachment of at most 10 MiB.')
  const tab = requireTab(target)
  const page = await fetchPublishedPage(tab, undefined, publishedPage, 'version', signal)
  const link = pageLink(tab.instance, page)
  const existing = await findAttachment(tab, page.id, file.name, signal)
  if (existing && mode === 'create')
    refuse('An attachment with that name already exists. Choose Replace attachment to update it.')
  if (!existing && mode === 'replace')
    refuse('There is no attachment with that name to replace. Choose Upload attachment to add it.')
  const targetName = `${JSON.stringify(page.title)} (${link.url})`
  const fileName = `${JSON.stringify(file.name)} (${file.size} bytes)`
  const preview = existing
    ? `Replace version ${existing.version.number} of attachment ${fileName} on ${targetName} with the selected file.`
    : `Upload attachment ${fileName} to ${targetName}.`
  return { tab, page, link, file, existing, preview }
}

function unverified(): never {
  refuse('Confluence may have uploaded the file. Check the page attachments before asking again.', true)
}

export async function applyAttachmentUpload(
  plan: Awaited<ReturnType<typeof prepareAttachmentUpload>>,
  signal?: AbortSignal,
) {
  const { tab, page, link, file, existing } = plan
  const currentPage = await fetchPublishedPage(tab, link.ref, publishedPage, 'version', signal)
  if (currentPage.title !== page.title) refuse('The destination page changed after the preview.')
  const current = await findAttachment(tab, page.id, file.name, signal)
  if (current?.id !== existing?.id || current?.version.number !== existing?.version.number)
    refuse('The attachment changed after the preview. Review it and choose the file again.')
  const version = (existing?.version.number ?? 0) + 1
  if (!versionNumber.safeParse(version).success) refuse('The attachment cannot be advanced to another version.')
  const response = await uploadConfluenceAttachment(tab, page.id, existing?.id, file, signal)
  const posted = postedAttachment.safeParse(response.data)
  if (!posted.success) unverified()
  const id = 'results' in posted.data ? posted.data.results[0].id : posted.data.id
  const verified = await findAttachment(tab, page.id, file.name, signal).catch(unverified)
  if (
    !verified ||
    verified.id !== id ||
    (existing && id !== existing.id) ||
    verified.version.number !== version ||
    (verified.extensions?.fileSize !== undefined && verified.extensions.fileSize !== file.size)
  )
    unverified()
  return { page: link, attachment: summary(tab.instance, page.id, verified), changed: true }
}
