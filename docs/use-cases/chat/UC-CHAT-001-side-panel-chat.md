# UC-CHAT-001: Ask the AI from the side panel

## Behavior

A signed-in user asks the AI something in the side panel and reads the reply as it streams in. Each user gets a daily quota of requests, so one account cannot run up unbounded model usage. Every call to the model is one request: a question the AI answers with tools (see UC-AGENT-001) uses one request for each round trip to the model, not one for the whole question.

Key constraints:

- The server chooses the model. Clients cannot use another one.
- A user who has used up today's quota cannot reach the model again until the quota resets the next day.
- When the quota runs out partway through a question, the question ends there, like any other failed question (UC-AGENT-001).

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-CHAT-001-S01 | P0 | ✅ | Given a signed-in user; when they ask the AI something; then the reply streams back to the extension piece by piece and adds up to the full answer. |
| UC-CHAT-001-S02 | P1 | ✅ | Given a signed-in user; when a client asks for a model other than the server's; then the request is refused and no model is called. |
| UC-CHAT-001-S04 | P1 | ✅ | Given a user who used up today's quota; when they ask the AI; then the request is refused with a message saying when the quota resets, and no model is called. |
| UC-CHAT-001-S05 | P1 | ✅ | Given a user who used up yesterday's quota; when they ask the AI the next day; then they get a reply. |
| UC-CHAT-001-S06 | P1 | ✅ | Given a question the agent answers with one tool; when the user asks it; then it uses two requests from today's quota, one for each model call. |
| UC-CHAT-001-S07 | P1 | ✅ | Given a user whose quota runs out after the agent used a tool; when the agent asks the model again; then the question ends with a message saying when the quota resets, and no model is called. |
| UC-CHAT-001-S03 | P0 | ✅ | Given a signed-in user with the side panel open on Confluence; when they send a message; then the message appears and the reply streams in below it. |

### ai-e2e

(none)
