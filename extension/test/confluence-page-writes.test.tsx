import '@testing-library/jest-dom/vitest'
import { screen } from '@testing-library/react'
import userEvent, { type UserEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { closeBrowser, FakeBrowser } from './panel'

afterEach(closeBrowser)

const base = 'https://wiki.example.test/kb'
const pageUrl = (id: string) => `${base}/pages/viewpage.action?pageId=${id}`
const contentPath = '/kb/rest/api/content'
const storage = (value: string) => ({ value, representation: 'storage' })
const originalBody =
  '<p>Original</p><ac:structured-macro ac:name="toc"><ac:parameter ac:name="style">square</ac:parameter></ac:structured-macro><table><tbody><tr><td>Keep me</td></tr></tbody></table>'
const parent = {
  id: '42',
  type: 'page',
  status: 'current',
  title: 'Parent fixture',
  space: { key: 'TEST' },
  version: { number: 2 },
  ancestors: [{ id: '20' }],
  body: { storage: storage(originalBody) },
}
const child = { ...parent, id: '99', title: 'Child fixture', ancestors: [{ id: '20' }, { id: '42' }] }
const command = 'Create page "Child fixture" under this page'
const rename = 'Rename this page to "Renamed fixture"'
const createCall = { name: 'create_page', arguments: JSON.stringify({ title: child.title }) }
const renameCall = { name: 'rename_page', arguments: JSON.stringify({ title: 'Renamed fixture' }) }

async function openPanel() {
  const browser = await FakeBrowser.start({
    signedInAs: 'user_alice',
    tab: { id: 1, url: pageUrl(parent.id), title: parent.title },
  })
  await browser.openPanel()
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: 'Connect Confluence' }))
  await user.type(await screen.findByLabelText('Confluence base URL'), base)
  await user.click(screen.getByRole('button', { name: /^Connect$/ }))
  await screen.findByText(`Connected to ${base}`)
  await user.click(screen.getByRole('button', { name: 'Done' }))
  return { browser, user }
}

async function ask(user: UserEvent, message: string) {
  await user.type(screen.getByRole('textbox', { name: 'Message' }), message)
  await user.click(screen.getByRole('button', { name: 'Send' }))
}

const answered = () => screen.findByRole('button', { name: 'Send' })
const writes = (browser: FakeBrowser) => browser.workspaceRequests.filter(({ init }) => init?.method !== 'GET')

function pendingResponse() {
  let release!: (response: Response) => void
  const promise = new Promise<Response>((resolve) => (release = resolve))
  return { promise, release }
}

const modelResults = (browser: FakeBrowser) =>
  browser
    .sentToModel()
    .filter(({ role }) => role === 'tool')
    .map(({ content }) => content)
    .join('\n')

