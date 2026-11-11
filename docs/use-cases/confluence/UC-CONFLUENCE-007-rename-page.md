# UC-CONFLUENCE-007: Rename a published Confluence page

## Behavior

On a connected instance, the user can request a new title for a published page. Confluco shows the intended page and title before writing, keeps the page's content and location, and checks the resulting page. Confluco preserves a newer version and reports when the outcome is uncertain.

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-CONFLUENCE-007-S01 | P0 | ✅ | Given a published page with existing content; when the user requests a new title; then the title changes and the same page retains its content and parent. |
| UC-CONFLUENCE-007-S02 | P0 | ✅ | Given a published page changes after Confluco prepares the rename; when the rename would overwrite the newer version; then the newer version is preserved. |
| UC-CONFLUENCE-007-S03 | P0 | ✅ | Given the account cannot rename the page or the outcome cannot be verified; when the user requests the rename; then Confluco explains the failure or uncertainty. |

### ai-e2e

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-CONFLUENCE-007-S04 | P0 | 🚧 | Given a disposable published page on a real self-managed instance; when the user requests a rename; then the same page has the new title and still has its original content and parent. |
