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

Enable **Dependency graph** in [Advanced Security](https://github.com/cofun-labs/confluco/settings/security_analysis) before running Dependency Review or enabling Dependabot alerts. GitHub may need time to index the repository's dependencies after it is enabled.

The `main` branch ruleset is kept in [`.github/rulesets/main.json`](../.github/rulesets/main.json): no deletion or force push, linear history, changes only through PRs with CI, dependency review, and actionlint passing and every review thread resolved, no open CodeQL or zizmor code scanning alerts of medium severity or above, merged by a merge queue that runs the required checks again on top of the latest `main` before it squash-merges (code scanning runs on the PR and on `main`, not in the queue). Every action is pinned to a full commit SHA. [`scripts/sync-github-settings.sh`](../scripts/sync-github-settings.sh) applies it along with the repository options: squash merge only (the PR title and body become the commit message), delete head branches on merge, auto-merge allowed (on a branch with a merge queue, `gh pr merge` adds a PR to the queue through it), secret scanning with push protection, and Dependabot alerts and security updates. Weekly Dependabot version updates use a seven-day cooldown configured in [`.github/dependabot.yml`](../.github/dependabot.yml).

After merging the settings files, a repository admin runs it from their machine with `jq` installed and `gh` signed in; it is not run in CI, so no admin token is stored on GitHub. It changes only what differs and prints what it changed:

```bash
scripts/sync-github-settings.sh
```

If you change a setting in the GitHub dashboard, copy it back into these files.

### Claude workflows

`Claude Code Review` runs on pull requests and `Claude` responds to trusted maintainers who mention `@claude`. Configure the `CLAUDE_CODE_OAUTH_TOKEN` repository secret to enable the action steps. Until it is present, the workflows explain the missing credential in their job summary and skip the authenticated action. `CLAUDE_MODEL` is an optional repository variable that overrides the default model.

## Worker

Merging to `main` deploys the Worker through Cloudflare Workers Builds once that integration is connected (see [Workers Builds settings](#workers-builds-settings)). To deploy by hand:

```bash
cd worker
pnpm exec wrangler login
# If your Cloudflare login has several accounts, pick one with an env var (don't commit it)
CLOUDFLARE_ACCOUNT_ID='your-account-id' pnpm run deploy
```

The Worker is named `confluco-api` and runs on the custom domain `confluco-api.cofun.cc` (see `routes` in `wrangler.jsonc`). The domain's zone must belong to the deploying Cloudflare account. It needs no secrets: every value it uses is public and set in `wrangler.jsonc`.

Sign-in is shared with the other Cofun products: one Clerk application on `cofun.cc` (Frontend API `clerk.cofun.cc`). Each product has its own Worker, quota and usage dataset. The AI Gateway `cofun-ai-gateway` is shared too, so its rate limit and spend limit apply to the products together; requests carry `metadata.app` to tell them apart.

Variables in `wrangler.jsonc`:

| Variable | Description |
|---|---|
| `CLERK_PUBLISHABLE_KEY` | Clerk publishable key, used by the sign-in page. The hosted Worker uses the production instance (`pk_live_…`, Frontend API `clerk.cofun.cc`) |
| `AI_GATEWAY_ID` | AI Gateway id; leave empty to call Workers AI directly |
| `MODEL` | The only model clients can use |
| `DAILY_REQUEST_LIMIT` | Chat requests each user may make per UTC day; counted in the `UserQuota` Durable Object (one per user) |
| `CLERK_AUTHORIZED_PARTIES` | Allowed origins, comma-separated: `chrome-extension://<extension id>` and the sign-in page |
| `CLERK_JWT_KEY` | Clerk JWT public key (PEM). Public; also available at `https://<frontend-api>/.well-known/jwks.json` |

For local development, copy `worker/.dev.vars.example` to `worker/.dev.vars` and run `pnpm --filter confluco-worker dev`. The Worker serves `/health` even before Clerk is configured. Inference requires a configured Workers AI binding.

### Usage records

Every chat request that passes auth leaves one data point in the `confluco_api_usage` Analytics Engine dataset (binding `USAGE`), written when the reply ends, is refused, or fails. Records hold sizes, token counts, and the outcome, never message or reply text. Analytics Engine deletes them after 90 days.

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
FROM confluco_api_usage
WHERE timestamp > NOW() - INTERVAL '7' DAY
GROUP BY user, day
ORDER BY day DESC, requests DESC
```

### Workers Builds settings

In the Cloudflare dashboard: Workers & Pages → `confluco-api` → Settings → Builds → connect `cofun-labs/confluco`. The Cloudflare Workers and Pages GitHub App must be installed on the `cofun-labs` organization with access to this repository. A merge deploys only after this integration is connected.

| Setting | Value |
|---|---|
| Root directory | `worker` |
| Build command | `pnpm install --frozen-lockfile && pnpm test` |
| Deploy command | `pnpm exec wrangler deploy` |
| Production branch | `main` |

## Extension

`extension/.env` holds the public build config of the hosted Confluco. To point at your own deployment, override values in `extension/.env.local`. The checked-in `extension/.env.smoke` uses synthetic hosts exclusively for tests. `pnpm check` builds that configuration into `extension/dist-smoke`, while `pnpm build` writes your configured build to `extension/dist`.

| Variable | Description |
|---|---|
| `VITE_CLERK_PUBLISHABLE_KEY` | Clerk publishable key, of the same instance as the Worker's. It names the Frontend API host, which the manifest allows |
| `VITE_CLERK_SYNC_HOST` | URL of the sign-in page (the Worker's domain). With a development instance's key (`pk_test_…`) Clerk syncs the session from this host; with a production instance's key (`pk_live_…`) it syncs from the Frontend API host instead |
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

In the Clerk dashboard, enable the Native API (Native applications page) so the Chrome extension can sign in. Development and production instances have separate settings, keys, and users: do it on the instance whose keys you use.

A production instance also needs:

- Its DNS records in place, so the Frontend API answers at `clerk.<your domain>`. The sign-in page must be on the same registrable domain, because that is where Clerk sets its cookies.
- Your own OAuth credentials for each social sign-in (Clerk's shared ones work only on development instances).
- The extension's origin (`chrome-extension://<extension id>`) in the instance's `allowed_origins`, set through Clerk's Backend API as [Clerk's Sync Host guide](https://clerk.com/docs/guides/sessions/sync-host#add-the-extensions-id-to-your-web-apps-allowedorigins) describes.
- `CLERK_JWT_KEY` taken from that instance: the PEM form of the key at `https://clerk.<your domain>/.well-known/jwks.json`.

The checked-in public key pins the hosted extension's ID. If a Chrome Web Store release uses a different ID, add its origin to both the Worker's `CLERK_AUTHORIZED_PARTIES` and Clerk's `allowed_origins` before testing sign-in.

```bash
pnpm build        # outputs extension/dist
```

In `chrome://extensions`, turn on Developer mode, click "Load unpacked", and pick `extension/dist`.

### Use another deployment

Set `VITE_API_URL` to its API base including `/v1`, `VITE_CLERK_SYNC_HOST` to its sign-in origin, and `VITE_CLERK_PUBLISHABLE_KEY` to the same Clerk instance, in `extension/.env.local`. Include the extension's origin in that Worker's `CLERK_AUTHORIZED_PARTIES`.

## Real-browser scenarios

See [BDD](bdd.md#running-an-ai-e2e-scenario) for the full workflow. The generic `pnpm e2e` CLI supports browser locks, extension reload, opening the side panel on a supplied website URL, asking questions, printing replies and closing its own tab. Its unit tests run with `pnpm check`.

Start a dedicated Chrome for Testing profile with `--remote-debugging-address=127.0.0.1 --remote-debugging-port=9230 --user-data-dir=<dedicated-profile-directory>` and load `extension/dist` unpacked. Set `E2E_EXTENSION_ID` if your extension ID differs from the local development default. `E2E_CDP_PORT` overrides the port. Complete account sign-in in that profile before running scenarios.
