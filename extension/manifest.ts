// Builds the extension's manifest.json from env values. vite.config.ts writes the result into the
// build, and test/manifest.test.ts pins its permissions: Chrome disables an installed extension
// on update when the new version adds a permission warning, so a permission must never
// change unnoticed. It also pins the content security policy, which names the hosts
// the extension's pages may contact (see PRIVACY.md).

/** The env values the manifest is built from (see .env). */
export interface ManifestEnv {
  VITE_CLERK_PUBLISHABLE_KEY?: string
  VITE_CLERK_SYNC_HOST: string
  CLERK_COOKIE_DOMAIN?: string
  CRX_PUBLIC_KEY?: string
  /** Worker base URL. Optional here so the manifest can be built without it; the build requires it. */
  VITE_API_URL?: string
}

/** The icon (icons/icon.svg) at each size Chrome asks for; `pnpm icons` exports them into public/icons. */
const ICONS = { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png', 48: 'icons/icon-48.png', 128: 'icons/icon-128.png' }

/** Clerk serves user avatars and provider icons from here, for every instance. */
const CLERK_IMAGE_HOST = 'img.clerk.com'

/** Clerk's Frontend API host is encoded in the publishable key: pk_test_<base64("host$")>. */
function clerkFrontendApi(publishableKey: string): string | undefined {
  const encoded = publishableKey.split('_')[2]
  if (!encoded) return undefined
  return Buffer.from(encoded, 'base64').toString('utf8').replace(/\$$/, '')
}

/**
 * Host permission covering the domain Clerk sets __client_uat on: the sign-in
 * page's registrable domain (e.g. confluco.example.com -> *.example.com).
 * The last two labels are a guess that fits hosts like example.com; set
 * CLERK_COOKIE_DOMAIN for suffixes such as example.co.uk. IPs and single-label
 * hosts (localhost) get a permission for the host itself.
 */
function clerkCookiePermission(syncHost: string, cookieDomain?: string): string {
  const { protocol, hostname } = new URL(syncHost)
  const labels = hostname.split('.')
  if (cookieDomain) return `${protocol}//*.${cookieDomain.replace(/^\./, '')}/*`
  if (labels.length < 2 || /^[\d.]+$/.test(hostname) || hostname.includes(':')) return `${protocol}//${hostname}/*`
  return `${protocol}//*.${labels.slice(-2).join('.')}/*`
}

/**
 * The policy for the extension's own pages (the side panel and the service worker). Chrome's
 * default only limits scripts; this one limits every kind of load to the extension itself, except
 * requests, which may also go to the worker and Clerk's Frontend API, and images, which may also
 * come from Clerk's image host. So the browser itself enforces the host list in PRIVACY.md.
 */
function contentSecurityPolicy(env: ManifestEnv): string {
  const clerkHost = clerkFrontendApi(env.VITE_CLERK_PUBLISHABLE_KEY ?? '')
  const connect = [
    ...new Set([
      ...(env.VITE_API_URL ? [new URL(env.VITE_API_URL).origin] : []),
      ...(clerkHost ? [`https://${clerkHost}`] : []),
    ]),
  ]
  return [
    // Everything not named below (frames, fonts, media, workers) loads from the extension only.
    "default-src 'self'",
    "script-src 'self'",
    "object-src 'self'",
    // Clerk's components add their styles as inline <style> elements.
    "style-src 'self' 'unsafe-inline'",
    ["connect-src 'self'", ...connect].join(' '),
    `img-src 'self' data: blob: https://${CLERK_IMAGE_HOST}`,
  ].join('; ')
}

function hostPermission(url: string): string {
  const { protocol, hostname } = new URL(url)
  return `${protocol}//${hostname}/*`
}

/** The manifest for the given env and package version. */
export function buildManifest(env: ManifestEnv, version: string) {
  const clerkHost = clerkFrontendApi(env.VITE_CLERK_PUBLISHABLE_KEY ?? '')
  return {
    manifest_version: 3,
    name: 'Confluco',
    version,
    description: 'An AI side panel for Confluence.',
    ...(env.CRX_PUBLIC_KEY ? { key: env.CRX_PUBLIC_KEY } : {}),
    icons: ICONS,
    // Tab URLs are used for page context and to associate local sessions with pages.
    permissions: ['sidePanel', 'storage', 'tabs', 'cookies'],
    host_permissions: [
      ...new Set([
        ...(clerkHost ? [`https://${clerkHost}/*`] : []),
        // Sign-in page; the cookies permission reads its Clerk session (Sync Host).
        hostPermission(env.VITE_CLERK_SYNC_HOST),
        ...(env.VITE_API_URL ? [hostPermission(env.VITE_API_URL)] : []),
        // Clerk sets __client_uat on the parent domain (e.g. .kitfun.cc). The side
        // panel watches it to notice sign-in and sign-out, and Chrome only reports
        // cookies whose domain the extension has host permission for.
        clerkCookiePermission(env.VITE_CLERK_SYNC_HOST, env.CLERK_COOKIE_DOMAIN),
      ]),
    ],
    content_security_policy: { extension_pages: contentSecurityPolicy(env) },
    background: { service_worker: 'background.js', type: 'module' },
    side_panel: { default_path: 'sidepanel.html' },
    action: { default_title: 'Open Confluco', default_icon: ICONS },
  }
}
