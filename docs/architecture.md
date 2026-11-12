# Architecture

How Confluco is built, and why. For setup and deployment see [development.md](development.md); for the workflow and coding rules see [AGENTS.md](../AGENTS.md).

```text
Chrome
  Confluence tab → metadata and requested published page text → side panel
  Side panel → Clerk bearer token and conversation → Worker → AI Gateway → Workers AI
  Sign-in tab → Clerk Sync Host → side panel session
```

The agent loop runs in the side panel. The Worker verifies the user and passes the conversation to the model. Each question includes the current supported Confluence page's title and canonical URL, read from Chrome's tab metadata. Workspace tools can read, search and navigate an explicitly connected self-managed instance, inspect version history and access, manage labels, and create or rename published pages at the user's request.

## Tech choices

| Area | Choice | Why |
|---|---|---|
| Extension | Chrome MV3 + [Side Panel API](https://developer.chrome.com/docs/extensions/reference/api/sidePanel) | Sits next to the current page and stays available across sites |
| Extension build | Vite + React + TypeScript | Clerk's extension SDK is React-based; Vite needs little config and no extension framework |
| Sign-in | [Clerk](https://clerk.com) (`@clerk/chrome-extension`) with [Sync Host](https://clerk.com/docs/references/chrome-extension/sync-host) | Ready-made sign-in UI and sessions; the backend only verifies JWTs with a public key. Social logins need a redirect, which Chrome side panels don't support, so users sign in on a normal web page and the session syncs into the extension |
| Backend | Cloudflare Workers + Hono | Model access stays server-side; the AI binding needs no API token |
| Model | Workers AI through AI Gateway | No third-party API keys; the gateway adds logs, caching, and per-user analytics |
| API shape | OpenAI-compatible `/v1/chat/completions` | A common streaming format, so the extension doesn't change if the model or backend does |
| Agent runtime | [`@earendil-works/pi-agent-core`](https://www.npmjs.com/package/@earendil-works/pi-agent-core), wrapped in `extension/src/agent.ts` | Tool loop, events, abort, and tool hooks in a small package; it runs in the side panel because tools act on the browser. Only `agent.ts` imports it, so it can be replaced |
| Deploy | Cloudflare Workers Builds (Git integration) | Cloudflare pulls the repo and deploys on merge to `main`; no Cloudflare credentials stored on GitHub |

## Auth flow

1. The user clicks "Sign in" in the side panel. The extension opens the worker's `/login` page (`https://confluco-api.cofun.cc/login`) in a new tab; the worker serves this page with Clerk's sign-in UI. The Cofun products share one Clerk application on `cofun.cc`, so an account signed in for one product is signed in for the others.
2. After sign-in, Clerk's client cookie lives on the Frontend API host (`clerk.cofun.cc`) for a production instance, or on the sign-in page's host for a development instance (`extension/src/clerk.ts` picks the host from the publishable key). The extension is configured with that host as `syncHost` and uses the `cookies` permission to read that session. Clerk doesn't refresh an already-open side panel, so the extension watches those cookies and reloads the panel when they change.
3. Before each request, the extension gets a short-lived session JWT with `getToken()` and sends it as `Authorization: Bearer`.
4. The worker verifies the JWT locally with Clerk's JWT public key (signature, expiry). If the token has an `azp` (the web origin that requested it), it must be an allowed origin, which stops other websites from using a session they obtained in the browser. Tokens the extension gets through Clerk's Native API carry no `azp`. No network call to Clerk is needed.
5. The worker counts the request against the user's daily quota (a Durable Object per user, reset at 00:00 UTC) and refuses it once the quota is used up.
6. The request goes through AI Gateway (`cofun-ai-gateway`, shared by the Cofun products) to Workers AI, tagged with the product (`metadata.app`) and the Clerk user id for per-product and per-user analytics. Gateway log collection is off (`collectLog: false`), so the gateway keeps request analytics but not prompts or replies.
7. The worker writes one usage record for the request (see [Usage records](development.md#usage-records)).

The manifest's public `key`, when configured, pins the extension ID across local builds. Authentication comes from Clerk's verified session token.

## Sessions

Conversations are saved in the extension's IndexedDB, one database per Clerk user (`confluco-sessions-<userId>`), and never sent to the worker beyond what the model needs for the current question. They stay after sign-out so the user can pick up again, and they are not encrypted: keeping accounts apart only means one account's panel never shows another's sessions. Anyone with access to the Chrome profile can read them, tool results included, such as the content of Confluence pages the agent read (for example in DevTools).

## Tool execution

Tools register in `extension/src/tools.ts`. A tool's arguments, validation and JSON Schema come from one Zod schema through `defineTool`. The agent runs tools sequentially, streams their progress to the panel, supports per-call confirmation, and preserves completed tool history when a question is interrupted. Errors can stop a question and report whether data may have changed. The panel captures the active tab and configured instance when the question is sent. The shared transport uses that tab's isolated extension world for same-origin REST. It checks the document still matches the captured URL, refuses redirects and validates the transport result. Tools validate REST data, bound their output and generate canonical source links. Paginated reads use validated offsets to repeat the original request. Page references include the instance and page ID. Chrome site access is requested at connect time. Confluence cookies stay with the tab, and requested data goes to the model as tool results.

The version list uses the experimental version endpoint on Confluence 8.5 when available. The current version and direct historical reads use the supported content endpoint. Access metadata is advisory. Before sending a question to the model, the panel records directly requested label changes from the user's message. The tool can apply those changes on the current published page in the requested order. It rechecks the page before writing and reads the labels back before reporting success. An uncertain write stops the question and asks the user to check the page.

For page creation and rename, the panel takes the exact title, chosen target and any creation text from the user's message. The tool resolves the target and prepares a preview before executing that request. Creation checks for the title in the chosen space first. Rename submits the next published version with the original storage body. Both read the page back before reporting success.

Text edits bind the quoted passage and replacement to the user's current request. The preview resolves a unique text range in the published storage and shows the target and replacement. Before applying the edit, the tool checks the original page and version again. It replaces that range in the original storage and verifies the next version and full body. An uncertain response allows a verification read if the question is still running. The write is attempted once.

Trash and restore use the page ID chosen in the user's request. The tool previews the target, checks its state again before changing it, and reads back the resulting state and version. The trash request is scoped to published content, which Confluence moves to recoverable trash. The tool refuses top-level pages, pages with reported children and pages with access restrictions that might be lost on restore. The user confirms the trash action because the provider can move hidden child pages and restores pages to the space root. Restoration by link requires the user to review the access warning because the original access can be unknown. The restore request supplies the next version number and verification reports the version actually returned.

The saved conversation keeps a local undo record for its latest verified text edit or trash action. Before another workspace write starts, the panel clears the saved record so it cannot become stale if the conversation closes during the write. One undo tool selects the reversal from that record. It reconstructs the original text edit from earlier storage or uses the saved page reference to restore it from the trash. Trash undo also compares the time Confluence reports for the trash action. If the instance did not provide a time, undo requires the same access review as a restore by link.

## Layout

```
extension/                Chrome extension
  vite.config.ts          build config; writes configured dist or fixture-only dist-smoke
  .env                    public build config of the hosted Confluco; .env.local overrides it
  manifest.ts             builds manifest.json from .env; a test pins its permissions and content security policy
  icons/icon.svg          the extension icon; `pnpm icons` exports it into public/icons, which the manifest lists
  sidepanel.html
  src/background.ts       opens the side panel from the toolbar icon
  src/clerk.ts            what the build and the panel read out of Clerk's publishable key
  src/agent.ts            agent loop (pi) against the worker; the only module that imports pi
  src/tools.ts            tools the agent runs in the extension
  src/tool.ts             defines a tool from one zod schema of its arguments
  src/zod.ts              zod, set up for the extension's content security policy; the only module that imports it
  src/sessions.ts         saved sessions (IndexedDB, per user)
  src/confluence/tab.ts   Cloud and self-hosted URL recognition and per-question tab metadata
  src/confluence/instance.ts  configured base URL and optional Chrome site permission
  src/confluence/transport.ts  isolated-world REST transport bound to the captured tab and instance
  src/confluence/read-page.ts  current published-page read
  src/confluence/navigation.ts  search, space browsing and page hierarchy
  src/confluence/history.ts  published versions and reported page access
  src/confluence/labels.ts  paginated labels and requested mutations
  src/confluence/page-writes.ts  authorized creation, rename and text edits with read-back
  src/confluence/storage-edit.ts  exact text replacement in original page storage
  src/sidepanel/          React UI (main.tsx: sign-in, Chat.tsx: chat, Sessions.tsx: saved sessions,
                          ToolCall.tsx: one tool call and its changes)
  test/                   tests of client code and the whole panel in jsdom
                          (*.test.tsx)
worker/                   Cloudflare Worker
  src/app.ts              Hono app: Clerk JWT verification + /v1/chat/completions
  src/quota.ts            per-user daily request quota (UserQuota Durable Object in src/index.ts)
  src/usage.ts            per-request usage records (Workers Analytics Engine), no message content
  src/login.ts            sign-in page (Clerk Sync Host)
  test/                   REST integration tests (real signed JWTs, fake AI binding), and the
                          extension's agent run against the worker
e2e/                      pnpm e2e: drives the shared Chrome for Testing over CDP for ai-e2e runs
                          (maintainer's machine only; its unit tests run in pnpm test)
smoke/                    pnpm smoke: loads the built extension into Chromium and checks that it
                          still works (Confluence and Clerk answered from fixtures; runs in CI)
docs/
  architecture.md         this file
  development.md          setup, deployment, and repository settings
  assets/                 pictures used by README.md
  bdd.md                  how use cases and scenarios are written, and how to run ai-e2e scenarios
  use-cases/              use cases by domain; tests reference their scenario IDs
.oxlintrc.json            lint rules, including the extension's module boundaries
.github/rulesets/         GitHub branch rulesets (export format)
.github/workflows/        CI, CodeQL, dependency review, workflow lint, Claude review, and Claude on request
.github/dependabot.yml    weekly dependency updates
scripts/
  sync-github-settings.sh applies the rulesets and repository options with gh
README.md                 what the extension does and how to use it
PRIVACY.md                what data the extension reads, where it goes, and what is kept
AGENTS.md                 development workflow and conventions (CLAUDE.md links here)
```
