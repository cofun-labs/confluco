# Confluco privacy

Confluco reads tab URLs to open its side panel on Confluence Cloud. For supported wiki pages, it reads the tab's title and a canonical page URL stripped of the query string and fragment to label and filter saved conversations. Before every question, it reads that metadata again and includes the current page title and URL in the conversation sent to the Worker and AI model. Titles and URLs from other sites are excluded. This version has no tools that read or modify the wiki.

Clerk handles sign-in. The extension reads session state from the configured sign-in host, contacts the configured Clerk Frontend API, and can load account images from `img.clerk.com`. It sends a Clerk session token, the current prompt, and relevant chat history to the configured Worker. The Worker sends messages to Cloudflare Workers AI, optionally through AI Gateway. Gateway prompt and reply logging and caching are disabled by the bundled Worker. The Worker records request sizes, token counts, outcomes, and the Clerk user ID in Analytics Engine. It does not store the text of prompts or replies.

Chat sessions are stored per Clerk user in Chrome's IndexedDB, including after sign-out. They can be searched or deleted in the side panel. The browser profile can read this local data, which is not encrypted by Confluco.
