// What the extension reads out of Clerk's publishable key. The build (manifest.ts) and the side
// panel both use it, so the hosts the manifest allows are the hosts the panel talks to.

/**
 * Clerk's Frontend API host, which the publishable key encodes: `pk_test_` (a development
 * instance) or `pk_live_` (a production instance), then base64 of the host and a `$`. Clerk
 * leaves the base64 padding out. Undefined when the key names no host.
 */
export function clerkFrontendApi(publishableKey: string): string | undefined {
  const encoded = publishableKey.split('_')[2]
  if (!encoded) return undefined
  let decoded: string
  try {
    decoded = atob(encoded)
  } catch {
    return undefined
  }
  return decoded.endsWith('$') && decoded.length > 1 ? decoded.slice(0, -1) : undefined
}

/**
 * The host Clerk's Sync Host reads the signed-in client from. A production instance keeps its
 * client cookie on its Frontend API host (`clerk.<domain>`); a development instance keeps it on
 * the page that signed in, which is the sign-in page.
 */
export function clerkSyncHost(publishableKey: string, signInHost: string): string {
  if (!publishableKey.startsWith('pk_live_')) return signInHost
  const frontendApi = clerkFrontendApi(publishableKey)
  if (!frontendApi) throw new Error('The Clerk publishable key names no Frontend API host.')
  return `https://${frontendApi}`
}
