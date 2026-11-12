import { refuse } from './transport'

const escaped: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' }

// Use offsets into the original storage. Serializing the document would also rewrite unrelated markup.
function textOffsets(raw: string, text: string, decoder: HTMLTextAreaElement) {
  const entities: { decodedStart: number; decodedEnd: number; rawEnd: number }[] = []
  let decoded = ''
  let cursor = 0
  for (const entity of raw.matchAll(/&(?:#[0-9]+|#x[\da-f]+|[a-z][a-z0-9]*);/gi)) {
    decoder.innerHTML = entity[0]
    const value = decoder.value
    if (value === entity[0]) continue
    decoded += raw.slice(cursor, entity.index)
    const decodedStart = decoded.length
    decoded += value
    cursor = entity.index + entity[0].length
    entities.push({ decodedStart, decodedEnd: decoded.length, rawEnd: cursor })
  }
  decoded += raw.slice(cursor)

  const sourceOffset = (index: number) => {
    let shift = 0
    for (const entity of entities) {
      if (index <= entity.decodedStart) break
      if (index < entity.decodedEnd) refuse('The selected text splits a Confluence character reference.')
      shift = entity.rawEnd - entity.decodedEnd
    }
    return index + shift
  }
  const start = decoded.indexOf(text)
  if (start < 0) return undefined
  if (decoded.indexOf(text, start + 1) >= 0) ambiguous()
  return { start: sourceOffset(start), end: sourceOffset(start + text.length) }
}

function ambiguous(): never {
  refuse('That text appears more than once. Quote a longer, unique passage before asking to edit it.')
}

/** Replace one text passage without reserializing tags, attributes, or neighboring text. */
export function replaceStorageText(storage: string, text: string, replacement: string): string {
  const decoder = document.createElement('textarea')
  const opaque = /<!--[^]*?-->|<!\[CDATA\[[^]*?\]\]>|<\?[^]*?\?>/y
  const tag = /<(\/?)([a-z_][\w.:-]*)(?:\s+[^\s"'<>/=]+\s*=\s*(?:"[^"<]*"|'[^'<]*'))*\s*(\/?)>/iy
  const stack: { name: string; protected: boolean }[] = []
  let match: { start: number; end: number } | undefined
  let cursor = 0
  while (cursor < storage.length) {
    if (storage[cursor] !== '<') {
      const nextTag = storage.indexOf('<', cursor)
      const end = nextTag === -1 ? storage.length : nextTag
      if (!stack.at(-1)?.protected) {
        const offsets = textOffsets(storage.slice(cursor, end), text, decoder)
        if (offsets) {
          if (match) ambiguous()
          match = { start: cursor + offsets.start, end: cursor + offsets.end }
        }
      }
      cursor = end
      continue
    }
    opaque.lastIndex = cursor
    if (opaque.exec(storage)) {
      cursor = opaque.lastIndex
      continue
    }
    tag.lastIndex = cursor
    const token = tag.exec(storage)
    if (!token) refuse('This page contains storage markup that Confluco cannot safely edit.')
    const [_, closing, name, selfClosing] = token
    if (closing) {
      if (selfClosing || stack.pop()?.name !== name) refuse('This page contains unbalanced storage markup.')
    } else if (!selfClosing) {
      const protectedText =
        /^(?:ri:|(?:ac:(?:parameter|plain-text-body)|script|style|template|textarea|noscript|iframe|object)$)/i.test(
          name,
        )
      stack.push({ name, protected: protectedText || stack.at(-1)?.protected === true })
    }
    cursor = tag.lastIndex
  }
  if (stack.length) refuse('This page contains unbalanced storage markup.')
  if (!match)
    refuse('That exact passage was not found in one editable text segment. Quote the current text and try again.')
  // Confluence keeps quotes literal in stored text. Escape only characters significant to markup.
  const escapedText = replacement.replace(/[&<>]/g, (character) => escaped[character])
  const joined =
    storage.slice(Math.max(0, match.start - 2), match.start) + escapedText + storage.slice(match.end, match.end + 2)
  if (joined.includes(']]>'))
    refuse('This replacement would create a reserved markup sequence. Include the neighboring text in your request.')
  return storage.slice(0, match.start) + escapedText + storage.slice(match.end)
}
