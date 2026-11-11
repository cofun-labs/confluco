# Privacy

Confluco opens an AI side panel next to Confluence Cloud pages. This page describes what it reads, where data goes and what is retained. Hosts come from the build configuration in `extension/.env.local`. The checked-in `.env.smoke` configuration uses synthetic hosts for network-isolated tests.

## What the extension reads

- **Page metadata.** The title and canonical URL of the active supported Confluence page are added to each question. Query strings and fragments are stripped. The same metadata labels and filters saved sessions.
- **Your conversation.** Messages you type and the assistant's replies supply the context for the next question.
- **Your sign-in session.** Clerk's Sync Host session cookies identify sign-in changes, and Clerk provides a short-lived session token for each Worker request.

Chrome's tab URLs are checked to enable the side panel on HTTPS `*.atlassian.net/wiki` pages. Metadata from other sites is excluded from requests to the model. The current build reads no Confluence page body and provides no Confluence read or write tools.

## Where data goes

The manifest's host permissions and content security policy enforce the configured destinations. Tests pin the permissions and policy.

| Host | What is sent | Purpose |
|---|---|---|
| Configured Worker API origin (`VITE_API_URL`) | Clerk token, messages, relevant history, page title and canonical URL, assistant instructions and any registered tool definitions/results | Model access |
| Clerk Frontend API encoded in `VITE_CLERK_PUBLISHABLE_KEY` | Clerk session and token requests | Account access and sign-in |
| `img.clerk.com` | Avatar image requests | Account display |

The extension also holds host permission for the Sync Host and its cookie domain. The parent-domain permission lets Chrome report the Clerk cookie that signals sign-in changes. It is used for cookie access. The extension sends no Confluence cookies or credentials to the Worker or Clerk. Cloudflare and Clerk see the connecting IP address as part of serving requests.

### The sign-in page

Sign in opens the configured Sync Host's `/login` page in a normal tab. It loads Clerk's sign-in code from the Clerk Frontend API. Account details entered there are handled by Clerk and the chosen sign-in provider. The Worker serves the page. Clerk may report SDK telemetry from a development instance's sign-in page. Telemetry is disabled inside the extension. See [Clerk's privacy policy](https://clerk.com/legal/privacy).

## What the Worker does with it

- It verifies the session token locally with Clerk's public key and uses the Clerk user ID.
- It sends the conversation to Cloudflare Workers AI and streams the reply. AI Gateway is optional. The bundled Worker disables Gateway prompt/reply log collection and caching, retaining request analytics. See [Cloudflare's privacy policy](https://www.cloudflare.com/privacypolicy/).
- A Durable Object keeps each user's daily request counter.
- Each authenticated chat request produces a usage record containing user ID, model, outcome, finish reason, streaming mode, message count, input size, token counts and duration. Prompt and reply text is excluded. Analytics Engine retains these records for 90 days.
- Workers Logs contain invocation metadata such as time, URL and status. Provider failures are logged as the provider returns them. These diagnostic logs are separate from the usage records described above.

## What stays on your device

Conversations are saved in the extension's IndexedDB, per signed-in user. They include the page context saved with each question. Continuing a session sends relevant history to the Worker again. Saved sessions remain after sign-out and are unencrypted, so someone who can use the Chrome profile can read them. Deleting a session removes it locally; removing the extension removes its storage.

Clerk keeps its client token in `chrome.storage.local`. That local sign-in storage is unencrypted. `chrome.storage.session` holds the extension's startup flag and is cleared when Chrome closes.

## What is never collected

The extension has no advertising or analytics tracking and loads no remote executable code. Usage records exclude conversation text. Confluco does not read browsing history or content from other sites. Data is used to provide the assistant.

## Changes and contact

Changes to data collection or destinations update this document in the same PR. Its [history](https://github.com/kitfun/confluco/commits/main/PRIVACY.md) records those changes. Questions and reports can be filed as [issues](https://github.com/kitfun/confluco/issues).
