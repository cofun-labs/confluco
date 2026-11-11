// pnpm icons: renders the extension icon (extension/icons/icon.svg) into the PNGs the manifest
// lists (extension/public/icons/), with Playwright's Chromium. Run it after editing the SVG and
// commit the PNGs.
import { chromium } from '@playwright/test'
import { mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const EXTENSION = path.resolve(import.meta.dirname, '../extension')
const OUT = path.join(EXTENSION, 'public/icons')
/** The sizes extension/manifest.ts lists. */
const SIZES = [16, 32, 48, 128]

const svg = readFileSync(path.join(EXTENSION, 'icons/icon.svg'), 'utf8')
mkdirSync(OUT, { recursive: true })
const browser = await chromium.launch({ channel: 'chromium' })
for (const size of SIZES) {
  const page = await browser.newPage({ viewport: { width: size, height: size } })
  await page.setContent(`<style>html,body{margin:0}svg{display:block;width:100vw;height:100vh}</style>${svg}`)
  await page.screenshot({ path: path.join(OUT, `icon-${size}.png`), omitBackground: true })
  await page.close()
}
await browser.close()
