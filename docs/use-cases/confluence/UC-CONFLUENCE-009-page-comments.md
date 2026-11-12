# UC-CONFLUENCE-009: Read and contribute to a page discussion

## Behavior

A user can read a published page's comments in bounded batches and follow links to the discussion. Where Confluence identifies comment locations, Confluco distinguishes footer and inline comments. A direct request can add a footer comment or reply to a specific footer comment after showing the page, reply target and exact text.

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-CONFLUENCE-009-S01 | P0 | ✅ | Given a page with a discussion; when the user reads its comments; then Confluco returns a bounded batch with source links, parent relationships and a way to continue. |
| UC-CONFLUENCE-009-S02 | P0 | ✅ | Given a direct footer comment or reply request; when Confluco applies it; then it previews the exact target and text and verifies the published result. |
| UC-CONFLUENCE-009-S03 | P0 | ✅ | Given an unauthorized target, an inline reply target, or denied access; when a comment is requested; then Confluco reports the restriction without posting elsewhere. |
| UC-CONFLUENCE-009-S04 | P0 | ✅ | Given the outcome of a comment write is uncertain; when Confluco cannot verify it; then it asks the user to check the discussion without posting again. |

### ai-e2e

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-CONFLUENCE-009-S05 | P0 | ✅ | Given a real disposable published page; when the user adds a footer comment and replies to it; then the page displays the exact texts in the intended thread. |
