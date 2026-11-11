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
      url.hostname.includes('*') ||
      /[;]|%2f|%5c|%00/i.test(url.pathname) ||
      /(?:^|\.)atlassian\.net$/i.test(url.hostname)
    )
      return
    const port = url.port || (url.protocol === 'https:' ? '443' : '80')
    return {
      origin: url.origin,
      path: url.pathname.replace(/\/+$/, ''),
      permission: `${url.protocol}//${url.hostname}:${port}/*`,
    }
  } catch {
    return undefined
  }
}

export type Instance = NonNullable<ReturnType<typeof parseInstance>>

const instanceKey = (userId: string) => `confluence-instance:${userId}`
const connectionLock = 'confluence-connections'

export async function getInstance(userId: string): Promise<Instance | undefined> {
  const key = instanceKey(userId)
  const saved = await chrome.storage.local.get(key)
  const url = z.string().safeParse(saved[key])
  if (url.success) return parseInstance(url.data)
}

/** Call directly from a user gesture so Chrome can ask for the site permission. */
export async function connectInstance(userId: string, instance: Instance): Promise<boolean> {
  const origins = [instance.permission]
  if (!(await chrome.permissions.request({ origins }))) return false
  return navigator.locks.request(connectionLock, async () => {
    if (!(await chrome.permissions.contains({ origins }))) return false
    const previous = await getInstance(userId)
    try {
      await chrome.storage.local.set({ [instanceKey(userId)]: instance.origin + instance.path })
    } catch (error) {
      await releaseUnusedPermission(instance.permission)
      throw error
    }
    if (previous && previous.permission !== instance.permission) await releaseUnusedPermission(previous.permission)
    return true
  })
}

export function disconnectInstance(userId: string, instance: Instance): Promise<Instance | undefined> {
  return navigator.locks.request(connectionLock, async () => {
    const current = await getInstance(userId)
    if (current?.origin !== instance.origin || current.path !== instance.path) return current
    await chrome.storage.local.remove(instanceKey(userId))
    await releaseUnusedPermission(instance.permission)
  })
}

async function releaseUnusedPermission(permission: string): Promise<void> {
  // Chrome host grants are shared by all extension panels. Keep one another connection still uses.
  const all = await chrome.storage.local.get(null)
  const stillUsed = Object.entries(all).some(
    ([key, value]) =>
      key.startsWith('confluence-instance:') &&
      typeof value === 'string' &&
      parseInstance(value)?.permission === permission,
  )
  if (!stillUsed) await chrome.permissions.remove({ origins: [permission] })
}

export function matchesInstance(url: URL, instance: Instance): boolean {
  return (
    url.origin === instance.origin &&
    !url.username &&
    !url.password &&
    (url.pathname === instance.path || url.pathname.startsWith(instance.path + '/'))
  )
}
