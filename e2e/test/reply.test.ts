import { describe, expect, it } from 'vitest'
import { type PanelSnapshot, formatReply, nextStep } from '../src/reply'

const snap = (s: Partial<PanelSnapshot>): PanelSnapshot => ({
  ready: true,
  busy: false,
  replies: 1,
  asking: false,
  parts: [],
  ...s,
})

describe('nextStep', () => {
  it('waits until the new reply shows up, even if the panel looks idle', () => {
    // Right after Send, the panel may not have re-rendered yet: the old reply is still the last one.
    expect(nextStep(snap({ replies: 1 }), 2)).toBe('wait')
  })

  it('waits while the reply is coming', () => {
    expect(nextStep(snap({ replies: 2, busy: true }), 2)).toBe('wait')
  })

  it('is done once the reply has ended', () => {
    expect(nextStep(snap({ replies: 2 }), 2)).toBe('done')
  })

  it('reports an ended reply with an error as failed', () => {
    const parts = [{ type: 'error' as const, text: 'Sign in again.' }]
    expect(nextStep(snap({ replies: 2, parts }), 2)).toBe('error')
  })

  it('answers an approval prompt as told', () => {
    expect(nextStep(snap({ replies: 2, busy: true, asking: true }), 2, 'allow')).toEqual({ click: 'allow' })
    expect(nextStep(snap({ replies: 2, busy: true, asking: true }), 2, 'deny')).toEqual({ click: 'deny' })
  })

  it('gives up on a call waiting for approval that has no buttons to answer it', () => {
    const waiting = { type: 'tool' as const, name: 'edit_page', status: 'confirm', sections: [] }
    expect(nextStep(snap({ replies: 2, busy: true, parts: [waiting] }), 2, 'allow')).toBe('unanswerable')
  })

  it('stops at an approval prompt nobody said how to answer', () => {
    expect(nextStep(snap({ replies: 2, busy: true, asking: true }), 2)).toBe('needs_answer')
  })
})

describe('formatReply', () => {
  it('prints text and tool calls in order, with each section of a tool card', () => {
    const out = formatReply([
      { type: 'text', text: 'I will make the page.' },
      {
        type: 'tool',
        name: 'create_page',
        status: 'done',
        sections: [
          { label: 'Arguments', text: '{\n  "title": "Goals"\n}' },
          { label: 'Result', text: 'Created the page.' },
        ],
      },
      { type: 'note', text: 'Stopped' },
      { type: 'error', text: 'The model failed.' },
    ])
    expect(out).toBe(
      [
        'I will make the page.',
        '',
        '[tool] create_page: done',
        '  Arguments:',
        '    {',
        '      "title": "Goals"',
        '    }',
        '  Result:',
        '    Created the page.',
        '',
        '[note] Stopped',
        '',
        '[error] The model failed.',
      ].join('\n'),
    )
  })

  it('prints nothing for an empty reply', () => {
    expect(formatReply([])).toBe('')
  })
})
