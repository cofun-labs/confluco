// What the extension reads out of Clerk's publishable key (src/clerk.ts): the Frontend API host,
// and the host Clerk's Sync Host reads the signed-in client from.
import { describe, expect, it } from 'vitest'
import { clerkFrontendApi, clerkSyncHost } from '../src/clerk'

const SIGN_IN_HOST = 'https://confluco.example.com'
/** Keys as Clerk builds them: the Frontend API host and a `$`, in base64 without padding. */
const key = (prefix: string, host: string) => `${prefix}${btoa(`${host}$`).replace(/=+$/, '')}`
const PRODUCTION_KEY = key('pk_live_', 'clerk.example.com')
const DEVELOPMENT_KEY = key('pk_test_', 'calm-fox-1.clerk.accounts.dev')

describe('Clerk publishable key', () => {
  it('names the Frontend API host, with or without base64 padding', () => {
    expect(clerkFrontendApi(PRODUCTION_KEY)).toBe('clerk.example.com')
    expect(clerkFrontendApi(DEVELOPMENT_KEY)).toBe('calm-fox-1.clerk.accounts.dev')
    // `clerk.sample.cc$` is 16 bytes, so its base64 would end in `==`: Clerk leaves that out.
    expect(clerkFrontendApi('pk_live_Y2xlcmsuc2FtcGxlLmNjJA')).toBe('clerk.sample.cc')
    expect(clerkFrontendApi('pk_live_Y2xlcmsuc2FtcGxlLmNjJA==')).toBe('clerk.sample.cc')
  })

  it('names no host when it is empty or not a publishable key', () => {
    for (const bad of [
      '',
      'pk_live_',
      'pk_test_fake',
      'pk_live_***',
      `pk_live_${btoa('$')}`,
      `pk_live_${btoa('host')}`,
    ]) {
      expect(clerkFrontendApi(bad), bad).toBeUndefined()
    }
  })

  it('syncs a production instance from its Frontend API host', () => {
    expect(clerkSyncHost(PRODUCTION_KEY, SIGN_IN_HOST)).toBe('https://clerk.example.com')
  })

  it('syncs a development instance from the sign-in page', () => {
    expect(clerkSyncHost(DEVELOPMENT_KEY, SIGN_IN_HOST)).toBe(SIGN_IN_HOST)
    expect(clerkSyncHost('pk_test_fake', SIGN_IN_HOST)).toBe(SIGN_IN_HOST)
  })

  it('refuses a production key that names no host, instead of syncing from nowhere', () => {
    expect(() => clerkSyncHost('pk_live_', SIGN_IN_HOST)).toThrow('names no Frontend API host')
  })
})
