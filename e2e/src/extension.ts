// The unpacked extension in Browser: is it enabled, where does Chrome load it from, and reloading it
// after a build. Read through chrome://extensions (chrome.developerPrivate), in a tab this tool opens
// and closes. It only reports problems such as Developer mode being off; it never changes settings.
import * as z from 'zod'
import { spawn } from 'node:child_process'
import { access, readFile, rename, rm } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { type Browser, type Target, sleep, until } from './cdp'

/** The extension's id, fixed by the public key in the manifest. */
export const EXTENSION_ID = process.env.E2E_EXTENSION_ID ?? 'fccfdaiibgaiblpkkmpfgoijmokbgfng'
export const EXTENSION_NAME = 'Confluco'

const ExtensionStatusSchema = z.object({
  developerMode: z.boolean(),
  extension: z
    .object({
      state: z.string(),
      location: z.string(),
      path: z.string().optional(),
      disableReasons: z.array(z.string()),
    })
    .optional(),
})
export type ExtensionStatus = z.infer<typeof ExtensionStatusSchema>

/** Why the extension can't run from a build of this checkout, or undefined if it can. */
export function problem(status: ExtensionStatus): string | undefined {
  if (!status.developerMode) {
    return (
      'Developer mode is off in chrome://extensions, so Chrome disables the unpacked extension. ' +
      'Turn it on there by hand; this tool never changes browser settings.'
    )
  }
  const ext = status.extension
  if (!ext)
    return `${EXTENSION_NAME} (${EXTENSION_ID}) is not installed in this Chrome profile. Load it unpacked by hand.`
  if (ext.location !== 'UNPACKED' || !ext.path) {
    return `${EXTENSION_NAME} is not loaded unpacked (${ext.location}), so a build can't replace it.`
  }
  if (ext.state !== 'ENABLED') {
    const why = ext.disableReasons.length ? ` (${ext.disableReasons.join(', ')})` : ''
    return `${EXTENSION_NAME} is ${ext.state.toLowerCase()}${why}. Enable it in chrome://extensions by hand.`
  }
  return undefined
}

/** Whether a manifest.json is this extension's build, so its folder is safe to build over. */
export function isOurManifest(text: string): boolean {
  return manifestOf(text)?.name === EXTENSION_NAME
}

/**
 * Why a new build must not replace the loaded one, or undefined if it may. The manifest `key` fixes
 * the extension id; a build with another key (or none) would load as another extension, without the
 * shared profile's storage and Confluco sign-in.
 */
export function replaceProblem(loaded: string, built: string): string | undefined {
  const key = (text: string) => manifestOf(text)?.key
  if (key(built) === key(loaded)) return undefined
  return (
    "The build's manifest key differs from the loaded extension's, so reloading would change the " +
    "extension id. Check CRX_PUBLIC_KEY in this checkout's extension/.env.local and .env.local."
  )
}

function manifestOf(text: string): { name?: unknown; key?: unknown } | undefined {
  try {
    return z.object({ name: z.unknown().optional(), key: z.unknown().optional() }).parse(JSON.parse(text))
  } catch {
    return undefined
  }
}

/** A chrome://extensions tab of our own, open for the duration of `fn`. */
export async function withExtensionsPage<T>(browser: Browser, fn: (page: Target) => Promise<T>): Promise<T> {
  const id = await browser.open(`chrome://extensions/?id=${EXTENSION_ID}`, { background: true })
  try {
    const page = await browser.attach(id)
    await until(
      () =>
        page.evaluate(
          () => (typeof chrome?.developerPrivate === 'object' ? true : undefined),
          [],
          z.boolean().optional(),
        ),
      {
        ms: 10_000,
        onTimeout: () => new Error('chrome://extensions did not load.'),
      },
    )
    return await fn(page)
  } finally {
    await browser.close(id)
  }
}

