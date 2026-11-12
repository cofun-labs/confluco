# Privacy

Confluco opens an AI side panel on any website. This page describes what it reads, where data goes and what is retained. The hosts below are those of the hosted Confluco, set in the checked-in build configuration `extension/.env`. A build with other values in `extension/.env.local` uses that deployment's Worker and Clerk instance instead. The checked-in `.env.smoke` configuration uses synthetic hosts for network-isolated tests.

## What the extension reads

- **Page metadata.** The title and canonical URL of the active supported Confluence page are added to each question. Path parameters, fragments and query parameters are stripped, except the numeric page ID required by self-hosted viewpage links. The same metadata labels and filters saved sessions.
- **Published page text.** When the assistant uses the read tool for a connected self-managed instance, it reads the current published page in the Confluence tab. It sends a bounded plain-text result, the title and a canonical link to the model as part of the conversation.
- **Search and navigation results.** The assistant can search and browse the connected instance using your Confluence account. Matching titles, limited text excerpts, space names and keys, page hierarchy, and source links and IDs are included in the model conversation when used to answer a question.
- **Page history, access and labels.** The assistant can read version numbers, dates, author display names, change messages and bounded historical page text. It can read label names and prefixes, available operations and whether Confluence reports page restrictions. A requested label change sends the current page ID, label and action to Confluence. The assistant receives the resulting label state and source link.
- **Page creation and renaming.** The requested title and any supplied plain text are part of the chat message. A creation sends these details and the chosen space and parent to Confluence. A rename sends the new title and existing published body back to Confluence as a versioned update. The model receives page links, titles and other result metadata such as space and version.
- **Published page edits.** The quoted text and its replacement are part of the chat message. A direct edit request sends the revised published body and next version to the connected instance after a preview. The edit result includes the page reference and verification status.
- **Trash and restore.** The connected instance receives the page ID and requested state. Restoring also sends a version number. The model receives the page reference, resulting state and version.
- **Undoing a change.** A saved conversation can keep the last verified change's page reference and version locally, along with the quoted passages for a text edit. Undoing an edit restores the previous body as a new version. Undoing a trash action restores the page to published status. The model receives the result metadata.
- **Your conversation.** Messages you type and the assistant's replies supply the context for the next question.
- **Your sign-in session.** Clerk's Sync Host session cookies identify sign-in changes, and Clerk provides a short-lived session token for each Worker request.

Confluco checks the active tab's URL for an HTTPS Atlassian Cloud wiki or a `confluence` label in the hostname or path. A tab on your explicitly connected instance can also contribute page metadata. The extension uses Chrome's existing tab metadata permission for this check. The side panel requests Chrome site access for the configured scheme, host, and port. Confluco reads content only on the connected instance, within its configured path.

## Where data goes

The extension sends requests to these hosts and no others. The manifest's host permissions and content security policy enforce them, and a test pins the permissions and policy of the hosted configuration.

| Host | What is sent | Purpose |
|---|---|---|
| `confluco-api.cofun.cc` (the Confluco Worker) | Clerk token, messages, relevant history, page title and canonical URL, assistant instructions and tool definitions and results, including requested Confluence page text, search, navigation, version, access, label and page write results | Model access |
| `clerk.cofun.cc` (Clerk's Frontend API for the Cofun sign-in) | Clerk session and token requests | Account access and sign-in |
| `img.clerk.com` | Avatar image requests | Account display |
| User-connected Confluence base URL | Same-origin reads, search terms, space keys, page and parent IDs, version numbers, requested label changes, page titles and bodies for creation, rename and targeted edits, and requested trash or published state, from the Confluence tab using that tab's session | Read, search and browse published pages, manage labels, create, rename, edit, trash and restore pages |

The extension also holds a host permission for `*.cofun.cc`. Chrome reports a cookie only to an extension with permission for the cookie's domain, and Clerk sets the cookie that signals sign-in changes on the sign-in page's parent domain. The permission is used for that cookie access, and the extension sends no requests to any other host under `cofun.cc`.

Sign-in is shared across the Cofun products (Confluco, Notico and others): one Clerk application holds the account, so signing in to one signs the same browser in to the others. Each product has its own Worker, quota and usage records. The extension sends no Confluence cookies or credentials to the Worker or Clerk. Cloudflare and Clerk see the connecting IP address as part of serving requests.

### The sign-in page

Sign in opens `https://confluco-api.cofun.cc/login` in a normal tab. It loads Clerk's sign-in code from Clerk's Frontend API (`clerk.cofun.cc`). Account details entered there are handled by Clerk and the chosen sign-in provider. The Worker serves the page. Clerk may report SDK telemetry from a development instance's sign-in page. Telemetry is disabled inside the extension. See [Clerk's privacy policy](https://clerk.com/legal/privacy).

## What the Worker does with it

- It verifies the session token locally with Clerk's public key and uses the Clerk user ID.
- It sends the conversation to Cloudflare Workers AI and streams the reply. Requests go through Cloudflare AI Gateway, which the Cofun products share. The Worker disables Gateway prompt/reply log collection and caching, so the gateway retains request analytics (counts, tokens, cost) tagged with the product and the Clerk user ID. See [Cloudflare's privacy policy](https://www.cloudflare.com/privacypolicy/).
- A Durable Object keeps each user's daily request counter.
- Each authenticated chat request produces a usage record containing user ID, model, outcome, finish reason, streaming mode, message count, input size, token counts and duration. Prompt and reply text is excluded. Analytics Engine retains these records for 90 days.
- Workers Logs contain invocation metadata such as time, URL and status. Provider failures are logged as the provider returns them. These diagnostic logs are separate from the usage records described above.

## What stays on your device

Conversations are saved in the extension's IndexedDB, per signed-in user. They include the page context saved with each question. Continuing a session sends relevant history to the Worker again. Saved sessions remain after sign-out and are unencrypted, so someone who can use the Chrome profile can read them. Deleting a session removes it locally; removing the extension removes its storage.

Clerk keeps its client token in `chrome.storage.local`. Confluco keeps the selected Confluence base URL there for your Confluco account. This local storage is unencrypted. Disconnecting removes the connection and requests revocation of site access when no other saved connection uses it.

## What is never collected

The extension has no advertising or analytics tracking and loads no remote executable code. Usage records exclude conversation text. Confluco does not read browsing history or content from other sites. Data is used to provide the assistant.

## Changes and contact

Changes to data collection or destinations update this document in the same PR. Its [history](https://github.com/cofun-labs/confluco/commits/main/PRIVACY.md) records those changes. Questions and reports can be filed as [issues](https://github.com/cofun-labs/confluco/issues).
