# UC-CONFLUENCE-004: Inspect published page history and access

## Behavior

On a connected Confluence instance, the user can ask for a published page's versions, read a specific historical version, and inspect the operations and page-level restrictions Confluence reports. Confluence decides whether the user's account can perform each operation.

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-CONFLUENCE-004-S01 | P0 | ✅ | Given a published page with several versions; when the user asks about its history; then the assistant can identify versions and retrieve further results. |
| UC-CONFLUENCE-004-S02 | P0 | ✅ | Given a page whose text has changed; when the user asks for a specific version; then the assistant receives the text of that version and a source link. |
| UC-CONFLUENCE-004-S03 | P1 | ✅ | Given a missing or inaccessible version; when the user asks for it; then the assistant reports the failure without substituting another version. |
| UC-CONFLUENCE-004-S04 | P1 | ✅ | Given a page with available operations and restrictions; when the user asks about access; then the assistant receives the operations and the restrictions Confluence reports, with unavailable information identified. |

### ai-e2e

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-CONFLUENCE-004-S05 | P1 | ✅ | Given a published test page with two versions in a real self-managed instance; when the user requests its history and old content; then the assistant finds the versions and answers from the older one. |
