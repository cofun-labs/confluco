import {
  accessArgs,
  historicalArgs,
  listVersions,
  pageAccess,
  readHistoricalVersion,
  versionsArgs,
} from './confluence/history'
import { applyLabel, changeLabelArgs, labelsArgs, listLabels } from './confluence/labels'
import {
  browseTree,
  getSpace,
  listSpaces,
  listSpacesArgs,
  searchArgs,
  searchPages,
  spaceArgs,
  treeArgs,
} from './confluence/navigation'
import { readPage } from './confluence/read-page'
import type { ConfluenceTab } from './confluence/transport'
import { defineTool } from './tool'
import { z } from './zod'

export function createTools(currentTab: () => Promise<ConfluenceTab | undefined> | undefined) {
  return [
    defineTool({
      name: 'read_page',
      description:
        'Reads text from the current published page on the connected self-managed Confluence site. Returns a source link.',
      args: z.strictObject({}),
      run: async (_args, signal) => readPage(await currentTab(), signal),
    }),
    defineTool({
      name: 'search_pages',
      description:
        'Find published pages by title or text on the connected self-managed site. Returns excerpts, source links and page references.',
      args: searchArgs,
      run: async (args, signal) => searchPages(args, await currentTab(), signal),
    }),
    defineTool({
      name: 'list_spaces',
      description: 'List spaces visible to the user on the connected self-managed site.',
      args: listSpacesArgs,
      run: async ({ start }, signal) => listSpaces(start, await currentTab(), signal),
    }),
    defineTool({
      name: 'get_space',
      description: 'Get a space and its homepage reference from the connected self-managed site by space key.',
      args: spaceArgs,
      run: async ({ key }, signal) => getSpace(key, await currentTab(), signal),
    }),
    defineTool({
      name: 'browse_page_tree',
      description:
        'Read ancestors and direct children. Omit page for the active published page. For another page, use a reference returned by a Confluence tool.',
      args: treeArgs,
      run: async (args, signal) => browseTree(args, await currentTab(), signal),
    }),
    defineTool({
      name: 'list_page_versions',
      description: 'List versions of a published page. Omit page to use the current tab.',
      args: versionsArgs,
      run: async (args, signal) => listVersions(args, await currentTab(), signal),
    }),
    defineTool({
      name: 'read_page_version',
      description: 'Read the text of one older published version. Omit page to use the current tab.',
      args: historicalArgs,
      run: async (args, signal) => readHistoricalVersion(args, await currentTab(), signal),
    }),
    defineTool({
      name: 'get_page_access',
      description: 'See Confluence-reported operations and page restrictions. Omit page to use the current tab.',
      args: accessArgs,
      run: async ({ page }, signal) => pageAccess(page, await currentTab(), signal),
    }),
    defineTool({
      name: 'list_page_labels',
      description: 'List labels on a published page. Omit page to use the current tab.',
      args: labelsArgs,
      run: async (args, signal) => listLabels(args, await currentTab(), signal),
    }),
    defineTool({
      name: 'change_page_label',
      description:
        'Add or remove one ordinary label when the user requests it. Omit page to use the current published page.',
      args: changeLabelArgs,
      changesData: true,
      run: async (args, signal) => applyLabel(args, await currentTab(), signal),
    }),
  ]
}
