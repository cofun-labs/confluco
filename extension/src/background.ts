// The manifest makes the panel available across tabs. The toolbar icon opens it.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error)
