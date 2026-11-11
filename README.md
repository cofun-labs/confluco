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
| Stay in context | Each question includes the current supported Confluence page's title and URL. |
| Draft | Work with text you provide in the conversation. |
| Keep sessions | Save conversations locally, search by title, filter by starting page, and continue earlier chats. |
| Sign in | Use Google through the web sign-in page and keep the side panel in sync. |

Page reading, searching, editing and comments will arrive with the Confluence tools. The current assistant works with your messages and the open page's metadata.

## Get started

1. Build and load the unpacked extension using the [setup guide](docs/development.md#extension). Chrome Web Store publication is pending.
2. Click the Confluco toolbar icon on any website. Open a Confluence page to include its title and link.
3. Sign in on the page the panel opens. The panel picks up the session.
4. Ask something, such as _Which page am I on?_ or _Draft an agenda for a product review_. Paste the text you want to revise into the chat.

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
