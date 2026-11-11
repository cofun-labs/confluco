import { readPage, type PageTarget } from './confluence/read-page'
import { defineTool } from './tool'
import { z } from './zod'

export function createTools(currentPage: () => Promise<PageTarget | undefined> | undefined) {
  return [
    defineTool({
      name: 'read_page',
      description:
        'Reads text from the current published page on the connected self-managed Confluence site. Returns a source link.',
      args: z.strictObject({}),
      run: async (_args, signal) => readPage(await currentPage(), signal),
    }),
  ]
}
