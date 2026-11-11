# UC-CONFLUENCE-002: Find published pages by title or content

## Behavior

On a connected Confluence instance, the user can ask the assistant to find published pages that their Confluence account can see. The assistant can use titles or page text to find matches and give the user links and relevant excerpts. The user can ask for more results when available.

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-CONFLUENCE-002-S01 | P0 | ✅ | Given a connected instance with matching pages; when the user searches by title or content; then the assistant can report matching pages with their sources. |
| UC-CONFLUENCE-002-S02 | P1 | ✅ | Given more matches than fit in the first set of results; when the user asks for more; then the assistant can get the next set for the same search. |
| UC-CONFLUENCE-002-S03 | P1 | ✅ | Given a search with no visible matches; when the user asks for results; then the assistant can tell them that none were found. |

### ai-e2e

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-CONFLUENCE-002-S04 | P1 | ✅ | Given a published test page on a connected self-managed Confluence instance; when the user searches for its test content; then the assistant finds the page and provides its source link. |
