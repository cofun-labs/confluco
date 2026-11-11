# UC-SESSION-001: Keep sessions and pick up where you left off

## Behavior

Each conversation in the side panel is a session. A signed-in user can start a new session at any time, and opening the side panel starts one. Past sessions are kept in a list, most recently used first, each titled with its first question and showing the Confluence page it started on. The user can search the list by title, narrow it to sessions started on one Confluence page, and delete sessions they no longer want.

Reopening a session shows the whole conversation, including the tools the agent used and what they returned, and the next question continues it: the AI has the earlier conversation as context, as if the session had never been closed. Switching to another session while a reply is still coming stops that reply first, so it never lands in the wrong session.

Each browser window has its own side panel, and the same session can be open in more than one. If it is continued in two windows, neither conversation replaces the other: the one saved later is kept as a separate session in the list, and that window tells the user so.

Sessions are kept on the user's device and do not follow them to other devices. They stay there after the user signs out, so they can pick up again after signing back in. The service never stores them; it only sees the conversation the AI needs to answer the current question (see UC-AGENT-001 and UC-CHAT-002).

Key constraints:

- A session's context stays in that session. A new or different session never sends another session's conversation to the AI.
- Sessions belong to the account that made them. Another account signed in on the same browser cannot see or reopen them.

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-SESSION-001-S01 | P0 | ✅ | Given a saved session in which the agent used a tool; when the user reopens it and asks a follow-up; then the AI gets the earlier conversation, including the tool calls and their results, followed by the new question. |
| UC-SESSION-001-S02 | P1 | ✅ | Given a user with saved sessions; when they ask the AI in a new session; then nothing from the earlier sessions is sent to the AI. |
| UC-SESSION-001-S03 | P1 | ✅ | Given several saved sessions; when the user opens the session list; then it shows them most recently used first, each titled with its first question and with the Confluence page it started on. |
| UC-SESSION-001-S04 | P1 | ✅ | Given sessions with different titles started on different Confluence pages; when the user searches by title or picks a page; then only the sessions that match are listed. |
| UC-SESSION-001-S05 | P1 | ✅ | Given a saved session; when the user deletes it; then it is no longer listed and cannot be reopened. |
| UC-SESSION-001-S09 | P0 | ✅ | Given sessions saved by one account; when another account signs in on the same browser; then it sees none of them and cannot reopen them. |
| UC-SESSION-001-S10 | P1 | ✅ | Given one session open in two windows; when the user continues it in both; then the session keeps the first window's conversation, the second window's is saved as a separate session, and both are in the list. |
| UC-SESSION-001-S12 | P0 | ✅ | Given an earlier conversation and the side panel opened again; when the user reopens the session and asks a follow-up; then the earlier conversation is shown and the reply uses the earlier context. |
| UC-SESSION-001-S07 | P1 | ✅ | Given earlier sessions; when the user opens the side panel; then it starts a new, empty session, and the earlier sessions are in the list. |
| UC-SESSION-001-S08 | P2 | ✅ | Given a reply still coming in; when the user switches to another session; then that reply stops and does not appear in either session. |

### ai-e2e

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-SESSION-001-S11 | P2 | 🚧 | Given a session open in the side panel that was continued in another window since; when the user asks a follow-up; then the reply arrives, the panel says the conversation was saved as a separate session, and both sessions are in the list. |
