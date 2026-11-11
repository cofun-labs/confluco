# UC-CHAT-002: Keep a record of each user's chat usage

## Behavior

The operator needs to know how each user uses chat (how many requests, how many tokens, how often they fail) to watch cost and tune the daily quota. Every chat request from a signed-in user leaves a usage record for that user, whether it got a reply, was refused, or failed. The records describe each request by its size and outcome only.

Key constraint:

- Usage records contain request metadata and token counts. Message and reply content is excluded from those records.

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-CHAT-002-S01 | P1 | ✅ | Given a signed-in user; when they ask the AI something; then a usage record with the reply's token counts is kept for them. |
| UC-CHAT-002-S02 | P1 | ✅ | Given a signed-in user whose request is refused or fails; when they ask the AI; then a usage record of how the request ended is kept for them. |
| UC-CHAT-002-S04 | P0 | ✅ | Given a signed-in user; when they ask the AI something; then its usage record contains neither the messages nor the reply text. |

### ai-e2e

(none)
