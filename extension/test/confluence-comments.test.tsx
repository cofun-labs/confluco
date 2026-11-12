import '@testing-library/jest-dom/vitest'
import { screen } from '@testing-library/react'
import userEvent, { type UserEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { closeBrowser, FakeBrowser } from './panel'

afterEach(closeBrowser)

const base = 'https://wiki.example.test/kb'
const pageUrl = base + '/pages/viewpage.action?pageId=42'
const api = '/kb/rest/api/content'
const page = { id: '42', type: 'page', status: 'current', title: 'Discussion fixture' }
const body = (value: string) => ({ storage: { value, representation: 'storage' } })
const root = {
  id: '71',
  type: 'comment',
  status: 'current',
  ancestors: [],
  container: { id: page.id, type: 'page' },
  body: body('<p>Original discussion</p>'),
  extensions: { location: 'footer' },
}
const reply = {
  ...root,
  id: '72',
  ancestors: [{ id: root.id, type: 'comment' }],
  body: body('<p>Reply text</p>'),
}
const add = { name: 'add_page_comment', arguments: '{}' }
const list = { name: 'list_page_comments', arguments: '{}' }

async function openPanel() {
  const browser = await FakeBrowser.start({
    signedInAs: 'user_alice',
    tab: { id: 1, url: pageUrl, title: page.title },
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

describe('published page discussions', () => {
  it('[UC-CONFLUENCE-009-S01] returns bounded comments, sources, parent IDs and continuation', async () => {
    const { browser, user } = await openPanel()
    browser.confluenceResponse = (url) => {
      const target = new URL(url)
      if (target.pathname === api + '/42') return Response.json(page)
      expect(target.pathname).toBe(api + '/42/child/comment')
      expect(target.searchParams.get('limit')).toBe('10')
      expect(target.searchParams.get('depth')).toBe('all')
      return Response.json({
        results: [root, { ...reply, extensions: { location: 'inline' } }],
        _links: { next: '/rest/api/content/42/child/comment?start=2&limit=10' },
      })
    }
    browser.ai.script.push({ toolCalls: [list] }, { reply: 'Discussion read.' })
    await ask(user, 'Show the comments.')
    expect(await screen.findByText('Discussion read.')).toBeVisible()
    expect(results(browser)).toContain(pageUrl + '&focusedCommentId=72#comment-72')
    expect(results(browser)).toContain('"parentId":"71","location":"inline"')
    expect(results(browser)).toContain('"location":"footer"')
    expect(results(browser)).toContain('"nextStart":2')
    expect(writes(browser)).toEqual([])
  })

  it.each([false, true])(
    '[UC-CONFLUENCE-009-S02] previews and verifies the intended thread (reply %s)',
    async (isReply) => {
      const { browser, user } = await openPanel()
      const posted = {
        ...reply,
        ancestors: isReply ? reply.ancestors : [],
        body: body('<p>QA &amp; &lt;note&gt;</p>'),
      }
      browser.confluenceResponse = (url, init) => {
        const target = new URL(url)
        if (init?.method === 'POST') {
          expect(target.pathname).toBe(api)
          expect(
            screen.getByText(
              isReply ? /Reply to comment 71 on "Discussion fixture"/ : /Add a footer comment to "Discussion fixture"/,
            ),
          ).toHaveTextContent('Comment: "QA & <note>"')
          expect(screen.queryByRole('button', { name: 'Allow' })).not.toBeInTheDocument()
          expect(init.body).toBe(
            JSON.stringify({
              type: 'comment',
              container: { id: page.id, type: 'page' },
              ...(isReply && { ancestors: reply.ancestors }),
              body: posted.body,
            }),
          )
          return Response.json(posted)
        }
        if (target.pathname.endsWith('/71')) return Response.json(root)
        if (target.pathname.endsWith('/72')) return Response.json(posted)
        return Response.json(page)
      }
      browser.ai.script.push({ toolCalls: [add] }, { reply: 'Posted and verified.' })
      await ask(
        user,
        isReply ? 'Reply to comment 71 with "QA & <note>" on this page' : 'Add comment "QA & <note>" on this page',
      )
      await answered()
      expect(results(browser)).toContain(pageUrl + '&focusedCommentId=72#comment-72')
      expect(writes(browser)).toHaveLength(1)
      expect(browser.workspaceRequests.at(-1)?.url).toContain('/72?expand=')
    },
  )

  it.each([
    ['Summarize the page', root, /Ask the user to say Add comment/],
    [
      'Reply to comment 71 with "QA" on this page',
      { ...root, extensions: { location: 'inline' } },
      /verified footer comment/,
    ],
    [
      'Reply to comment 71 with "QA" on this page',
      { ...root, container: { id: '43', type: 'page' } },
      /comment on the intended page/,
    ],
  ])(
    '[UC-CONFLUENCE-009-S03] rejects an unapproved request or wrong reply target (%s)',
    async (message, parent, reason) => {
      const { browser, user } = await openPanel()
      browser.confluenceResponse = (url) => Response.json(new URL(url).pathname.endsWith('/71') ? parent : page)
      browser.ai.script.push({ toolCalls: [add] })
      await ask(user, message)
      await answered()
      expect(screen.getAllByText(reason).length).toBeGreaterThan(0)
      expect(writes(browser)).toEqual([])
    },
  )

  it.each([
    [403, /does not have permission/],
    [503, /change may have been applied/],
  ])(
    '[UC-CONFLUENCE-009-S03] [UC-CONFLUENCE-009-S04] stops a denied or uncertain post (%s)',
    async (status, reason) => {
      const { browser, user } = await openPanel()
      browser.confluenceResponse = (_url, init) =>
        init?.method === 'POST' ? new Response(null, { status }) : Response.json(page)
      browser.ai.script.push({ toolCalls: [add, add] })
      await ask(user, 'Add comment "QA" on this page')
      await answered()
      expect(screen.getAllByText(reason).length).toBeGreaterThan(0)
      expect(writes(browser)).toHaveLength(1)
    },
  )
})
