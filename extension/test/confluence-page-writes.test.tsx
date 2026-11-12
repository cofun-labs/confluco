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

function pendingResponse<T = Response>() {
  let release!: (response: T) => void
  const promise = new Promise<T>((resolve) => (release = resolve))
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

  it.each(['请在当前页面下创建页面“Child fixture”', `Create page "Child fixture" under ${pageUrl('42')}.`])(
    '[UC-CONFLUENCE-006-S02] reports an existing title without creating another page for %s',
    async (message) => {
      const { browser, user } = await openPanel()
      browser.confluenceResponse = (url) => {
        const endpoint = new URL(url)
        if (endpoint.pathname !== contentPath) return Response.json(parent)
        expect(endpoint.searchParams.get('title')).toBe(child.title)
        expect(endpoint.searchParams.get('spaceKey')).toBe(parent.space.key)
        return Response.json({ results: [child] })
      }
      browser.ai.script.push({ toolCalls: [createCall] }, { reply: 'The page already exists.' })
      await ask(user, message)
      expect(await screen.findByText('The page already exists.')).toBeVisible()
      expect(modelResults(browser)).toContain('"changed":false,"alreadyExists":true')
      expect(modelResults(browser)).toContain(pageUrl('99'))
      expect(writes(browser)).toEqual([])
    },
  )

  it('keeps the planned change visible when the user opens Sessions before the write', async () => {
    const { browser, user } = await openPanel()
    const parentResponse = pendingResponse()
    const writeResponse = pendingResponse()
    const created = { ...child, body: { storage: storage('<p></p>') } }
    browser.confluenceResponse = (url, init) => {
      const path = new URL(url).pathname
      if (init?.method === 'POST') {
        expect(screen.getByRole('status')).toBeVisible()
        expect(screen.getByRole('status')).toHaveTextContent('Create "Child fixture" under "Parent fixture"')
        return writeResponse.promise
      }
      if (path === contentPath) return Response.json({ results: [] })
      if (path === `${contentPath}/99`) return Response.json(created)
      return browser.workspaceRequests.length === 1 ? parentResponse.promise : Response.json(parent)
    }
    browser.ai.script.push({ toolCalls: [createCall] }, { reply: 'Created from the active chat.' })
    await ask(user, command)
    await screen.findByRole('img', { name: 'Running' })
    await user.click(screen.getByRole('button', { name: 'Sessions' }))
    expect(writes(browser)).toEqual([])
    parentResponse.release(Response.json(parent))
    expect(await screen.findByRole('status')).toBeVisible()
    expect(writes(browser)).toHaveLength(1)
    writeResponse.release(Response.json(created))
    await user.click(screen.getByRole('button', { name: 'Back' }))
    expect(await screen.findByText('Created from the active chat.')).toBeVisible()
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

  it('explains when the requested body exceeds the creation limit', async () => {
    const { browser, user } = await openPanel()
    browser.ai.script.push({ toolCalls: [createCall] })
    await user.click(screen.getByRole('textbox', { name: 'Message' }))
    await user.paste(`${command} with text "${'x'.repeat(40_001)}"`)
    await user.click(screen.getByRole('button', { name: 'Send' }))
    await answered()
    expect(screen.getAllByText(/Shorten the requested page body to 40,000 characters or fewer/).length).toBeGreaterThan(
      0,
    )
    expect(browser.workspaceRequests).toEqual([])
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

describe('edit published page text', () => {
  const edit = 'Replace "Status A & B" with `QA\'s "ready" <today>` on this page'
  const editCall = { name: 'edit_page', arguments: '{}' }
  const preserved =
    '<ac:structured-macro ac:name="info"><ac:parameter ac:name="title">Status A &amp; B</ac:parameter>' +
    '<ac:rich-text-body><p>Keep me</p></ac:rich-text-body></ac:structured-macro>' +
    '<table><tbody><tr><td><ac:link><ri:attachment ri:filename="guide.pdf" /></ac:link></td>' +
    '<td><ac:link><ri:user ri:userkey="synthetic-user" /></ac:link></td></tr></tbody></table>' +
    '<custom:tag attribute="a > b"><![CDATA[Status A & B <raw>]]></custom:tag>'
  const tasks =
    '<ac:task-list><ac:task><ac:task-id>19</ac:task-id><ac:task-uuid>fixture-id</ac:task-uuid>' +
    '<ac:task-status>incomplete</ac:task-status><ac:task-body>Check the release</ac:task-body></ac:task></ac:task-list>'
  const body = '<p>Prefix: Status A &#38; B. Keep &#160; suffix.</p>' + preserved
  const expected = "<p>Prefix: QA's &quot;ready&quot; &lt;today&gt;. Keep &#160; suffix.</p>" + preserved
  const original = { ...parent, body: { storage: storage(body) } }
  const updated = { ...original, body: { storage: storage(expected) }, version: { number: 3 } }

  it('[UC-CONFLUENCE-008-S01] shows the edit before dispatch and preserves surrounding storage', async () => {
    const { browser, user } = await openPanel()
    let written = false
    browser.confluenceResponse = (url, init) => {
      expect(new URL(url).pathname).toBe(`${contentPath}/42`)
      if (init?.method === 'PUT') {
        expect(screen.getByText(/Edit "Parent fixture".*version 2/)).toHaveTextContent('Before: "Status A & B"')
        expect(screen.queryByRole('button', { name: 'Allow' })).not.toBeInTheDocument()
        written = true
        expect(init.body).toEqual(
          JSON.stringify({ type: 'page', title: original.title, version: { number: 3 }, body: updated.body }),
        )
      }
      return Response.json(written ? updated : original)
    }
    browser.ai.script.push({ toolCalls: [editCall] }, { reply: 'The edit was verified.' })
    await ask(user, edit)
    expect(await screen.findByText('The edit was verified.')).toBeVisible()
    expect(writes(browser)).toHaveLength(1)
    expect(browser.workspaceRequests.at(-1)?.init?.method).toBe('GET')
    expect(modelResults(browser)).toContain('"version":3,"changed":true,"bodyVerified":true')
    expect(modelResults(browser)).not.toContain(preserved)
  })

  it.each([
    [edit, body + '<p>Status A &amp; B</p>', /appears more than once/],
    [edit, '<p>Status <em>A &amp; B</em></p>', /not found in one editable text segment/],
    ['Replace "incomplete" with "complete" on this page', tasks, /not found in one editable text segment/],
    ['Summarize this page', body, /Ask the user to say Replace/],
  ])('[UC-CONFLUENCE-008-S02] refuses unapproved or ambiguous edits from %s', async (message, value, reason) => {
    const { browser, user } = await openPanel()
    browser.confluenceResponse = () => Response.json({ ...original, body: { storage: storage(value) } })
    browser.ai.script.push({ toolCalls: [editCall] })
    await ask(user, message)
    await answered()
    expect(screen.getAllByText(reason).length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: 'Allow' })).not.toBeInTheDocument()
    expect(writes(browser)).toEqual([])
  })

  it('refuses a replacement that would create a reserved storage sequence', async () => {
    const { browser, user } = await openPanel()
    browser.confluenceResponse = () => Response.json({ ...original, body: { storage: storage('<p>OLD> suffix</p>') } })
    browser.ai.script.push({ toolCalls: [editCall] })
    await ask(user, 'Replace "OLD" with "]]" on this page')
    await answered()
    expect(writes(browser)).toEqual([])
    expect(screen.getAllByText(/reserved markup sequence/).length).toBeGreaterThan(0)
  })

  it.each([false, true])('[UC-CONFLUENCE-008-S03] protects newer content (server conflict %s)', async (conflict) => {
    const { browser, user } = await openPanel()
    browser.confluenceResponse = (_url, init) => {
      if (init?.method === 'PUT') return new Response(null, { status: 409 })
      return Response.json(
        browser.workspaceRequests.length > 1 && !conflict ? { ...original, version: { number: 3 } } : original,
      )
    }
    browser.ai.script.push({ toolCalls: [editCall, editCall] })
    await ask(user, edit)
    await answered()
    expect(screen.getAllByText(conflict ? /has a newer version/ : /changed after the preview/).length).toBeGreaterThan(
      0,
    )
    expect(writes(browser)).toHaveLength(conflict ? 1 : 0)
  })

  it.each([false, true])('[UC-CONFLUENCE-008-S04] verifies an uncertain write once (applied %s)', async (applied) => {
    const { browser, user } = await openPanel()
    let dispatched = false
    browser.confluenceResponse = (_url, init) => {
      if (init?.method === 'PUT') {
        dispatched = true
        return new Response(null, { status: 503 })
      }
      return Response.json(dispatched && applied ? updated : original)
    }
    browser.ai.script.push({ toolCalls: [editCall] }, { reply: 'Verified after read-back.' })
    await ask(user, edit)
    await answered()
    expect(writes(browser)).toHaveLength(1)
    expect(browser.workspaceRequests.at(-1)?.init?.method).toBe('GET')
    if (applied) expect(modelResults(browser)).toContain('"recovered":true')
    else expect(screen.getAllByText(/resulting page could not be verified/).length).toBeGreaterThan(0)
  })

  const undoCall = { name: 'undo_page_edit', arguments: '{}' }
  const historical = { ...original, status: 'historical' }

  it('[UC-CONFLUENCE-008-S06] undoes the last edit after reopening its conversation', async () => {
    const { browser, user } = await openPanel()
    let published = original
    browser.confluenceResponse = (url, init) => {
      const endpoint = new URL(url)
      if (endpoint.searchParams.get('version') === '2') return Response.json(historical)
      if (init?.method === 'PUT') {
        if (published.version.number === 2) published = updated
        else {
          expect(screen.getByText(/Undo the edit on "Parent fixture".*version 3/)).toBeVisible()
          expect(init.body).toEqual(
            JSON.stringify({ type: 'page', title: original.title, version: { number: 4 }, body: original.body }),
          )
          published = { ...original, version: { number: 4 } }
        }
      }
      return Response.json(published)
    }
    browser.ai.script.push({ toolCalls: [editCall] }, { reply: 'Edited the page.' })
    await ask(user, edit)
    await answered()
    await user.click(screen.getByRole('button', { name: 'New chat' }))
    await user.click(screen.getByRole('button', { name: 'Sessions' }))
    await user.click(await screen.findByRole('button', { name: /Replace "Status A & B"/ }))
    browser.ai.script.push({ toolCalls: [undoCall] })
    await ask(user, 'Summarize this page')
    await answered()
    expect(screen.getAllByText(/explicitly request undoing/).length).toBeGreaterThan(0)
    expect(writes(browser)).toHaveLength(1)
    browser.ai.script.push({ toolCalls: [undoCall] }, { reply: 'Restored the previous text.' })
    await ask(user, '撤销上次操作')
    expect(await screen.findByText('Restored the previous text.')).toBeVisible()
    expect(writes(browser)).toHaveLength(2)
    expect(modelResults(browser)).toContain('"version":4,"changed":true,"bodyVerified":true')
  })

  it.each([false, true])(
    '[UC-CONFLUENCE-008-S07] refuses undo without a matching current edit (newer %s)',
    async (newer) => {
      const { browser, user } = await openPanel()
      let written = false
      let bumped = false
      browser.confluenceResponse = (_url, init) => {
        if (init?.method === 'PUT') written = true
        return Response.json(bumped ? { ...updated, version: { number: 4 } } : written ? updated : original)
      }
      if (newer) {
        browser.ai.script.push({ toolCalls: [editCall] }, { reply: 'Edited the page.' })
        await ask(user, edit)
        await answered()
        bumped = true
      }
      browser.ai.script.push({ toolCalls: [undoCall] })
      await ask(user, 'Undo the last operation')
      await answered()
      const error = newer ? /page has changed since the last edit/ : /last workspace change.*can be undone/
      expect(screen.getAllByText(error).length).toBeGreaterThan(0)
      expect(writes(browser)).toHaveLength(newer ? 1 : 0)
    },
  )

  it('clears the saved undo before a later write can outlive the open chat', async () => {
    const { browser, user } = await openPanel()
    let edited = false
    const dispatched = pendingResponse<void>()
    const response = pendingResponse()
    const created = { ...child, body: { storage: storage('<p></p>') } }
    browser.confluenceResponse = (url, init) => {
      if (init?.method === 'PUT') edited = true
      if (init?.method === 'POST') {
        dispatched.release()
        return response.promise
      }
      return Response.json(new URL(url).pathname === contentPath ? { results: [] } : edited ? updated : original)
    }
    browser.ai.script.push({ toolCalls: [editCall] }, { reply: 'Edited the page.' })
    await ask(user, edit)
    await answered()
    browser.ai.script.push({ toolCalls: [createCall] })
    await ask(user, command)
    await dispatched.promise
    await user.click(screen.getByRole('button', { name: 'New chat' }))
    response.release(Response.json(created))
    await user.click(screen.getByRole('button', { name: 'Sessions' }))
    await user.click(await screen.findByRole('button', { name: /Replace "Status A & B"/ }))
    browser.ai.script.push({ toolCalls: [undoCall] })
    await ask(user, 'Undo the last operation')
    await answered()
    expect(screen.getAllByText(/last workspace change.*can be undone/).length).toBeGreaterThan(0)
    expect(writes(browser)).toHaveLength(2)
  })
})
