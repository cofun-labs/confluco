# UC-CONFLUENCE-012: Manage attachments on a Confluence page

## Behavior

A user can find attachments on a published page and open download links on the connected Confluence instance. They can select one local file to upload. The assistant previews the destination and the file before asking for confirmation. Updating an existing attachment requires an explicit replacement request. File contents stay between the browser and the connected instance.

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-CONFLUENCE-012-S01 | P0 | ✅ | Given a published page with attachments; when the user lists them; then Confluco returns a bounded batch and usable download links for that page. |
| UC-CONFLUENCE-012-S02 | P0 | ✅ | Given a selected local file and a published page; when the user confirms an upload or explicit replacement; then Confluco verifies the attachment and its resulting version. |
| UC-CONFLUENCE-012-S03 | P0 | ✅ | Given a missing file, a name collision, a changed target or a declined confirmation; when a write is requested; then Confluco leaves the existing attachments intact. |
| UC-CONFLUENCE-012-S04 | P0 | ✅ | Given a denied or unverifiable upload; when the user receives its result; then Confluco reports the outcome without repeating the write. |

### ai-e2e

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-CONFLUENCE-012-S05 | P0 | ✅ | Given a disposable published page and synthetic files; when the user uploads, lists, downloads and replaces an attachment; then the expected file and new version are available on the same page. |
