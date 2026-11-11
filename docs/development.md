# Development

## Connect the extension to a Worker

Copy `extension/.env.example` to `extension/.env.local` and fill in:

| Setting | Value |
|---|---|
| `VITE_CLERK_PUBLISHABLE_KEY` | Publishable key of the Clerk instance used by the Worker |
| `VITE_CLERK_SYNC_HOST` | Origin of the Worker's sign-in page |
| `VITE_API_URL` | Worker API base URL including `/v1` |
| `CRX_PUBLIC_KEY` | Confluco's own public key, to pin its Chrome extension ID |
| `CLERK_COOKIE_DOMAIN` | Optional override for the parent domain of the Clerk Sync Host cookie |

For a stable unpacked ID, generate a key pair and copy the public key's base64 into `CRX_PUBLIC_KEY`.

```sh
mkdir -p extension/keys
openssl genrsa -out extension/keys/crx-private.pem 2048
openssl rsa -in extension/keys/crx-private.pem -pubout -outform DER -out extension/keys/crx-public.der
openssl base64 -A -in extension/keys/crx-public.der
```

Run `pnpm build`, open `chrome://extensions` in Chrome, enable Developer mode, and load `extension/dist` as an unpacked extension. Copy its ID from Chrome for Clerk configuration. Then open a Confluence Cloud wiki page, click the Confluco toolbar icon, and sign in.

### Use the existing Notion Copilot Worker

Set `VITE_API_URL` to `https://notion-copilot.kitfun.cc/v1`, `VITE_CLERK_SYNC_HOST` to `https://notion-copilot.kitfun.cc`, and use the [Clerk publishable key from the Notion Copilot build config](https://github.com/kitfun/notion-copilot/blob/main/extension/.env). The existing API supports Confluco's chat protocol, including requests with no tools registered. The sign-in page retains its existing branding.

On November 11, 2026, the Confluco development extension with ID `fccfdaiibgaiblpkkmpfgoijmokbgfng` was tested in Chrome for Testing against the existing Clerk development instance. Google sign-in, session sync into the extension, and a real chat request through the existing Worker succeeded without changing the Clerk configuration. For another instance, first test sign-in and session sync. If Clerk rejects the new origin, apply the documented [allowed origins setup for Sync Host](https://clerk.com/docs/guides/sessions/sync-host#add-the-extensions-id-to-your-web-apps-allowedorigins). If Clerk issues a token with an `azp` claim for the Confluco extension origin, add that origin to the existing Worker's `CLERK_AUTHORIZED_PARTIES` as well, alongside the existing entries. Both products use the same Clerk accounts, model, per-user quota and Worker-side usage records when they share this deployment.

### Deploy a separate Confluco Worker

The included Wrangler config declares the Workers AI binding, a Durable Object for per-user quotas, and the `confluco_usage` Analytics Engine dataset. Set `MODEL` and `DAILY_REQUEST_LIMIT` in `worker/wrangler.jsonc`. Configure the following values in the deployment environment or via Wrangler secrets:

- `CLERK_PUBLISHABLE_KEY` from your Clerk instance
- `CLERK_JWT_KEY` containing the Clerk JWT public key in PEM format
- `CLERK_AUTHORIZED_PARTIES` containing a comma-separated list with the sign-in origin and `chrome-extension://<confluco-extension-id>`
- `AI_GATEWAY_ID` if you want to route inference through an AI Gateway

Enable the Clerk Native API and configure the extension origin for Sync Host. Deploy with `pnpm --filter confluco-worker deploy`, then set the deployment URLs in `extension/.env.local`. For a local Worker, copy `worker/.dev.vars.example` to `worker/.dev.vars` and use `pnpm --filter confluco-worker dev`. Workers AI inference requires an authorized Cloudflare binding.

## Verify changes

- `pnpm check` runs lint, unused-code checks, formatting, type checks, the fixture build, and tests.
- `pnpm smoke` loads the fixture build in Chrome for Testing. Install Chromium with the command in the [README](../README.md#development). For a visible run, use `pnpm build:smoke` and `pnpm --filter confluco-smoke smoke --headed`.
- `pnpm --filter confluco-worker exec wrangler deploy --dry-run` checks Worker bundling and bindings locally.
- `pnpm build` writes the configured build to `extension/dist`. The checks write the fixture build to `extension/dist-smoke`.
