# UC-CONFLUENCE-010: Move and copy a published Confluence page

## Behavior

A user can move a published page beneath a chosen parent in the same space or copy its body into a new single page there. Confluco previews the source and destination, protects existing access restrictions and verifies the new ancestry.

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-CONFLUENCE-010-S01 | P0 | ✅ | Given a published page and an eligible parent in the same space; when the user requests a move; then the same page is verified under the chosen parent. |
| UC-CONFLUENCE-010-S02 | P0 | ✅ | Given a published page eligible for a body-only copy; when the user specifies a parent and title; then a new page is verified at that destination and the source remains intact. |
| UC-CONFLUENCE-010-S03 | P0 | ✅ | Given a destination or copy mode is unsupported, could loosen an existing restriction, or was not chosen by the user; when the tool is called; then Confluco refuses the write. |
| UC-CONFLUENCE-010-S04 | P0 | ✅ | Given a source or destination changes after preview, or a write outcome cannot be verified; when Confluco applies the plan; then it protects newer work or asks the user to verify without repeating the write. |

### ai-e2e

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-CONFLUENCE-010-S05 | P0 | ✅ | Given disposable pages on a real instance; when the user moves and copies a page; then the same original and the distinct copy appear beneath their chosen parent with the expected body. |
