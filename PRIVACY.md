# Privacy

Confluco opens an AI side panel on any website. This page describes what it reads, where data goes and what is retained. Service hosts come from the build configuration in `extension/.env.local`. The checked-in `.env.smoke` configuration uses synthetic hosts for network-isolated tests.

## What the extension reads

- **Page metadata.** The title and canonical URL of the active supported Confluence page are added to each question. Path parameters, fragments and query parameters are stripped, except the numeric page ID required by self-hosted viewpage links. The same metadata labels and filters saved sessions.
- **Published page text.** When the assistant uses the read tool for a connected self-managed instance, it reads the current published page in the Confluence tab. It sends a bounded plain-text result, the title and a canonical link to the model as part of the conversation.
- **Search and navigation results.** The assistant can search and browse the connected instance using your Confluence account. Matching titles, limited text excerpts, space names and keys, page hierarchy, and source links and IDs are included in the model conversation when used to answer a question.
- **Page history, access and labels.** The assistant can read version numbers, dates, author display names, change messages and bounded historical page text. It can read label names and prefixes, available operations and whether Confluence reports page restrictions. A requested label change sends the current page ID, label and action to Confluence. The assistant receives the resulting label state and source link.
- **Page creation and renaming.** The requested title and any supplied plain text are part of the chat message. A creation sends these details and the chosen space and parent to Confluence. A rename sends the new title and existing published body back to Confluence as a versioned update. The model receives page links, titles and other result metadata such as space and version.
- **Your conversation.** Messages you type and the assistant's replies supply the context for the next question.
- **Your sign-in session.** Clerk's Sync Host session cookies identify sign-in changes, and Clerk provides a short-lived session token for each Worker request.

Confluco checks the active tab's URL for an HTTPS Atlassian Cloud wiki or a `confluence` label in the hostname or path. A tab on your explicitly connected instance can also contribute page metadata. The extension uses Chrome's existing tab metadata permission for this check. The side panel requests Chrome site access for the configured scheme, host, and port. Confluco reads content only on the connected instance, within its configured path.

## Where data goes

The manifest's host permissions and content security policy enforce the configured destinations. Tests pin the permissions and policy.

| Host | What is sent | Purpose |
|---|---|---|
| Configured Worker API origin (`VITE_API_URL`) | Clerk token, messages, relevant history, page title and canonical URL, assistant instructions and tool definitions and results, including requested Confluence page text, search, navigation, version, access, label and page write results | Model access |
| Clerk Frontend API encoded in `VITE_CLERK_PUBLISHABLE_KEY` | Clerk session and token requests | Account access and sign-in |
| `img.clerk.com` | Avatar image requests | Account display |
| User-connected Confluence base URL | Same-origin reads, search terms, space keys, page and parent IDs, version numbers, requested label changes, requested page titles and bodies for creation and rename, from the Confluence tab using that tab's session | Read, search and browse published pages, manage labels, create pages and rename pages |

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

Clerk keeps its client token in `chrome.storage.local`. Confluco keeps the selected Confluence base URL there for your Confluco account. This local storage is unencrypted. Disconnecting removes the connection and requests revocation of site access when no other saved connection uses it.

## What is never collected

The extension has no advertising or analytics tracking and loads no remote executable code. Usage records exclude conversation text. Confluco does not read browsing history or content from other sites. Data is used to provide the assistant.

## Changes and contact

Changes to data collection or destinations update this document in the same PR. Its [history](https://github.com/kitfun/confluco/commits/main/PRIVACY.md) records those changes. Questions and reports can be filed as [issues](https://github.com/kitfun/confluco/issues).
