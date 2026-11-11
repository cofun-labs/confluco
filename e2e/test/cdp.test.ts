import { describe, expect, it } from 'vitest'
import * as z from 'zod'
import { Browser, Target } from '../src/cdp'

class FakeCdp {
  readonly calls: { method: string; params: object }[] = []
  value: unknown = 'Ready'
  exception?: { text: string }

  async send(method: string, params: object = {}): Promise<unknown> {
    this.calls.push({ method, params })
    if (method === 'Runtime.evaluate') return { result: { objectId: 'global-1' } }
    if (method === 'Runtime.callFunctionOn') return { result: { value: this.value }, exceptionDetails: this.exception }
    if (method === 'Target.getTargets') return this.value
    return {}
  }
}

describe('browser protocol boundaries', () => {
  it('validates a page result and releases the remote object after a malformed result', async () => {
    const cdp = new FakeCdp()
    const target = new Target(cdp, 'target-1', 'session-1')
    expect(await target.evaluate(() => document.title, [], z.string())).toBe('Ready')
    cdp.value = { unexpected: true }
    await expect(target.evaluate(() => document.title, [], z.string())).rejects.toThrow()
    expect(cdp.calls.filter((call) => call.method === 'Runtime.releaseObject')).toHaveLength(2)
  })

  it('reports a browser script error and still releases its object', async () => {
    const cdp = new FakeCdp()
    cdp.exception = { text: 'The page failed' }
    await expect(new Target(cdp, 'target-1', 'session-1').evaluate(() => {}, [], z.undefined())).rejects.toThrow(
      'The page failed',
    )
    expect(cdp.calls.at(-1)?.method).toBe('Runtime.releaseObject')
  })

  it('refuses a target list with an invalid shape', async () => {
    const cdp = new FakeCdp()
    cdp.value = { targetInfos: [{ targetId: 'target-1', url: 123 }] }
    await expect(new Browser(cdp).targets()).rejects.toThrow()
    cdp.value = { targetInfos: [{ targetId: 'target-1', type: 'page', url: 'about:blank', attached: false }] }
    expect(await new Browser(cdp).targets()).toHaveLength(1)
  })
})
