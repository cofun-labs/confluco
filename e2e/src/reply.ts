// A reply in the side panel as this tool reads it, when to stop waiting for it, and how it prints.
import * as z from 'zod'
import type { Answer } from './args'

const ReplyPartSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({
    type: z.literal('tool'),
    name: z.string(),
    status: z.string(),
    sections: z.array(z.object({ label: z.string(), text: z.string() })),
  }),
  z.object({ type: z.literal('error'), text: z.string() }),
  z.object({ type: z.literal('note'), text: z.string() }),
])
export type ReplyPart = z.infer<typeof ReplyPartSchema>

export const PanelSnapshotSchema = z.object({
  ready: z.boolean(),
  busy: z.boolean(),
  replies: z.number(),
  asking: z.boolean(),
  parts: z.array(ReplyPartSchema),
})
export type PanelSnapshot = z.infer<typeof PanelSnapshotSchema>

export type Step = 'wait' | 'done' | 'error' | 'needs_answer' | 'unanswerable' | { click: Answer }

/**
 * What to do next while waiting for reply number `expected`: keep waiting, answer an approval
 * prompt as told, stop because nobody said how to answer it or because it can't be answered, or
 * stop because the reply is done.
 */
export function nextStep(snap: PanelSnapshot, expected: number, answer?: Answer): Step {
  if (snap.replies < expected) return 'wait'
  if (snap.asking) return answer ? { click: answer } : 'needs_answer'
  // A call waiting for approval that shows no Allow/Deny buttons can never be answered.
  if (snap.parts.some((p) => p.type === 'tool' && p.status === 'confirm')) return 'unanswerable'
  if (snap.busy) return 'wait'
  return snap.parts.some((part) => part.type === 'error') ? 'error' : 'done'
}

/** A reply for reading in a terminal: text as is, then each tool call with its sections indented. */
export function formatReply(parts: ReplyPart[]): string {
  const out: string[] = []
  for (const part of parts) {
    if (part.type === 'text') out.push(part.text)
    else if (part.type === 'tool') {
      const lines = [`[tool] ${part.name}: ${part.status}`]
      for (const s of part.sections) lines.push(`  ${s.label}:`, indent(s.text, '    '))
      out.push(lines.join('\n'))
    } else out.push(`[${part.type}] ${part.text}`)
  }
  return out.join('\n\n')
}

function indent(text: string, by: string): string {
  return text
    .split('\n')
    .map((line) => (line ? by + line : line))
    .join('\n')
}

/**
 * Runs in the side panel: reads the chat from the DOM. It must not use anything from outside its
 * body (it is sent to the page as source). Tool cards are read whole, collapsed or not.
 */
export function readPanel(): PanelSnapshot {
  const submit = document.querySelector('#composer button[type=submit]')
  const replies = [...document.querySelectorAll('#messages .msg.assistant')]
  const last = replies.at(-1)
  const parts: ReplyPart[] = []
  for (const el of last ? [...last.children] : []) {
    const text = (el.textContent ?? '').trim()
    if (el.matches('details.tool')) {
      const sections: { label: string; text: string }[] = []
      let label: string | undefined
      for (const child of el.querySelector('.tool-body')?.children ?? []) {
        if (child.matches('.tool-label')) label = (child.textContent ?? '').trim()
        else if (child.matches('pre') && label) sections.push({ label, text: child.textContent ?? '' })
      }
      parts.push({
        type: 'tool',
        name: (el.querySelector('.tool-name')?.textContent ?? '').trim(),
        status: [...el.classList].find((c) => c !== 'tool') ?? 'unknown',
        sections,
      })
    } else if (el.matches('.text')) parts.push({ type: 'text', text })
    else if (el.matches('.error')) parts.push({ type: 'error', text })
    // "…" only says the model is still working.
    else if (el.matches('.note') && text !== '…') parts.push({ type: 'note', text })
  }
  return {
    ready: !!document.querySelector('#composer textarea'),
    busy: submit?.textContent === 'Stop',
    replies: replies.length,
    asking: !!last?.querySelector('.tool-confirm'),
    parts,
  }
}
