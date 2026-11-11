/**
 * The sign-in page the extension opens in a tab. Clerk's session cookie lands on
 * this domain, and the extension picks it up through Clerk's Sync Host.
 * Social logins (Google etc.) work here because this is a normal web page.
 */

/** Clerk's Frontend API host is encoded in the publishable key: pk_test_<base64("host$")>. */
function clerkFrontendApi(publishableKey: string): string {
  return atob(publishableKey.split('_')[2] ?? '').replace(/\$$/, '')
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

export function loginPage(publishableKey: string): string {
  const fapi = clerkFrontendApi(publishableKey)
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Sign in · Confluco</title>
<style>
  :root { --bg: #f7f7f5; --fg: #1f1f1f; --muted: #6b6b6b; }
  @media (prefers-color-scheme: dark) { :root { --bg: #191919; --fg: #e6e6e6; --muted: #9b9b9b; } }
  body { margin: 0; min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 16px;
         background: var(--bg); color: var(--fg); font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  h1 { font-size: 20px; margin: 0; }
  p { color: var(--muted); margin: 0; text-align: center; }
  #signed-in { display: none; flex-direction: column; align-items: center; gap: 12px; }
  button { font: inherit; padding: 6px 14px; border-radius: 6px; border: 1px solid #ccc; background: transparent; color: inherit; cursor: pointer; }
</style>
</head>
<body>
<h1>Confluco</h1>
<div id="sign-in"></div>
<div id="signed-in">
  <p>You're signed in. Go back to Confluence and open the Confluco side panel.</p>
  <button id="sign-out">Sign out</button>
</div>
<script defer crossorigin="anonymous" src="https://${esc(fapi)}/npm/@clerk/ui@1/dist/ui.browser.js"></script>
<script defer crossorigin="anonymous"
  data-clerk-publishable-key="${esc(publishableKey)}"
  src="https://${esc(fapi)}/npm/@clerk/clerk-js@6/dist/clerk.browser.js"></script>
<script>
  window.addEventListener('load', start)
  async function start() {
    // Keep the whole flow on this page. Without signInUrl/signUpUrl, Clerk sends
    // steps it can't finish here (OAuth sign-up continuation, Protect checks) to
    // its hosted Account Portal, which can't redirect back to this domain.
    await window.Clerk.load({
      ui: { ClerkUI: window.__internal_ClerkUICtor },
      signInUrl: location.pathname,
      signUpUrl: location.pathname,
    })
    // Clerk calls listeners on every resource change, including mid-flow steps
    // like the Protect check. Remounting SignIn on each call restarts the flow,
    // so only mount or unmount when the signed-in state actually changes.
    let shown = null
    const render = () => {
      const signedIn = !!window.Clerk.user
      if (signedIn === shown) return
      shown = signedIn
      document.getElementById('signed-in').style.display = signedIn ? 'flex' : 'none'
      const box = document.getElementById('sign-in')
      if (signedIn) window.Clerk.unmountSignIn(box)
      else window.Clerk.mountSignIn(box, {
          routing: 'hash',
          withSignUp: true,
          fallbackRedirectUrl: location.pathname,
          signUpFallbackRedirectUrl: location.pathname,
        })
    }
    window.Clerk.addListener(render)
    render()
    document.getElementById('sign-out').onclick = () => window.Clerk.signOut()
  }
</script>
</body>
</html>`
}
