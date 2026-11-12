import '@testing-library/jest-dom/vitest'
import { screen } from '@testing-library/react'
import userEvent, { type UserEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { closeBrowser, FakeBrowser } from './panel'

afterEach(closeBrowser)

const base = 'https://wiki.example.test/kb'
const url = (id: string) => base + '/pages/viewpage.action?pageId=' + id
const api = '/kb/rest/api/content'
const source = {
  id: '42',
  title: 'Source fixture',
  type: 'page',
  status: 'current',
  space: { key: 'TEST' },
  ancestors: [{ id: '20' }],
  version: { number: 2 },
  body: {
    storage: {
      value: '<p>Keep content</p><table><tbody><tr><td>Table cell</td></tr></tbody></table>',
      representation: 'storage',
    },
  },
}
const parent = { ...source, id: '77', title: 'Destination fixture' }
const moved = { ...source, ancestors: [...parent.ancestors, { id: parent.id }], version: { number: 3 } }
const copied = { ...moved, id: '99', title: 'Copy fixture', version: { number: 1 } }
const empty = { results: [] }
const unrestricted = { restrictions: { user: empty, group: empty } }
const move = { name: 'move_page', arguments: '{}' }
const copy = { name: 'copy_page', arguments: '{}' }
const moveCommand = 'Move this page under ' + url('77')
const copyCommand = 'Copy this page under ' + url('77') + ' as "Copy fixture"'

async function openPanel() {
  const browser = await FakeBrowser.start({
    signedInAs: 'user_alice',
    tab: { id: 1, url: url(source.id), title: source.title },
  })
  await browser.openPanel()
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: 'Connect Confluence' }))
  await user.type(await screen.findByLabelText('Confluence base URL'), base)
  await user.click(screen.getByRole('button', { name: /^Connect$/ }))
  await screen.findByText('Connected to ' + base)
  await user.click(screen.getByRole('button', { name: 'Done' }))
  return { browser, user }
}

async function ask(user: UserEvent, message: string) {
  await user.type(screen.getByRole('textbox', { name: 'Message' }), message)
  await user.click(screen.getByRole('button', { name: 'Send' }))
}
const answered = () => screen.findByRole('button', { name: 'Send' })
const writes = (browser: FakeBrowser) => browser.workspaceRequests.filter(({ init }) => init?.method !== 'GET')
const results = (browser: FakeBrowser) =>
  browser
    .sentToModel()
    .filter(({ role }) => role === 'tool')
    .map(({ content }) => content)
    .join('\n')

describe('organize published pages', () => {
  it('[UC-CONFLUENCE-010-S01] moves the same page and verifies its new parent and body', async () => {
    const { browser, user } = await openPanel()
    let done = false
    browser.confluenceResponse = (address, init) => {
      const path = new URL(address).pathname
      if (path.endsWith('/77')) return Response.json(parent)
      if (init?.method === 'PUT') {
        expect(path).toBe(api + '/42')
        expect(screen.getByText(/Move "Source fixture".*under "Destination fixture"/)).toBeVisible()
        expect(screen.queryByRole('button', { name: 'Allow' })).not.toBeInTheDocument()
        expect(init.body).toBe(
          JSON.stringify({
            type: 'page',
            title: source.title,
            space: source.space,
            version: { number: 3 },
            ancestors: [{ id: '77' }],
            body: source.body,
          }),
        )
        done = true
      }
      return Response.json(done ? moved : source)
    }
    browser.ai.script.push({ toolCalls: [move] }, { reply: 'Move verified.' })
    await ask(user, moveCommand)
    expect(await screen.findByText('Move verified.')).toBeVisible()
    expect(writes(browser)).toHaveLength(1)
    expect(results(browser)).toContain(url('42'))
    expect(results(browser)).toContain(url('77'))
    expect(results(browser)).toContain('"version":3,"changed":true')
  })

  it('[UC-CONFLUENCE-010-S02] verifies a distinct copy beneath the chosen parent', async () => {
    const { browser, user } = await openPanel()
    browser.confluenceResponse = (address, init) => {
      const path = new URL(address).pathname
      if (init?.method === 'POST') {
        expect(screen.getByText(/Copy the body of "Source fixture".*as "Copy fixture"/)).toBeVisible()
        expect(init.body).toBe(
          JSON.stringify({
            type: 'page',
            title: copied.title,
            space: source.space,
            ancestors: [{ id: '77' }],
            body: source.body,
          }),
        )
        return Response.json(copied)
      }
      if (path.endsWith('/77')) return Response.json(parent)
      if (path.endsWith('/99')) return Response.json(copied)
      if (path.endsWith('/restriction/byOperation')) return Response.json({ read: unrestricted, update: unrestricted })
      if (path.endsWith('/child/attachment') || path === api) return Response.json(empty)
      return Response.json(source)
    }
    browser.ai.script.push({ toolCalls: [copy] }, { reply: 'Copy verified.' })
    await ask(user, copyCommand)
    expect(await screen.findByText('Copy verified.')).toBeVisible()
    expect(writes(browser)).toHaveLength(1)
    expect(results(browser)).toContain(url('99'))
    expect(results(browser)).toContain(url('77'))
  })

  it.each([
    ['Summarize this page', move, parent, false, /specify the source page/],
    ['Move this page before ' + url('77'), move, parent, false, /Move this page under URL/],
    [moveCommand, move, { ...parent, space: { key: 'OTHER' } }, false, /same Confluence space/],
    [moveCommand, move, { ...parent, ancestors: [{ id: '42' }] }, false, /under itself or its descendants/],
    [moveCommand, move, { ...parent, ancestors: [{ id: '30' }] }, true, /drop an existing page restriction/],
    [copyCommand, copy, parent, false, /page has attachments/],
  ])(
    '[UC-CONFLUENCE-010-S03] rejects unsupported or unapproved organization (%s)',
    async (message, call, destination, hasRestriction, reason) => {
      const { browser, user } = await openPanel()
      browser.confluenceResponse = (address) => {
        const path = new URL(address).pathname
        if (path.endsWith('/77')) return Response.json(destination)
        if (path.endsWith('/child/attachment')) return Response.json({ results: [{ id: 'att1' }] })
        if (path.endsWith('/restriction/byOperation') && hasRestriction)
          return Response.json({
            read: { restrictions: { user: { results: [{}] }, group: empty } },
            update: unrestricted,
          })
        return Response.json(source)
      }
      browser.ai.script.push({ toolCalls: [call] })
      await ask(user, message)
      await answered()
      expect(screen.getAllByText(reason).length).toBeGreaterThan(0)
      expect(writes(browser)).toEqual([])
    },
  )

  it.each([false, true])(
    '[UC-CONFLUENCE-010-S04] stops on a changed destination or uncertain move (%s)',
    async (uncertain) => {
      const { browser, user } = await openPanel()
      let destinationReads = 0
      browser.confluenceResponse = (address, init) => {
        if (init?.method === 'PUT') return new Response(null, { status: 503 })
        if (new URL(address).pathname.endsWith('/77')) {
          destinationReads++
          return Response.json(uncertain || destinationReads === 1 ? parent : { ...parent, title: 'Moved destination' })
        }
        return Response.json(source)
      }
      browser.ai.script.push({ toolCalls: [move, move] })
      await ask(user, moveCommand)
      await answered()
      expect(
        screen.getAllByText(uncertain ? /change may have been applied/ : /destination changed after the preview/)
          .length,
      ).toBeGreaterThan(0)
      expect(writes(browser)).toHaveLength(uncertain ? 1 : 0)
    },
  )
})
