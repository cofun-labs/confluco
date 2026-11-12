import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// What the build reads from .env. Nothing is sent to these hosts: the tests answer every request.
const env = {
  VITE_API_URL: 'https://api.copilot.test/v1/',
  VITE_CLERK_PUBLISHABLE_KEY: 'pk_test_fake',
  VITE_CLERK_SYNC_HOST: 'https://copilot.test',
}

// The tests run without the build config (vite.config.ts), which needs the build's env.
export default defineConfig({
  test: {
    projects: [
      // The extension's client code, in Node, with the real modules.
      { test: { name: 'client', include: ['test/**/*.test.ts'], env } },
      // The side panel's UI, in a DOM. Only here is Clerk a fake; see test/clerk.tsx.
      {
        resolve: {
          alias: { '@clerk/chrome-extension': fileURLToPath(new URL('./test/clerk.tsx', import.meta.url)) },
        },
        test: { name: 'ui', include: ['test/**/*.test.tsx'], environment: 'jsdom', env },
      },
    ],
  },
})
