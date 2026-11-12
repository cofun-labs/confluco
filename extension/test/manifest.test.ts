import { readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'
import { describe, expect, it } from 'vitest'
import { buildManifest, type ManifestEnv } from '../manifest'

const syncHost = 'https://sign-in.example.com'
const clerkHost = 'clerk.example.com'
const publishableKey = `pk_live_${Buffer.from(`${clerkHost}$`).toString('base64')}`

function manifest(env: Partial<ManifestEnv> = {}) {
  return buildManifest({ VITE_CLERK_PUBLISHABLE_KEY: publishableKey, VITE_CLERK_SYNC_HOST: syncHost, ...env }, '1.2.3')
}

describe('extension manifest', () => {
  it('requests site access only at runtime for the Confluence transport', () => {
    const json = manifest({ VITE_API_URL: 'https://inference.example.net/v1' })
    expect(json.name).toBe('Confluco')
    expect(json.permissions).toEqual(['sidePanel', 'storage', 'tabs', 'cookies', 'scripting'])
    expect(json).not.toHaveProperty('content_scripts')
    expect(json.optional_host_permissions).toEqual(['http://*/*', 'https://*/*'])
    expect(json.host_permissions).toEqual([
      `https://${clerkHost}/*`,
      `${syncHost}/*`,
      'https://inference.example.net/*',
      'https://*.example.com/*',
    ])
    expect(json.content_security_policy.extension_pages).toBe(
      "default-src 'self'; script-src 'self'; object-src 'self'; style-src 'self' 'unsafe-inline'; " +
        `connect-src 'self' https://inference.example.net https://${clerkHost}; ` +
        "img-src 'self' data: blob: https://img.clerk.com",
    )
  })

  // The checked-in build config, read from the file itself so a local .env.local can't change it.
  // PRIVACY.md lists these hosts; a change here changes that table too.
  it('allows only the hosts of the hosted Confluco in the checked-in config', () => {
    const env = parseEnv(readFileSync(new URL('../.env', import.meta.url), 'utf8'))
    const json = buildManifest(
      {
        VITE_CLERK_PUBLISHABLE_KEY: env.VITE_CLERK_PUBLISHABLE_KEY,
        VITE_CLERK_SYNC_HOST: env.VITE_CLERK_SYNC_HOST ?? '',
        VITE_API_URL: env.VITE_API_URL,
      },
      '1.2.3',
    )
    expect(json.host_permissions).toEqual([
      'https://clerk.cofun.cc/*',
      'https://confluco-api.cofun.cc/*',
      'https://*.cofun.cc/*',
    ])
    expect(json.content_security_policy.extension_pages).toBe(
      "default-src 'self'; script-src 'self'; object-src 'self'; style-src 'self' 'unsafe-inline'; " +
        "connect-src 'self' https://confluco-api.cofun.cc https://clerk.cofun.cc; " +
        "img-src 'self' data: blob: https://img.clerk.com",
    )
  })

  it('uses the configured parent domain for Clerk cookies', () => {
    expect(
      manifest({ VITE_CLERK_SYNC_HOST: 'https://app.example.co.uk', CLERK_COOKIE_DOMAIN: '.example.co.uk' })
        .host_permissions,
    ).toContain('https://*.example.co.uk/*')
  })

  it('uses a single host permission for a local Worker that also serves sign-in', () => {
    const local = 'http://127.0.0.1:8787'
    const json = manifest({ VITE_CLERK_SYNC_HOST: local, VITE_API_URL: `${local}/v1` })
    expect(json.host_permissions).toEqual([`https://${clerkHost}/*`, 'http://127.0.0.1/*'])
    expect(json.content_security_policy.extension_pages).toContain(`connect-src 'self' ${local} https://${clerkHost};`)
  })

  it('pins the extension ID only when a public key is configured', () => {
    expect(manifest()).not.toHaveProperty('key')
    expect(manifest({ CRX_PUBLIC_KEY: 'public-key' })).toMatchObject({ key: 'public-key', version: '1.2.3' })
  })

  it('lists toolbar icons with the expected dimensions', () => {
    const json = manifest()
    expect(Object.keys(json.icons)).toEqual(['16', '32', '48', '128'])
    expect(json.action.default_icon).toEqual(json.icons)
    for (const [size, file] of Object.entries(json.icons)) {
      const png = readFileSync(new URL(`../public/${file}`, import.meta.url))
      expect(png.subarray(1, 4).toString('latin1')).toBe('PNG')
      expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([Number(size), Number(size)])
    }
  })
})
