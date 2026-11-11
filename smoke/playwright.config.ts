import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'test',
  // One Chromium with the extension loaded per test is plenty for a smoke test.
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: 'list',
  timeout: 30_000,
})
