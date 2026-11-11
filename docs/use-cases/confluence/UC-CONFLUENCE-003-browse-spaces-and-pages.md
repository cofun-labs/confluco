# UC-CONFLUENCE-003: Browse Confluence spaces and page trees

## Behavior

On a connected Confluence instance, the user can browse the spaces they can see, open a space's homepage, and find a published page's ancestors and direct children. Each page reference identifies its originating instance, so a reference from a different instance cannot select an unrelated page.

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-CONFLUENCE-003-S01 | P0 | ✅ | Given a connected instance with visible spaces; when the user browses spaces and selects one; then the assistant can provide its name, link, and homepage. |
| UC-CONFLUENCE-003-S02 | P0 | ✅ | Given a visible published page with an ancestor and a child; when the user asks where it sits in the space; then the assistant can identify the page, its ancestors, and its direct children with links. |
| UC-CONFLUENCE-003-S03 | P0 | ✅ | Given a page reference from another instance or a page the user cannot access; when the user asks about its hierarchy; then no information about an unrelated or inaccessible page is returned. |

### ai-e2e

(none)
