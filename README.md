<h1 align="center">Confluco</h1>

<p align="center">
  An AI side panel for Chrome with context from your Confluence pages.<br />
  Ask questions, draft text, and pick up earlier conversations.
</p>

<p align="center">
  <img src="docs/assets/demo.svg" alt="Confluco identifies the open Weekly sync page from its title and URL" width="880" />
</p>

<p align="center"><sub>An illustration of the side panel.</sub></p>

## What it can do

| Capability | Behavior |
|---|---|
| Chat | Stream replies, stop a running answer, and start a new conversation. |
| Read a page | Ask about the published page on a connected self-managed Confluence 8.5 instance. |
| Search and browse | Find published pages by title or text and explore spaces, homepages, ancestors and children on the connected instance. |
| History and labels | Inspect older page versions and available operations. View labels or ask to add or remove a named label on the current page. |
| Create and rename pages | Publish a child page with optional plain text or rename a published page on the connected instance. |
| Edit page text | Preview and apply a replacement for one exact text passage while preserving the surrounding content. |
| Organize pages | Move a published page under a parent in the same space, or copy its body to a new page there. |
| Stay in context | Each question includes the current supported Confluence page's title and URL. |
| Draft | Work with text you provide in the conversation. |
| Keep sessions | Save conversations locally, search by title, filter by starting page, and continue earlier chats. |
| Sign in | Use Google through the web sign-in page and keep the side panel in sync. |

Confluence Cloud pages currently provide title and link context.

## Get started

1. Build and load the unpacked extension using the [setup guide](docs/development.md#extension). Chrome Web Store publication is pending.
2. Click the Confluco toolbar icon on any website. Open a Confluence page to include its title and link.
3. Sign in on the page the panel opens. The panel picks up the session.
4. To read a self-managed page, select **Connect Confluence**, enter the site base URL including any context path, and grant Chrome site access. Open a published page while signed in to Confluence.
5. Ask something, such as _Which page am I on?_ or _Draft an agenda for a product review_. Paste the text you want to revise into the chat.
6. To change a label, open the intended published page and ask _Add label release-ready_ or _Remove label release-ready_.
7. To create a page, open its parent and ask `Create page "Release checklist" under this page with text "Verify the build."`. To rename a page, open it and ask `Rename this page to "Launch checklist"`. Use the page's canonical link ending in `/pages/viewpage.action?pageId=…` in place of `this page` to choose a different page on the same instance.
8. To edit a published page, ask `Replace "Release pending" with "Release ready" on this page`. The quoted passage must occur once within a single text segment. If the page changed after the preview, review the current text and ask again.
9. Ask `Undo the last operation` in the same conversation to reverse its latest verified text edit. The page must still be on the version saved by that edit.
10. To move or copy a published page, ask `Move this page under URL` or `Copy this page under URL as "New title"`. Use the destination's canonical link in the same space. A move uses Confluence's child placement. Copies contain the body only and have independent history, comments and properties. For top-level moves, cross-space changes, exact sibling order, or copies with attachments, use Confluence's own controls.

## How it works

<p align="center">
  <img src="docs/assets/how-it-works.svg" alt="The side panel sends your question and current page metadata through the Worker to the AI model" width="880" />
</p>

The side panel runs the agent in your browser and includes the title and URL for each question on recognized Confluence pages. The server verifies your sign-in and passes the conversation to a Cloudflare Workers AI model. Conversations are saved in Chrome on your device.

## Privacy and safety

Your questions, relevant conversation history and current page metadata go to the configured Worker and AI model. Server usage records contain sizes, token counts and outcomes. [PRIVACY.md](PRIVACY.md) describes the data, destinations and retention.

Saved conversations stay after sign-out and are unencrypted. Anyone with access to your Chrome profile can read them. You can delete them from the session list.

Confluco is an independent project and is not endorsed by Atlassian.

## For developers

- [Architecture](docs/architecture.md) covers technical choices, the sign-in flow and code layout.
- [Development](docs/development.md) covers builds, checks, Worker configuration and repository settings.
- [AGENTS.md](AGENTS.md) defines the issue → PR → review → merge workflow and coding rules.
- [BDD](docs/bdd.md) and [use cases](docs/use-cases) define the behavior contract and its verification.

## License

Copyright 2026 Cofun Labs. The code is licensed under the [Apache License 2.0](LICENSE). It grants no rights to the Confluco and Cofun names and logos as trademarks.
