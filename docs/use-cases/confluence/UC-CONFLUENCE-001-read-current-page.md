# UC-CONFLUENCE-001: Connect and read the current Confluence page

## Behavior

A signed-in Confluco user connects a self-managed Confluence instance by entering its base URL and granting Chrome site access. A deployment may be installed at the site root or under a context path. The user can disconnect the instance from the side panel.

The assistant can read the published page open when the question was sent and answer with a link to that page. Confluco respects the user's Confluence access, returns a limited amount of page text, and tells the user if the result was truncated. A tab switch, missing access, an expired session or a stopped question must never substitute another page or send its contents to the model.

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-CONFLUENCE-001-S01 | P0 | ✅ | Given a signed-in user who grants access to a self-managed instance; when they ask about the current published page; then the agent receives its text and a source link. |
| UC-CONFLUENCE-001-S02 | P1 | ✅ | Given a connected instance under a context path; when the user asks about a page there; then the agent reads the page and links back to the same instance. |
| UC-CONFLUENCE-001-S03 | P0 | ✅ | Given the current page becomes unavailable, or access is missing; when the user asks about it; then the tool explains what prevented the read and sends no page text. |
| UC-CONFLUENCE-001-S04 | P0 | ✅ | Given the user sends a question and switches tabs before the tool runs; when the assistant reads the page; then the tool does not use the newly active tab. |

### ai-e2e

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-CONFLUENCE-001-S05 | P0 | 🚧 | Given a signed-in user on a real self-managed Confluence 8.5 page; when they connect the instance and ask the assistant to read the page; then the assistant answers from the published content and provides the source link. |
