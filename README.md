# Confluco

Confluco is a Chrome side panel for people working in Confluence Cloud. Sign in to ask questions, draft text, and continue saved conversations while keeping the wiki open.

The foundation includes Clerk sign-in, streaming chat with stop and new chat controls, local searchable sessions, and a client-side agent that can run registered tools. Each question tells the model the current supported Confluence page's title and URL. This metadata also labels and filters saved sessions. The Confluence tool list is empty at this stage.

The extension and Cloudflare Worker are adapted from [notion-copilot at 7b8fb5e](https://github.com/kitfun/notion-copilot/tree/7b8fb5eb9087299df85baaf3754780ae428e7bc5).

## Development

Requires Node.js 24 and pnpm 11.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm --filter confluco-smoke exec playwright install --no-shell chromium
pnpm smoke
```

The checks use synthetic configuration and fixtures. For a build that can sign in and chat, see the [setup guide](docs/development.md). It covers using the existing Notion Copilot Worker and deploying the bundled Worker independently.

[Architecture](docs/architecture.md) · [Privacy](PRIVACY.md)
