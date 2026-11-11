import { z } from '../zod'

export function parseInstance(value: string) {
  try {
    const url = new URL(value.trim())
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      /[;]|%2f|%5c|%00/i.test(url.pathname) ||
      /(?:^|\.)atlassian\.net$/i.test(url.hostname)
    )
      return
    return {
      origin: url.origin,
      path: url.pathname.replace(/\/+$/, ''),
      permission: `${url.protocol}//${url.hostname}/*`,
    }
  } catch {
    return undefined
  }
}

export type Instance = NonNullable<ReturnType<typeof parseInstance>>

const instanceKey = (userId: string) => `confluence-instance:${userId}`

export async function getInstance(userId: string): Promise<Instance | undefined> {
  const key = instanceKey(userId)
  const saved = await chrome.storage.local.get(key)
  const url = z.string().safeParse(saved[key])
  if (url.success) return parseInstance(url.data)
}

/** Call directly from a user gesture so Chrome can ask for the site permission. */
export async function connectInstance(userId: string, instance: Instance): Promise<boolean> {
  if (!(await chrome.permissions.request({ origins: [instance.permission] }))) return false
  await chrome.storage.local.set({ [instanceKey(userId)]: instance.origin + instance.path })
  return true
}

export async function disconnectInstance(userId: string, instance: Instance): Promise<void> {
  await chrome.storage.local.remove(instanceKey(userId))
  // Chrome host grants are shared by all extension panels. Keep one another connection still uses.
  const all = await chrome.storage.local.get(null)
  const stillUsed = Object.entries(all).some(
    ([key, value]) =>
      key.startsWith('confluence-instance:') &&
      typeof value === 'string' &&
      parseInstance(value)?.permission === instance.permission,
  )
  if (!stillUsed) await chrome.permissions.remove({ origins: [instance.permission] })
}

export function matchesInstance(url: URL, instance: Instance): boolean {
  return (
    url.origin === instance.origin &&
    !url.username &&
    !url.password &&
    (url.pathname === instance.path || url.pathname.startsWith(instance.path + '/'))
  )
}
