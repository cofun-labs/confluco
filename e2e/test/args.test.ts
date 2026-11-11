import { describe, expect, it } from 'vitest'
import { DEFAULT_TIMEOUT_S, UsageError, parseArgs } from '../src/args'

describe('parseArgs', () => {
  it('shows help without a command, or with -h', () => {
    expect(parseArgs([]).command).toEqual({ name: 'help' })
    expect(parseArgs(['ask', '-h']).command).toEqual({ name: 'help' })
  })

  it('takes the lock owner from --owner, in either form', () => {
    expect(parseArgs(['reload', '--owner', 'issue-1'])).toEqual({ command: { name: 'reload' }, owner: 'issue-1' })
    expect(parseArgs(['--owner=issue-1', 'close']).owner).toBe('issue-1')
  })

  it('takes an optional website URL for panel, and refuses non-web URLs', () => {
    expect(parseArgs(['panel']).command).toEqual({ name: 'panel', url: undefined })
    const url = 'https://team.atlassian.net/wiki/spaces/ENG/pages/123'
    expect(parseArgs(['panel', url]).command).toEqual({ name: 'panel', url })
    expect(parseArgs(['panel', 'https://example.com/']).command).toEqual({ name: 'panel', url: 'https://example.com/' })
    expect(() => parseArgs(['panel', 'chrome://settings'])).toThrow(UsageError)
  })

  it('reads ask with its answer, timeout, and output options', () => {
    expect(parseArgs(['ask', 'Make a child page', '--allow', '--timeout', '60', '--json']).command).toEqual({
      name: 'ask',
      question: 'Make a child page',
      answer: 'allow',
      timeoutMs: 60_000,
      json: true,
    })
    expect(parseArgs(['ask', 'hi', '--deny']).command).toMatchObject({ answer: 'deny' })
  })

  it('lets ask go without a question, to keep waiting for the last reply', () => {
    expect(parseArgs(['ask', '--allow']).command).toEqual({
      name: 'ask',
      question: undefined,
      answer: 'allow',
      timeoutMs: DEFAULT_TIMEOUT_S * 1000,
      json: false,
    })
  })

  it('refuses contradicting or misplaced ask options', () => {
    expect(() => parseArgs(['ask', 'hi', '--allow', '--deny'])).toThrow('not both')
    expect(() => parseArgs(['ask', 'hi', '--timeout', 'soon'])).toThrow('Not a number')
    expect(() => parseArgs(['ask', 'hi', '--timeout'])).toThrow('needs a value')
    expect(() => parseArgs(['ask', '  '])).toThrow('empty')
    expect(() => parseArgs(['reload', '--allow'])).toThrow('only goes with ask')
    expect(() => parseArgs(['ask', 'one', 'two'])).toThrow('Too many arguments')
  })

  it('passes everything after -- as question text', () => {
    expect(parseArgs(['ask', '--', '--help']).command).toMatchObject({ question: '--help' })
  })

  it('reads lock actions, with a purpose only for acquire', () => {
    expect(parseArgs(['lock', 'acquire', 'UC-AGENT-001-S16', 'run']).command).toEqual({
      name: 'lock',
      action: 'acquire',
      purpose: 'UC-AGENT-001-S16 run',
    })
    expect(parseArgs(['lock', 'status']).command).toEqual({ name: 'lock', action: 'status', purpose: undefined })
    expect(() => parseArgs(['lock', 'steal'])).toThrow(UsageError)
    expect(() => parseArgs(['lock', 'release', 'now'])).toThrow('Too many arguments')
  })

  it('refuses unknown commands and options', () => {
    expect(() => parseArgs(['deploy'])).toThrow('Unknown command')
    expect(() => parseArgs(['reload', '--force'])).toThrow('Unknown option')
    expect(() => parseArgs(['reload', 'now'])).toThrow('Too many arguments')
  })
})
