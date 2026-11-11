import { confluenceUrl } from './confluence/tab'

// Clicking the toolbar icon opens the side panel.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((err) => console.error(err))

// A tab can close between an event and our call; that's not an error.
function ignoreClosedTab(err: unknown) {
  if (!String(err).includes('No tab with id')) console.error(err)
}

// Only enable the panel on Confluence Cloud tabs.
async function updatePanel(tabId: number, url?: string) {
  await chrome.sidePanel.setOptions(
    confluenceUrl(url) ? { tabId, path: 'sidepanel.html', enabled: true } : { tabId, enabled: false },
  )
}

// Off by default, so tabs we haven't seen yet don't get the panel. Tabs that
// were already open when the extension started get their state set here.
async function init() {
  await chrome.sidePanel.setOptions({ enabled: false })
  const tabs = await chrome.tabs.query({})
  await Promise.all(
    tabs.map((tab) => (tab.id === undefined ? undefined : updatePanel(tab.id, tab.url).catch(ignoreClosedTab))),
  )
}

// Chrome forgets side panel options whenever the extension unloads (disable,
// reload, update) or the browser restarts, and then falls back to the
// manifest default. The manifest sets no default path, so that means no panel. storage.session is cleared at the
// same moments, so a missing flag means the options need setting again.
// Checking on every service worker start also covers disable/re-enable, which
// fires neither onInstalled nor onStartup.
chrome.storage.session
  .get('panelInit')
  .then(async ({ panelInit }) => {
    if (panelInit) return
    await init()
    await chrome.storage.session.set({ panelInit: true })
  })
  .catch(console.error)

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.url || info.status === 'complete') updatePanel(tabId, tab.url).catch(ignoreClosedTab)
})

chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs
    .get(tabId)
    .then((tab) => updatePanel(tabId, tab.url))
    .catch(ignoreClosedTab)
})
