# UC-CONFLUENCE-008: Edit text on a published Confluence page

## Behavior

A user on a connected instance can replace a uniquely identified passage of text on a published page. Confluco previews the target and the exact replacement for confirmation. A verified edit preserves the page's identity, location, and unrelated content and formatting.

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-CONFLUENCE-008-S01 | P0 | ✅ | Given a published page with a unique passage and other formatted content; when the user confirms a replacement; then Confluco verifies that only the intended text changed. |
| UC-CONFLUENCE-008-S02 | P0 | ✅ | Given an ambiguous target, an edit the user did not request, or a declined preview; when an edit is attempted; then the page remains unchanged. |
| UC-CONFLUENCE-008-S03 | P0 | ✅ | Given a page changes after an edit is proposed; when the user confirms the old proposal; then Confluco preserves the newer content and asks the user to review the current page. |
| UC-CONFLUENCE-008-S04 | P0 | ✅ | Given a write has an uncertain outcome; when Confluco can verify the resulting page; then it reports the verified edit, otherwise it asks the user to check without repeating the write. |

### ai-e2e

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-CONFLUENCE-008-S05 | P0 | ✅ | Given a disposable published page with a macro, table, and attachment on a real instance; when the user confirms a targeted edit; then the published page contains the new text and retains the unrelated content and attachment. |