describe('create a published page', () => {
  it('[UC-CONFLUENCE-006-S01] shows the chosen parent and verifies the published child', async () => {
    const { browser, user } = await openPanel()
    const expectedBody = storage('<p>Literal &lt;tag&gt; &amp; text</p>')
    const created = { ...child, body: { storage: expectedBody }, version: { number: 1 } }
    const response = pendingResponse()
    const preview = `Create "Child fixture" under "Parent fixture" (${pageUrl('42')}) in space TEST on ${base}.`
    browser.confluenceResponse = (url, init) => {
      const endpoint = new URL(url)
      if (init?.method === 'POST') {
        expect(screen.getByText(preview)).toBeVisible()
        return response.promise
      }
      if (endpoint.pathname === contentPath) return Response.json({ results: [] })
      if (endpoint.pathname === `${contentPath}/99`) return Response.json(created)
      return Response.json(parent)
    }
    browser.ai.script.push({ toolCalls: [createCall] }, { reply: 'Child created and verified.' })
    await ask(user, `Create page "Child fixture" in space TEST under ${pageUrl('42')} with text "Literal <tag> & text"`)
    expect(await screen.findByText(preview)).toBeVisible()
    expect(screen.queryByRole('img', { name: 'Waiting for your OK' })).not.toBeInTheDocument()
    expect(writes(browser)).toHaveLength(1)
    expect(writes(browser)[0]).toMatchObject({
      url: base + '/rest/api/content',
      init: {
        method: 'POST',
        body: JSON.stringify({
          type: 'page',
          title: child.title,
          space: parent.space,
          ancestors: [{ id: parent.id }],
          body: { storage: expectedBody },
        }),
      },
    })
    response.release(Response.json(created))
    expect(await screen.findByText('Child created and verified.')).toBeVisible()
    expect(browser.workspaceRequests.at(-1)?.url).toContain(`${contentPath}/99?expand=`)
    expect(modelResults(browser)).toContain(pageUrl('99'))
    expect(modelResults(browser)).toContain('"version":1,"changed":true,"bodyVerified":true')
  })

  it('[UC-CONFLUENCE-006-S02] reports an existing title without creating another page', async () => {
    const { browser, user } = await openPanel()
    browser.confluenceResponse = (url) => {
      const endpoint = new URL(url)
      if (endpoint.pathname !== contentPath) return Response.json(parent)
      expect(endpoint.searchParams.get('title')).toBe(child.title)
      expect(endpoint.searchParams.get('spaceKey')).toBe(parent.space.key)
      return Response.json({ results: [child] })
    }
    browser.ai.script.push({ toolCalls: [createCall] }, { reply: 'The page already exists.' })
    await ask(user, '请在当前页面下创建页面“Child fixture”')
    expect(await screen.findByText('The page already exists.')).toBeVisible()
    expect(modelResults(browser)).toContain('"changed":false,"alreadyExists":true')
    expect(modelResults(browser)).toContain(pageUrl('99'))
    expect(writes(browser)).toEqual([])
  })

  it.each([
    [403, /does not have permission/],
    [503, /change may have been applied/],
  ])('[UC-CONFLUENCE-006-S03] reports a denied or uncertain creation (%s)', async (status, message) => {
    const { browser, user } = await openPanel()
    browser.confluenceResponse = (url, init) => {
      if (init?.method === 'POST') return new Response(null, { status })
      return Response.json(new URL(url).pathname === contentPath ? { results: [] } : parent)
    }
    browser.ai.script.push({ toolCalls: [createCall, createCall] })
    await ask(user, command)
    await answered()
    expect(screen.getAllByText(message).length).toBeGreaterThan(0)
    expect(writes(browser)).toHaveLength(1)
    expect(browser.ai.calls).toHaveLength(1)
    if (status === 503) {
      browser.confluenceResponse = (url) =>
        Response.json(new URL(url).pathname === contentPath ? { results: [child] } : parent)
      browser.ai.script.push({ toolCalls: [createCall] }, { reply: 'Found the page from the earlier request.' })
      await ask(user, command)
      expect(await screen.findByText('Found the page from the earlier request.')).toBeVisible()
      expect(writes(browser)).toHaveLength(1)
    }
  })

  it.each([
    ['Summarize this page', createCall, false],
    ['Create page "Child fixture" in space TEST', createCall, false],
    ['创建页面“Child fixture”', createCall, false],
    [command, { ...createCall, arguments: '{"title":"Forged title"}' }, false],
    [
      'Create page "Child fixture" under https://other.example.test/kb/pages/viewpage.action?pageId=42',
      createCall,
      true,
    ],
  ])('[UC-CONFLUENCE-006-S04] refuses an unauthorized creation from %s', async (message, call, stopsQuestion) => {
    const { browser, user } = await openPanel()
    browser.ai.script.push({ toolCalls: [call] }, { reply: 'No page created.' })
    await ask(user, message)
    await answered()
    if (stopsQuestion) expect(screen.getAllByText(/Use a published page link/).length).toBeGreaterThan(0)
    else expect(modelResults(browser)).toContain('Only the user can request this page change.')
    expect(browser.workspaceRequests).toEqual([])
  })

  it('refuses creation when the parent is outside the requested space', async () => {
    const { browser, user } = await openPanel()
    browser.confluenceResponse = () => Response.json(parent)
    browser.ai.script.push({ toolCalls: [createCall] })
    await ask(user, 'Create page "Child fixture" in space OTHER under this page')
    await answered()
    expect(screen.getAllByText(/chosen parent is not in the requested Confluence space/).length).toBeGreaterThan(0)
    expect(writes(browser)).toEqual([])
  })
})

