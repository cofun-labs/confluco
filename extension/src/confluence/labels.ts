import { z } from '../zod'
import { collection, collectionStart } from './collection'
import { fetchPublishedPage, pageLink, pageReference, publishedPage, type PublishedPage } from './references'
import { refuse, requireTab, writeConfluenceLabel, type ConfluenceTab } from './transport'

const reference = pageReference.optional().describe('Omit to use the current published page.')
const labelName = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .regex(/^[^\s\p{C}:]+$/u)
export const labelsArgs = z.strictObject({ page: reference, start: collectionStart })
export const changeLabelArgs = z.strictObject({
  action: z.enum(['add', 'remove']),
  label: labelName.describe('The exact ordinary label named in the user request, without a prefix or spaces.'),
})
export type LabelRequest = z.output<typeof changeLabelArgs>

const englishRequest =
  /^(?:please\s+)?(?<verb>add|remove)\s+(?:the\s+)?label\s+(?<name>`[^`]+`|"[^"]+"|'[^']+'|[^\s`"']+?)(?:\s+(?:to|from)\s+(?:this|the\s+current)\s+(?:published\s+)?page)?[.!]?$/iu
const chineseRequest =
  /^(?:请\s*)?(?:(?:给|在)(?:当前(?:的)?页面?|这(?:个)?页面?|本页|此页)(?:上)?\s*)?(?<verb>添加|加上|加|打上|贴上|移除|删除|去掉|去除|取消)\s*(?:一个|个)?标签\s*(?:[：:]\s*)?(?<name>`[^`]+`|"[^"]+"|“[^”]+”|'[^']+'|[^\s`"'“”]+?)[。！!]?$/u
const addVerbs = new Set(['add', '添加', '加上', '加', '打上', '贴上'])

/** Match complete, direct requests before the question reaches the model or any page is read. */
export function requestedLabelChanges(text: string): LabelRequest[] {
  const changes: LabelRequest[] = []
  for (const clause of text.trim().split(/\s+(?:and then|then)\s+|\s*[；;]\s*/iu)) {
    const groups = (englishRequest.exec(clause) ?? chineseRequest.exec(clause))?.groups
    if (!groups?.verb || !groups.name) return []
    const quoted = /^[`"'“]/u.test(groups.name)
    const label = labelName.safeParse(quoted ? groups.name.slice(1, -1) : groups.name)
    if (!label.success) return []
    changes.push({
      action: addVerbs.has(groups.verb.toLowerCase()) ? 'add' : 'remove',
      label: label.data.toLowerCase(),
    })
  }
  return changes
}

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

export async function applyLabel(input: LabelRequest, target: ConfluenceTab | undefined, signal?: AbortSignal) {
  const tab = requireTab(target)
  const page = await fetchPublishedPage(tab, undefined, publishedPage, '', signal)
  const name = input.label.toLowerCase()
  const change = { tab, page, name }
  const expected = input.action === 'add'
  const before = await hasLabel(change, signal)
  const result = { page: pageLink(tab.instance, page), label: name, present: expected }
  if (before === expected) return { ...result, changed: false }

  const current = await fetchPublishedPage(tab, undefined, publishedPage, '', signal)
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
