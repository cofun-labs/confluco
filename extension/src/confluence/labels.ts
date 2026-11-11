import { z } from '../zod'
import { collection, collectionStart } from './collection'
import { fetchPublishedPage, pageLink, pageReference, publishedPage, type PublishedPage } from './references'
import { refuse, requireTab, writeConfluenceLabel, type ConfluenceTab } from './transport'

const reference = pageReference.optional().describe('Omit to use the current published page.')
export const labelsArgs = z.strictObject({ page: reference, start: collectionStart })
export const changeLabelArgs = z.strictObject({
  page: reference,
  action: z.enum(['add', 'remove']),
  label: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .regex(/^[^\s\p{C}:]+$/u)
    .describe('An ordinary page label, without a prefix or spaces.'),
})

const label = z.object({ prefix: z.string().max(40), name: z.string().min(1).max(255) })

interface LabelTarget {
  tab: ConfluenceTab
  page: PublishedPage
  name: string
}

export async function listLabels(
  input: z.output<typeof labelsArgs>,
  target: ConfluenceTab | undefined,
  signal?: AbortSignal,
) {
  const tab = requireTab(target)
  const page = await fetchPublishedPage(tab, input.page, publishedPage, '', signal)
  const { items, ...next } = await collection(tab, `content/${page.id}/label`, {}, input.start, label, { signal })
  return { page: pageLink(tab.instance, page), labels: items, ...next }
}

async function hasLabel(change: LabelTarget, signal?: AbortSignal) {
  let start = 0
  for (let page = 0; page < 4; page++) {
    const { items, nextStart, paginationNotice } = await collection(
      change.tab,
      `content/${change.page.id}/label`,
      { prefix: 'global' },
      start,
      label,
      { signal, limit: 100 },
    )
    if (items.some((item) => item.prefix === 'global' && item.name === change.name)) return true
    if (paginationNotice) break
    if (nextStart === undefined) return false
    start = nextStart
  }
  refuse('Confluco could not check the requested label within its read limit.')
}

export async function applyLabel(
  input: z.output<typeof changeLabelArgs>,
  target: ConfluenceTab | undefined,
  signal?: AbortSignal,
) {
  const tab = requireTab(target)
  const page = await fetchPublishedPage(tab, input.page, publishedPage, '', signal)
  const name = input.label.toLowerCase()
  const change = { tab, page, name }
  const expected = input.action === 'add'
  const before = await hasLabel(change, signal)
  const result = { page: pageLink(tab.instance, page), label: name, present: expected }
  if (before === expected) return { ...result, changed: false }

  const current = await fetchPublishedPage(tab, input.page, publishedPage, '', signal)
  if (current.id !== page.id)
    refuse('The page changed before the label could be updated. Ask again on the intended page.')
  await writeConfluenceLabel(
    tab,
    page.id,
    expected ? { method: 'POST', body: [{ prefix: 'global', name }] } : { method: 'DELETE', query: { name } },
    signal,
  )
  try {
    if ((await hasLabel(change, signal)) === expected) return { ...result, changed: true }
  } catch {
    refuse(
      'The label change may have been applied, but its result could not be verified. Check the page before trying again.',
      true,
    )
  }
  refuse('Confluence did not confirm the expected label state. Check the page before trying again.', true)
}
