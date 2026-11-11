# UC-CHAT-002: Keep a record of each user's chat usage

## Behavior

The operator needs to know how each user uses chat (how many requests, how many tokens, how often they fail) to watch cost and tune the daily quota. Every chat request from a signed-in user leaves a usage record for that user, whether it got a reply, was refused, or failed. The records describe each request by its size and outcome only.

Key constraint:

- The service never keeps what users wrote or what the AI replied. Usage records hold request metadata and token counts, never message content.

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-CHAT-002-S01 | P1 | ✅ | Given a signed-in user; when they ask the AI something; then a usage record with the reply's token counts is kept for them. |
| UC-CHAT-002-S02 | P1 | ✅ | Given a signed-in user whose request is refused or fails; when they ask the AI; then a usage record of how the request ended is kept for them. |
| UC-CHAT-002-S03 | P0 | ✅ | Given a signed-in user; when they ask the AI anything; then nothing they wrote or the AI replied is kept by the service. |

### ai-e2e

(none)
