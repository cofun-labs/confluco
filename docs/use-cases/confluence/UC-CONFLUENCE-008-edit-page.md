# UC-CONFLUENCE-008: Edit text on a published Confluence page

## Behavior

A user on a connected instance can request an exact replacement for a uniquely identified passage on a published page. Confluco shows the target and replacement before applying the edit. A verified edit preserves the page's identity, location, and unrelated content and formatting.

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-CONFLUENCE-008-S01 | P0 | ✅ | Given a published page with a unique passage and other formatted content; when the user requests an exact replacement; then Confluco shows the intended change and verifies that only that text changed. |
| UC-CONFLUENCE-008-S02 | P0 | ✅ | Given an ambiguous passage or an edit the user did not request; when an edit is attempted; then the page remains unchanged. |
| UC-CONFLUENCE-008-S03 | P0 | ✅ | Given a page changes after an edit is proposed; when the old proposal is applied; then Confluco preserves the newer content and asks the user to review the current page. |
| UC-CONFLUENCE-008-S04 | P0 | ✅ | Given a write has an uncertain outcome; when Confluco can verify the resulting page; then it reports the verified edit, otherwise it asks the user to check without repeating the write. |
| UC-CONFLUENCE-008-S06 | P0 | ✅ | Given the latest workspace change in the conversation is a verified text edit; when the user asks to undo it; then Confluco previews the reversal and restores the earlier text as a new published version. |
| UC-CONFLUENCE-008-S07 | P0 | ✅ | Given the latest change cannot be undone or the page has a newer version; when the user asks to undo; then Confluco explains the reason and preserves the current page. |

### ai-e2e

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-CONFLUENCE-008-S05 | P0 | 🚧 | Given a disposable published page with a macro, table, and attachment on a real instance; when the user requests a targeted edit; then the published page contains the new text and retains the unrelated content and attachment. |
| UC-CONFLUENCE-008-S08 | P0 | 🚧 | Given a verified targeted edit to a real disposable page; when the user asks to undo it; then the original text is restored and surrounding content remains intact. |