describe('rename a published page', () => {
  it('[UC-CONFLUENCE-007-S01] renames the same page with untouched storage and parent', async () => {
    const { browser, user } = await openPanel()
    const updated = { ...parent, title: 'Renamed fixture', version: { number: 3 } }
    const response = pendingResponse()
    let applied = false
    browser.confluenceResponse = (url, init) => {
      expect(new URL(url).pathname).toBe(`${contentPath}/42`)
      if (init?.method === 'PUT') {
        applied = true
        return response.promise
      }
      return Response.json(applied ? updated : parent)
    }
    browser.ai.script.push({ toolCalls: [renameCall, renameCall] }, { reply: 'Renamed the existing page.' })
    await ask(user, '把当前页重命名为“Renamed fixture”')
    expect(
      await screen.findByText(
        `Rename "Parent fixture" (${pageUrl('42')}) in space TEST on ${base} to "Renamed fixture".`,
      ),
    ).toBeVisible()
    expect(screen.queryByRole('img', { name: 'Waiting for your OK' })).not.toBeInTheDocument()
    expect(writes(browser)).toHaveLength(1)
    expect(writes(browser)[0]).toMatchObject({
      url: base + '/rest/api/content/42',
      init: {
        method: 'PUT',
        body: JSON.stringify({ type: 'page', title: updated.title, version: { number: 3 }, body: parent.body }),
      },
    })
    response.release(Response.json(updated))
    expect(await screen.findByText('Renamed the existing page.')).toBeVisible()
    expect(browser.workspaceRequests.at(-1)?.init?.method).toBe('GET')
    expect(modelResults(browser)).toContain(pageUrl('42'))
    expect(modelResults(browser)).toContain(
      '"previousTitle":"Parent fixture","version":3,"changed":true,"contentPreserved":true',
    )
    expect(modelResults(browser)).not.toContain(originalBody)
    expect(writes(browser)).toHaveLength(1)
  })

  it.each([false, true])(
    '[UC-CONFLUENCE-007-S02] preserves a newer version (server detects conflict %s)',
    async (conflict) => {
      const { browser, user } = await openPanel()
      browser.confluenceResponse = (_url, init) => {
        if (init?.method === 'PUT') return new Response(null, { status: 409 })
        return Response.json(
          conflict || browser.workspaceRequests.length === 1 ? parent : { ...parent, version: { number: 3 } },
        )
      }
      browser.ai.script.push({ toolCalls: [renameCall, renameCall] })
      await ask(user, rename)
      await answered()
      expect(
        screen.getAllByText(conflict ? /has a newer version/ : /changed after the preview/).length,
      ).toBeGreaterThan(0)
      expect(writes(browser)).toHaveLength(conflict ? 1 : 0)
      expect(screen.queryByText(/Some changes in this question may already have been made/)).not.toBeInTheDocument()
    },
  )

  it.each([
    [false, /does not have permission/],
    [true, /resulting page could not be verified/],
  ])('[UC-CONFLUENCE-007-S03] reports a denied or unverifiable rename (applied %s)', async (applied, message) => {
    const { browser, user } = await openPanel()
    let written = false
    const updated = { ...parent, title: 'Renamed fixture', version: { number: 3 } }
    browser.confluenceResponse = (_url, init) => {
      if (init?.method === 'PUT') {
        written = true
        return applied ? Response.json(updated) : new Response(null, { status: 403 })
      }
      return Response.json(written ? { ...updated, body: { storage: storage('<p>Unexpected body</p>') } } : parent)
    }
    browser.ai.script.push({ toolCalls: [renameCall] })
    await ask(user, rename)
    await answered()
    expect(screen.getAllByText(message).length).toBeGreaterThan(0)
    expect(writes(browser)).toHaveLength(1)
  })

  it('reports a rejected title without an uncertain-write warning', async () => {
    const { browser, user } = await openPanel()
    browser.confluenceResponse = (_url, init) =>
      init?.method === 'PUT' ? new Response(null, { status: 400 }) : Response.json(parent)
    browser.ai.script.push({ toolCalls: [renameCall] })
    await ask(user, rename)
    await answered()
    expect(screen.getAllByText(/Check that the title is valid and unique in the chosen space/).length).toBeGreaterThan(
      0,
    )
    expect(screen.queryByText(/Some changes in this question may already have been made/)).not.toBeInTheDocument()
    expect(writes(browser)).toHaveLength(1)
  })
})
