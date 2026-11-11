# BDD Workflow Specification

Use cases record the **product behavior contract**: what users and clients can rely on, independent of the UI, libraries, or code. Tests prove it. Use cases are not a catalog of every behavior, test, or bug.

## What goes into a use case

Before adding or changing a scenario, ask two questions:

1. **Implementation swap:** if the UI, framework, or internals were replaced, would the product owner still need to review this sentence? If not, it is not a scenario.
2. **Gap:** does an existing behavior or scenario already express it? If so, reuse it.

Never write into a use case:

- HTTP status codes, API fields, error codes, headers, CORS, endpoints, functions, libraries, config.
- Bug reproduction steps or fix history.
- UI layout, wording, loading or error presentation.
- Retries, timeouts, caching, races, and other implementation risks.
- Combinations of every parameter, role, or input.

These can still be worth testing. Write them as **standalone tests**: same integration-test style, but without a scenario ID in the name.

## Structure

| Part | Contents |
|---|---|
| **Use case** | One user goal, e.g. "ask the AI from the side panel". One file per goal. Split by goal, not by UI area, endpoint, or mechanism. |
| **Behavior** | Who needs it, what they get, and the few boundaries needed to understand it. Not a list of rules. |
| **Key constraint** | Optional. Only a prohibition or invariant that holds across several scenarios and changes what the capability is. Each needs at least one scenario. |
| **Scenario** | One representative example, as one line: `Given …; when …; then …`. Only branches with their own product meaning: the main success path, rejections that matter, and real boundaries. |

A scenario earns its place only if deleting it would let an implementation pass the remaining scenarios while breaking the product contract.

## Strategy

| Strategy | Use for | Verified by |
|---|---|---|
| `api-test` | Anything observable through the worker's HTTP API, the extension's client code, or the side panel's UI | A vitest integration test whose name starts with the scenario ID, in `worker/test/` (the worker's HTTP API) or `extension/test/` (the extension's client code in `*.test.ts`, the side panel's UI in `*.test.tsx`) |
| `ai-e2e` | Paths that need real Chrome or real accounts: the side panel opening on Confluence tabs, Clerk sign-in, real Confluence pages, the real model | An agent drives Chrome with the extension loaded; the PR description or a comment records the run |

Pick the cheapest strategy that observes the result directly. `ai-e2e` is not a place to park scenarios that could be `api-test`.

## Testing the side panel's UI

What the user sees and does in the side panel is an `api-test` too: `extension/test/*.test.tsx` run the panel in a DOM (jsdom), without a browser.

- **The whole panel runs.** A test opens the panel the way `sidepanel.html` does (`FakeBrowser` in `extension/test/panel.ts`), with the real agent, tools, and session store behind it and the real worker answering its model calls. Don't render a component on its own.
- **Only what a user can do and see.** Tests type, click, and read the screen, finding things by role, accessible name, label, or visible text. They never reach into component state, the agent, or the session store. When an element has no such handle, give it one that also helps a screen reader, not a test id.
- **Fakes only at the edges:** `chrome.*` with a Confluence tab (`FakeBrowser`), Clerk (`extension/test/clerk.tsx`), IndexedDB (`fake-indexeddb`), and the model (`FakeAiBinding`). Besides the screen, a test may look at those edges: what the model was sent, and which tab metadata was provided.
- **No real time.** The clock is fake and starts at a fixed time; a test that needs time to pass moves it. No sleeps, and no waiting for a timeout to pass. To catch the panel midway (a reply still streaming), hold the fake at the edge and release it.

A fake model answers what the test scripts, so these tests show what the panel does with a reply, not what the real model says. A scenario whose point is the real model's judgment, or real Chrome, stays `ai-e2e`.

## Running an `ai-e2e` scenario

`ai-e2e` runs use a dedicated Chrome for Testing profile with the extension loaded unpacked. Start it with a loopback-only DevTools port and a separate user-data directory. The CLI connects to port 9230 by default, or `E2E_CDP_PORT`.

```bash
pnpm e2e lock acquire "UC-AGENT-001-S16"
pnpm e2e reload
pnpm e2e panel "https://your-tenant.atlassian.net/wiki/spaces/ENG/pages/123/Test"
pnpm e2e ask "Which page am I on?" --json
pnpm e2e close
pnpm e2e lock release
```

- **One dedicated browser, shared.** Hold the lock for the run with `lock acquire` and `lock release`. A command without an explicit lock takes it for that command. The owner is `--owner`, `$E2E_OWNER`, or the git branch. Give concurrent sessions distinct owners and run one command at a time per owner. A busy lock exits with code 3 and the holder's name. A lock not refreshed for 30 minutes is abandoned.
- **Reload first.** `reload` builds this checkout into the loaded extension's directory and reloads it. It refuses to replace another extension or change the loaded signing key.
- **Account setup.** The CLI reports missing sign-in, Developer mode or extension setup so a person can finish those steps in the dedicated profile.
- **Own tabs.** `panel` opens the URL supplied by the tester in a tab owned by this run. `close` closes that tab and its panel. The CLI provides no workspace content creation or deletion commands.
- **Approvals.** `ask --allow` or `ask --deny` answers every confirmation prompt that way. Without either, the CLI stops at a prompt with exit code 4 and prints what would change. `pnpm e2e ask --allow` continues the waiting reply.
- **Output.** `ask` prints model text and every tool call, its status, arguments and result, in order. `--json` emits the same reply as JSON.

Record each run in the PR description or a comment: the scenario ID, the commit it ran on, the commands, and the reply's tool calls and results that show the scenario's "then", plus anything you checked in Confluence directly. Leave out account ids, emails, and the titles or content of the workspace's own pages.

## Priority

Priority is how much a scenario protects the product, not a schedule.

| Priority | Meaning | Before merge |
|---|---|---|
| P0 | Success path of a core capability, or a branch whose violation can't be undone (data or access crosses a trust boundary) | Must be verified |
| P1 | Important branch of one use case: alternative paths, main rejections, recoverable failures | Should be verified |
| P2 | Rare, narrow, easy to recover | Can wait |

A guard or rejection branch should not rank above its use case's success path unless it independently meets P0.

## Status

- 🚧 Not yet verified by its strategy. New and semantically changed scenarios start here.
- ✅ Verified: `api-test` has a passing test named with the ID; `ai-e2e` has a recorded passing run.

## File format

`docs/use-cases/{domain}/UC-{DOMAIN}-{NNN}-{slug}.md`:

```markdown
# UC-CHAT-001: Ask the AI from the side panel

## Behavior

A signed-in user asks the AI something in the side panel and reads the reply as it streams in.

Key constraint:

- The server chooses the model. Clients cannot use another one.

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-CHAT-001-S01 | P0 | ✅ | Given a signed-in user; when they ask the AI something; then the reply streams back piece by piece. |

### ai-e2e

(none)
```

## IDs

- Use case: `UC-{DOMAIN}-{NNN}`. Domains: `AGENT`, `AUTH`, `CHAT`, `PANEL`, `SESSION`.
- Scenario: `{UC ID}-S{NN}`.
- Once merged, IDs are never renumbered and deleted IDs are not reused. A scenario keeps its ID only for wording changes; changed behavior gets a new ID.
- Test names start with the ID: `it('[UC-CHAT-001-S01] signed-in user gets a streamed reply', ...)`. Several tests may cover one scenario.
