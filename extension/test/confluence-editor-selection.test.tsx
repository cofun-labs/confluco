import '@testing-library/jest-dom/vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it } from 'vitest'
import { closeBrowser, FakeBrowser } from './panel'

afterEach(closeBrowser)

const base = 'https://wiki.example.test/kb'
const selected = 'Synthetic unpublished selection 742'
const editor = {
  id: 1,
  url: base + '/pages/editpage.action?pageId=42',
  title: 'Editor fixture',
  meta: '<iframe id="wysiwygTextarea_ifr"></iframe>',
  editorSelection: selected,
}

async function openPanel(tab = editor) {
  const browser = await FakeBrowser.start({ signedInAs: 'user_alice', tab })
  await browser.openPanel()
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: 'Connect Confluence' }))
  await user.type(await screen.findByLabelText('Confluence base URL'), base)
  await user.click(screen.getByRole('button', { name: /^Connect$/ }))
  await screen.findByText('Connected to ' + base)
  await user.click(screen.getByRole('button', { name: 'Done' }))
  const attach = () => user.click(screen.getByRole('button', { name: 'Attach editor selection' }))
  const send = async () => {
    browser.ai.script.push({ reply: 'Received the question.' })
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Explain this text')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    await screen.findByText('Received the question.')
  }
  return { browser, user, attach, send }
}

it('[UC-CONFLUENCE-013-S01] sends only the reviewed editor selection with the question', async () => {
  const { browser, attach, send } = await openPanel()
  await attach()
  expect(await screen.findByRole('region', { name: 'Selected editor text' })).toHaveTextContent(selected)
  expect(browser.ai.calls).toEqual([])
  await send()
  const messages = JSON.stringify(browser.sentToModel())
  expect(messages).toContain(selected)
  expect(messages).toContain('Explain this text')
  expect(messages).not.toContain('Other editor text')
  expect(browser.workspaceRequests).toEqual([])
})

it.each([
  [{ ...editor, editorSelection: '' }, /Select text in the Confluence editor/],
  [{ ...editor, url: base + '/pages/viewpage.action?pageId=42' }, /Open a supported Confluence editor/],
  [{ ...editor, url: 'https://other.example.test/pages/editpage.action?pageId=42' }, /Connect a self-managed/],
])('[UC-CONFLUENCE-013-S02] omits text outside a selected supported editor (%j)', async (tab, message) => {
  const { browser, attach, send } = await openPanel(tab)
  await attach()
  expect(await screen.findByText(message)).toBeVisible()
  await send()
  expect(JSON.stringify(browser.sentToModel())).not.toContain(selected)
  expect(browser.workspaceRequests).toEqual([])
})

it.each(['removed', 'tab changed'])('[UC-CONFLUENCE-013-S03] omits a selection that was %s', async (scenario) => {
  const { browser, user, attach, send } = await openPanel()
  await attach()
  await screen.findByRole('region', { name: 'Selected editor text' })
  if (scenario === 'removed') await user.click(screen.getByRole('button', { name: 'Remove selection' }))
  else browser.selectTab({ ...editor, id: 2, url: base + '/pages/editpage.action?pageId=84' })
  await send()
  expect(JSON.stringify(browser.sentToModel())).not.toContain(selected)
  expect(browser.workspaceRequests).toEqual([])
})