export function readStatus(page: Target): Promise<ExtensionStatus> {
  return page.evaluate(
    (id: string) =>
      new Promise<ExtensionStatus>((resolve) => {
        chrome.developerPrivate.getProfileConfiguration((config) => {
          chrome.developerPrivate.getExtensionInfo(id, (info) => {
            // getExtensionInfo reports an unknown id through lastError.
            const known = !chrome.runtime?.lastError && info
            const reasons = (known && info.disableReasons) || {}
            resolve({
              developerMode: config.inDeveloperMode,
              extension: known
                ? {
                    state: info.state,
                    location: info.location,
                    path: info.path,
                    disableReasons: Object.keys(reasons).filter((k) => reasons[k]),
                  }
                : undefined,
            })
          })
        })
      }),
    [EXTENSION_ID],
    ExtensionStatusSchema,
  )
}

/** Reloads the extension from its folder; resolves with Chrome's load error, if any. */
export function reloadExtension(page: Target): Promise<string | undefined> {
  return page.evaluate(
    (id: string) =>
      new Promise<string | undefined>((resolve) => {
        chrome.developerPrivate.reload(id, { failQuietly: true }, (loadError) => {
          const err = chrome.runtime?.lastError?.message
          resolve(err ?? (loadError ? `${loadError.error} (${loadError.path})` : undefined))
        })
      }),
    [EXTENSION_ID],
    z.string().optional(),
  )
}

/**
 * Builds this checkout's extension, with this checkout's extension/.env.local, and puts it in `outDir`. It
 * is built next to `outDir` first and replaces it only if it would load as the same extension.
 */
export async function build(repoRoot: string, outDir: string): Promise<void> {
  if (!isAbsolute(outDir)) throw new Error(`Chrome reported a relative extension folder: ${outDir}`)
  const manifest = await readFile(join(outDir, 'manifest.json'), 'utf8').catch(() => '')
  if (!isOurManifest(manifest)) {
    throw new Error(`${outDir} doesn't hold a build of ${EXTENSION_NAME}; not building over it.`)
  }
  const extension = join(repoRoot, 'extension')
  if (
    !(await access(join(extension, 'node_modules', '.bin', 'vite')).then(
      () => true,
      () => false,
    ))
  ) {
    throw new Error(`The extension's dependencies are not installed in ${repoRoot}: run pnpm install first.`)
  }
  const next = `${outDir}.next-${process.pid}`
  try {
    await viteBuild(extension, next)
    const stop = replaceProblem(manifest, await readFile(join(next, 'manifest.json'), 'utf8'))
    if (stop) throw new Error(stop)
    // Swap the folders so the shared extension folder is never left missing: the old build comes
    // back if the new one can't take its place.
    await swap(outDir, next)
  } finally {
    await rm(next, { recursive: true, force: true })
  }
}

async function swap(outDir: string, next: string): Promise<void> {
  const old = `${outDir}.old-${process.pid}`
  await rename(outDir, old)
  try {
    await rename(next, outDir)
  } catch (err) {
    await rename(old, outDir)
    throw err
  }
  await rm(old, { recursive: true, force: true })
}

async function viteBuild(extension: string, outDir: string): Promise<void> {
  const output: Buffer[] = []
  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn('pnpm', ['exec', 'vite', 'build', '--outDir', outDir, '--emptyOutDir'], {
      cwd: extension,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', (d: Buffer) => output.push(d))
    child.stderr.on('data', (d: Buffer) => output.push(d))
    child.on('error', reject)
    child.on('close', resolve)
  })
  if (code !== 0) throw new Error(`The extension build failed:\n${Buffer.concat(output).toString()}`)
}

/** Waits for the reloaded extension to report enabled again, and returns its status. */
export async function settledStatus(page: Target): Promise<ExtensionStatus> {
  let status = await readStatus(page)
  for (let i = 0; i < 20 && status.extension?.state !== 'ENABLED'; i++) {
    await sleep(250)
    status = await readStatus(page)
  }
  return status
}
