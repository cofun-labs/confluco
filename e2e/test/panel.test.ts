import { expect, it } from 'vitest'
import { Browser } from '../src/cdp'
import { pageTab } from '../src/panel'
import type { State } from '../src/state'

it('waits for the first navigation instead of treating the initial blank document as a loaded website', async () => {
  const url = 'https://example.com/'
  let pageUrl = 'about:blank'
  const browser = new Browser({
    async send(method, params = {}) {
      switch (method) {
        case 'Target.createTarget':
          return { targetId: 'test-page' }
        case 'Target.attachToTarget':
          return { sessionId: 'test-session' }
        case 'Page.navigate':
          if ('url' in params && typeof params.url === 'string') pageUrl = params.url
          return { loaderId: 'test-loader' }
        case 'Runtime.evaluate':
          return { result: { objectId: 'global' } }
        case 'Runtime.callFunctionOn':
          return {
            result: {
              value:
                'functionDeclaration' in params &&
                typeof params.functionDeclaration === 'string' &&
                params.functionDeclaration.includes('location.href')
                  ? { url: pageUrl }
                  : undefined,
            },
          }
        default:
          return {}
      }
    },
  })
  const state: State = {}
  expect((await pageTab(browser, state, url)).targetId).toBe('test-page')
  expect(state.pageTarget).toBe('test-page')
  expect(pageUrl).toBe(url)
})
