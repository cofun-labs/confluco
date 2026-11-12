# UC-CONFLUENCE-006: Create a published Confluence page

## Behavior

On a connected instance, the user can request a published page with a title and optional plain text, under a parent they choose. Confluco shows the intended site, parent and title before writing. It checks the result, avoids duplicate creation, and reports when the outcome cannot be confirmed.

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-CONFLUENCE-006-S01 | P0 | ✅ | Given a user who can create a page under the chosen parent; when they request a title and body; then the assistant shows the intended change and verifies the created page under that parent. |
| UC-CONFLUENCE-006-S02 | P0 | ✅ | Given a page with the requested title already exists in the chosen space; when the user requests creation; then Confluco reports the existing page without creating another. |
| UC-CONFLUENCE-006-S03 | P0 | ✅ | Given creation is denied or its outcome is uncertain; when the user requests a page; then Confluco reports the failure or asks the user to check the page. |
| UC-CONFLUENCE-006-S04 | P0 | ✅ | Given the user did not authorize a particular new title or parent; when the assistant is induced to create it; then Confluco does not create the page. |

### ai-e2e

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-CONFLUENCE-006-S05 | P0 | ✅ | Given an editable parent in a real self-managed Confluence instance; when the user requests a disposable child page; then the published child has the requested title and content. |
