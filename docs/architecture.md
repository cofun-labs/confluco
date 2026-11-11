# Architecture

```text
Chrome MV3
  Confluence Cloud tab → tab URL and title → routing, session labels, per-question context
  React side panel → pi agent → authenticated Worker API → Workers AI
                   ↳ IndexedDB conversations and session labels, per Clerk user
                   ↳ client tool registry
  Sign-in tab → Clerk Sync Host → side panel session
```

The React and TypeScript extension uses Vite to build the side panel and its MV3 manifest. The service worker enables the panel on HTTPS Atlassian Cloud tabs with a `/wiki` path. The side panel's `CopilotAgent` runs the model and tool loop, emits streaming updates, handles cancellation, and supports confirmation before a tool runs. `extension/src/tools.ts` is the tool registry. Define new tools with the Zod-backed `defineTool` helper in `extension/src/tool.ts`.

The Worker serves `/login` and verifies Clerk bearer tokens for `/v1/me` and the OpenAI-compatible `/v1/chat/completions` API. It chooses the model, streams replies from Workers AI, tracks daily requests in a per-user Durable Object, and records usage metadata in Analytics Engine. AI Gateway is optional. The same API serves clients with different prompts or tool sets because the agent runs in the extension.

The tests exercise the agent and panel against the real Hono app with signed test JWTs and a fake model binding. Chrome for Testing loads the built extension and exercises tab routing and Clerk's signed-out state against local fixtures.
