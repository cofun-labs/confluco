# Development

Requires Node.js 24 and pnpm.

```bash
pnpm install
pnpm check        # lint, unused code check (knip), format check, typecheck, extension build, and every package's tests
pnpm knip         # unused files, exports, and dependencies (knip.jsonc lists what is kept, and why)
pnpm smoke        # build the extension and load it into Chromium (first: pnpm --filter confluco-smoke exec playwright install --no-shell chromium)
pnpm icons        # export extension/icons/icon.svg into extension/public/icons (needs the same Chromium); commit the PNGs
```

A lefthook pre-commit hook runs `pnpm check`. GitHub Actions runs it and `pnpm smoke` on every pull request.

See [AGENTS.md](../AGENTS.md) for the issue → PR → review → merge workflow.

## GitHub settings

Enable **Dependency graph** in [Advanced Security](https://github.com/kitfun/confluco/settings/security_analysis) before running Dependency Review or enabling Dependabot alerts. GitHub may need time to index the repository's dependencies after it is enabled.

The `main` branch ruleset is kept in [`.github/rulesets/main.json`](../.github/rulesets/main.json): no deletion or force push, linear history, changes only through PRs with CI, dependency review, and actionlint passing and every review thread resolved, no open CodeQL or zizmor code scanning alerts of medium severity or above, merged by a merge queue that runs the required checks again on top of the latest `main` before it squash-merges (code scanning runs on the PR and on `main`, not in the queue). Every action is pinned to a full commit SHA. [`scripts/sync-github-settings.sh`](../scripts/sync-github-settings.sh) applies it along with the repository options: squash merge only (the PR title and body become the commit message), delete head branches on merge, auto-merge allowed (on a branch with a merge queue, `gh pr merge` adds a PR to the queue through it), secret scanning with push protection, and Dependabot alerts and security updates. Weekly Dependabot version updates are configured in [`.github/dependabot.yml`](../.github/dependabot.yml).

After merging the settings files, a repository admin runs it from their machine with `jq` installed and `gh` signed in; it is not run in CI, so no admin token is stored on GitHub. It changes only what differs and prints what it changed:

```bash
scripts/sync-github-settings.sh
```

If you change a setting in the GitHub dashboard, copy it back into these files.

### Claude workflows

`Claude Code Review` runs on pull requests and `Claude` responds to trusted maintainers who mention `@claude`. Configure the `CLAUDE_CODE_OAUTH_TOKEN` repository secret to enable the action steps. Until it is present, the workflows explain the missing credential in their job summary and skip the authenticated action. `CLAUDE_MODEL` is an optional repository variable that overrides the default model.

## Worker

The extension currently uses an existing Worker selected by local configuration. To deploy the bundled Worker independently:

```bash
cd worker
pnpm exec wrangler login
# If your Cloudflare login has several accounts, pick one with an env var (don't commit it)
CLOUDFLARE_ACCOUNT_ID='your-account-id' pnpm run deploy
```

Wrangler names the bundled Worker `confluco` and declares its AI, quota and usage bindings. Add a custom-domain route if your deployment needs one. Configure Clerk through your deployment environment or Wrangler secrets; `worker/.dev.vars.example` lists the values for local development.

Worker configuration values:

| Variable | Description |
|---|---|
| `CLERK_PUBLISHABLE_KEY` | Clerk publishable key, used by the sign-in page |
| `AI_GATEWAY_ID` | AI Gateway id; leave empty to call Workers AI directly |
| `MODEL` | The only model clients can use |
| `DAILY_REQUEST_LIMIT` | Chat requests each user may make per UTC day; counted in the `UserQuota` Durable Object (one per user) |
| `CLERK_AUTHORIZED_PARTIES` | Allowed origins, comma-separated: `chrome-extension://<extension id>` and the sign-in page |
| `CLERK_JWT_KEY` | Clerk JWT public key (PEM). Public; also available at `https://<frontend-api>/.well-known/jwks.json` |

For local development, copy `worker/.dev.vars.example` to `worker/.dev.vars` and run `pnpm --filter confluco-worker dev`. The Worker serves `/health` even before Clerk is configured. Inference requires a configured Workers AI binding.

### Usage records

Every chat request that passes auth leaves one data point in the `confluco_usage` Analytics Engine dataset (binding `USAGE`), written when the reply ends, is refused, or fails. Records hold sizes, token counts, and the outcome, never message or reply text. Analytics Engine deletes them after 90 days.

| Column | Value |
|---|---|
| `index1` | Clerk user id |
| `blob1` | model |
| `blob2` | outcome: `ok`, `incomplete` (stream ended early), `cancelled`, `stream_error`, or the error code returned (`rate_limited`, `provider_error`, `quota_unavailable`, `bad_request`, …). A stream whose model reports an error is `provider_error` |
| `blob3` | finish reason: `stop`, `length`, `content_filter`, `tool_calls`, `other`, or empty |
| `blob4` | `stream` or `sync` |
| `double1` … `double5` | messages, input characters (message text, tool calls, and tool definitions), prompt tokens, completion tokens, duration in ms (until the request was refused, the reply was sent, or a stream ended; for streams it includes the time the client spends reading) |

Query them with the [SQL API](https://developers.cloudflare.com/analytics/analytics-engine/sql-api/), for example requests and tokens per user per day:

```sql
SELECT index1 AS user, toStartOfDay(timestamp) AS day,
       sum(_sample_interval) AS requests,
       sum(_sample_interval * double3) AS prompt_tokens,
       sum(_sample_interval * double4) AS completion_tokens,
       sumIf(_sample_interval, blob2 != 'ok' AND blob2 != 'cancelled') AS failed
FROM confluco_usage
WHERE timestamp > NOW() - INTERVAL '7' DAY
GROUP BY user, day
ORDER BY day DESC, requests DESC
```

### Workers Builds settings

For a dedicated deployment, connect `kitfun/confluco` under Workers & Pages → `confluco` → Settings → Builds. A merge deploys only after this integration is configured.

| Setting | Value |
|---|---|
| Root directory | `worker` |
| Build command | `pnpm install --frozen-lockfile && pnpm test` |
| Deploy command | `pnpm exec wrangler deploy` |
| Production branch | `main` |

## Extension

Copy `extension/.env.example` to `extension/.env.local` and configure your Worker and Clerk instance. The checked-in `extension/.env.smoke` uses synthetic hosts exclusively for tests. `pnpm check` builds that configuration into `extension/dist-smoke`, while `pnpm build` writes your configured build to `extension/dist`.

| Variable | Description |
|---|---|
| `VITE_CLERK_PUBLISHABLE_KEY` | Clerk publishable key |
| `VITE_CLERK_SYNC_HOST` | URL of the sign-in page (the worker's domain) |
| `VITE_API_URL` | Worker base URL, including `/v1` |
| `CRX_PUBLIC_KEY` | Extension signing public key; pins the extension ID |
| `CLERK_COOKIE_DOMAIN` | Optional. The registrable domain Clerk sets its cookies on, e.g. `example.co.uk`. Defaults to the last two labels of the sign-in page's host |

Generate your own signing key and extension ID:

```bash
mkdir -p extension/keys
openssl genrsa -out extension/keys/crx-private.pem 2048
openssl rsa -in extension/keys/crx-private.pem -pubout -outform DER > extension/keys/pub.der
openssl base64 -A -in extension/keys/pub.der                          # CRX_PUBLIC_KEY
shasum -a 256 extension/keys/pub.der | cut -c1-32 | tr '0-9a-f' 'a-p'  # extension ID
```

In the Clerk dashboard, enable the Native API (Native applications page) so the Chrome extension can sign in.

```bash
pnpm build        # outputs extension/dist
```

In `chrome://extensions`, turn on Developer mode, click "Load unpacked", and pick `extension/dist`.

### Reuse an existing Worker

Set `VITE_API_URL` to its API base including `/v1`, `VITE_CLERK_SYNC_HOST` to its sign-in origin, and `VITE_CLERK_PUBLISHABLE_KEY` to the same Clerk instance. Confluco uses its own `CRX_PUBLIC_KEY` and extension ID. Google sign-in, session sync and a real chat request were verified against the current development instance on November 11, 2026 without adding a new origin entry.

For another instance, test sign-in and session sync first. If Clerk rejects the origin, follow the [Sync Host allowed origins setup](https://clerk.com/docs/guides/sessions/sync-host#add-the-extensions-id-to-your-web-apps-allowedorigins). If the token carries an `azp` for the extension origin, include it in the Worker's `CLERK_AUTHORIZED_PARTIES`. Shared deployments use the same Clerk accounts, model, per-user quota and server-side usage records.

## Real-browser scenarios

See [BDD](bdd.md#running-an-ai-e2e-scenario) for the full workflow. The generic `pnpm e2e` CLI supports browser locks, extension reload, opening the side panel on a supplied Confluence Cloud URL, asking questions, printing replies and closing its own tab. Its unit tests run with `pnpm check`.

Start a dedicated Chrome for Testing profile with `--remote-debugging-address=127.0.0.1 --remote-debugging-port=9230 --user-data-dir=<dedicated-profile-directory>` and load `extension/dist` unpacked. Set `E2E_EXTENSION_ID` if your extension ID differs from the local development default. `E2E_CDP_PORT` overrides the port. Complete account sign-in in that profile before running scenarios.
