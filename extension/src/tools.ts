import {
  applyComment,
  commentsArgs,
  listPageComments,
  prepareComment,
  type CommentRequest,
} from './confluence/comments'
import { accessArgs, listVersions, pageAccess, readPageVersion, versionArgs, versionsArgs } from './confluence/history'
import { applyLabel, changeLabelArgs, labelsArgs, listLabels, type LabelRequest } from './confluence/labels'
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
import { applyOrganization, prepareOrganization, type OrganizationRequest } from './confluence/page-organization'
import {
  applyPageEdit,
  applyPageWrite,
  describePageWrite,
  pageEditUndo,
  pageTitleArgs,
  preparePageEdit,
  preparePageWrite,
  prepareUndoPageEdit,
  type PageEditRequest,
  type PageWriteRequest,
} from './confluence/page-writes'
import { applyPageStatus, pageTrashUndo, preparePageStatus, type PageStatusRequest } from './confluence/page-status'
import { readPage } from './confluence/read-page'
import { refuse, type ConfluenceTab } from './confluence/transport'
import { defineTool } from './tool'
import { z } from './zod'

export interface WorkspaceQuestion {
  tab: Promise<ConfluenceTab | undefined>
  labelChanges: LabelRequest[]
  pageWrite?: PageWriteRequest
  pageEdit?: PageEditRequest
  organization?: OrganizationRequest
  comment?: CommentRequest
  pageStatus?: PageStatusRequest
  attachmentUpload?: AttachmentUpload
  undoRequested?: boolean
  undo?: WorkspaceUndo
  beforeWrite?: () => Promise<void>
}

export const workspaceUndo = z.union([pageEditUndo, pageTrashUndo])
export type WorkspaceUndo = z.output<typeof workspaceUndo>

const writeOutcome = z.object({ changed: z.boolean() })
const changesData = (result: unknown) => writeOutcome.safeParse(result).data?.changed !== false

async function applyWorkspaceChange<T>(
  question: WorkspaceQuestion,
  signal: AbortSignal | undefined,
  run: () => Promise<T>,
): Promise<T> {
  if (question.undo) await question.beforeWrite?.()
  signal?.throwIfAborted()
  try {
    const result = await run()
    if (changesData(result)) question.undo = undefined
    return result
  } catch (error) {
    if (error instanceof Error && 'mayHaveChanged' in error && error.mayHaveChanged === true) question.undo = undefined
    throw error
  }
}

function pageEditTool(currentQuestion: () => WorkspaceQuestion) {
  let prepared:
    | { question: WorkspaceQuestion; plan: Awaited<ReturnType<typeof preparePageEdit>>; edit: PageEditRequest }
    | undefined
  return defineTool({
    name: 'edit_page',
    description:
      'Apply and verify a targeted text replacement on a published page. Use only for a direct request like Replace "OLD" with "NEW" on this page. The page and exact text come from the user message.',
    args: z.strictObject({}),
    changesData: true,
    preview: async (_args, signal) => {
      prepared = undefined
      const question = currentQuestion()
      const edit = question.pageEdit
      if (!edit) refuse('Ask the user to say Replace "OLD" with "NEW" on this page.')
      question.pageEdit = undefined
      const plan = await preparePageEdit(edit, await question.tab, signal)
      signal?.throwIfAborted()
      if (currentQuestion() !== question) return undefined
      prepared = { question, plan, edit }
      return plan.preview
    },
    run: async (_args, signal) => {
      signal?.throwIfAborted()
      const ready = prepared
      prepared = undefined
      const question = currentQuestion()
      if (ready?.question !== question) refuse('Ask again to preview the intended page change.')
      const result = await applyWorkspaceChange(question, signal, () => applyPageEdit(ready.plan, signal))
      question.undo = {
        page: result.page.ref,
        version: result.version,
        before: ready.edit.before,
        after: ready.edit.after,
      }
      return result
    },
  })
}

function commentTool(currentQuestion: () => WorkspaceQuestion) {
  let prepared: { question: WorkspaceQuestion; plan: Awaited<ReturnType<typeof prepareComment>> } | undefined
  return defineTool({
    name: 'add_page_comment',
    description:
      'Add a footer comment or reply from a direct user request. The page, optional parent comment ID, and exact quoted text come from the user message.',
    args: z.strictObject({}),
    changesData: true,
    preview: async (_args, signal) => {
      prepared = undefined
      const question = currentQuestion()
      const request = question.comment
      if (!request)
        refuse('Ask the user to say Add comment "TEXT" on this page or Reply to comment ID with "TEXT" on this page.')
      question.comment = undefined
      const plan = await prepareComment(request, await question.tab, signal)
      signal?.throwIfAborted()
      if (currentQuestion() !== question) return undefined
      prepared = { question, plan }
      return plan.preview
    },
    run: async (_args, signal) => {
      signal?.throwIfAborted()
      const question = currentQuestion()
      const ready = prepared
      prepared = undefined
      if (ready?.question !== question) refuse('Ask again to preview the intended comment.')
      return applyWorkspaceChange(question, signal, () => applyComment(ready.plan, signal))
    },
  })
}

function undoWorkspaceTool(currentQuestion: () => WorkspaceQuestion) {
  let prepared:
    | { question: WorkspaceQuestion; reviewAccess: boolean; run: (signal?: AbortSignal) => Promise<unknown> }
    | undefined
  return defineTool({
    name: 'undo_last_change',
    description:
      'Undo the latest verified text edit or trash action in this conversation. Use only for an explicit request to undo the last operation. The saved change determines the target and reversal.',
    args: z.strictObject({}),
    changesData: true,
    needsConfirmation: () => prepared?.reviewAccess === true,
    preview: async (_args, signal) => {
      prepared = undefined
      const question = currentQuestion()
      if (!question.undoRequested) refuse('Ask the user to explicitly request undoing the last operation.')
      const undo = question.undo
      if (!undo) refuse('The last workspace change in this conversation has no verified operation that can be undone.')
      question.undoRequested = false
      const tab = await question.tab
      const reversal =
        'kind' in undo
          ? await preparePageStatus({ action: 'restore' }, tab, signal, undo).then((plan) => ({
              preview: plan.preview,
              reviewAccess: plan.reviewAccess,
              run: async (signal?: AbortSignal) => {
                const { trashDate: _, ...result } = await applyPageStatus(plan, signal)
                return result
              },
            }))
          : await prepareUndoPageEdit(undo, tab, signal).then((plan) => ({
              preview: plan.preview,
              reviewAccess: false,
              run: (signal?: AbortSignal) => applyPageEdit(plan, signal),
            }))
      signal?.throwIfAborted()
      if (currentQuestion() !== question) return undefined
      prepared = { question, reviewAccess: reversal.reviewAccess, run: reversal.run }
      return reversal.preview
    },
    run: async (_args, signal) => {
      signal?.throwIfAborted()
      const ready = prepared
      prepared = undefined
      const question = currentQuestion()
      if (ready?.question !== question) refuse('Ask again to preview the intended undo.')
      return applyWorkspaceChange(question, signal, () => ready.run(signal))
    },
  })
}

function pageWriteTool(currentQuestion: () => WorkspaceQuestion, action: PageWriteRequest['action']) {
  let prepared: { question: WorkspaceQuestion; plan: Awaited<ReturnType<typeof preparePageWrite>> } | undefined
  return defineTool({
    name: action === 'create' ? 'create_page' : 'rename_page',
    description:
      action === 'create'
        ? 'Create a published child page only for a direct user request. Pass the exact quoted title. The tool takes the parent, space and optional plain-text body from the user message and verifies the published result.'
        : 'Rename a published page only for a direct user request. Pass the exact quoted title. The tool takes the target from the user message and verifies that the published body and location are preserved.',
    args: pageTitleArgs,
    changesData,
    preview: async ({ title }, signal) => {
      prepared = undefined
      const question = currentQuestion()
      const request = question.pageWrite
      if (request?.action !== action || request.title !== title) return undefined
      const plan = await preparePageWrite(request, await question.tab, signal)
      signal?.throwIfAborted()
      if (currentQuestion() !== question) return undefined
      prepared = { question, plan }
      return describePageWrite(plan)
    },
    run: async ({ title }, signal) => {
      signal?.throwIfAborted()
      const ready = prepared
      prepared = undefined
      const question = currentQuestion()
      if (
        ready?.question !== question ||
        ready.plan.request !== question.pageWrite ||
        ready.plan.request.title !== title
      ) {
        const example = action === 'create' ? 'Create page "TITLE" under this page' : 'Rename this page to "TITLE"'
        throw new Error(`Only the user can request this page change. Ask them to say ${example} on the intended page.`)
      }
      question.pageWrite = undefined
      return applyWorkspaceChange(question, signal, () => applyPageWrite(ready.plan, signal))
    },
  })
}

function pageStatusTool(currentQuestion: () => WorkspaceQuestion, action: PageStatusRequest['action']) {
  let prepared: { question: WorkspaceQuestion; plan: Awaited<ReturnType<typeof preparePageStatus>> } | undefined
  return defineTool({
    name: action === 'trash' ? 'trash_page' : 'restore_page',
    description:
      action === 'trash'
        ? 'Move an explicitly requested published page to recoverable trash. Use only for a direct request such as Trash this page.'
        : 'Restore a trashed page specified by the user by link. Confluence restores it at the space root.',
    needsConfirmation: () => prepared?.plan.page.status !== (action === 'trash' ? 'trashed' : 'current'),
    args: z.strictObject({}),
    changesData,
    preview: async (_args, signal) => {
      prepared = undefined
      const question = currentQuestion()
      const direct = question.pageStatus
      if (direct?.action !== action)
        refuse('Ask the user to specify the page to trash or provide the link of the page to restore.')
      question.pageStatus = undefined
      const plan = await preparePageStatus(direct, await question.tab, signal)
      signal?.throwIfAborted()
      if (currentQuestion() !== question) return undefined
      prepared = { question, plan }
      return plan.preview
    },
    run: async (_args, signal) => {
      signal?.throwIfAborted()
      const question = currentQuestion()
      const ready = prepared
      prepared = undefined
      if (ready?.question !== question) refuse('Ask again to preview the intended page.')
      const { trashDate, ...result } = await applyWorkspaceChange(question, signal, () =>
        applyPageStatus(ready.plan, signal),
      )
      if (result.changed && result.status === 'trashed')
        question.undo = { kind: 'trash', page: result.page.ref, version: result.version, trashDate }
      return result
    },
  })
}

function organizationTool(currentQuestion: () => WorkspaceQuestion, action: OrganizationRequest['action']) {
  let prepared: { question: WorkspaceQuestion; plan: Awaited<ReturnType<typeof prepareOrganization>> } | undefined
  return defineTool({
    name: action === 'move' ? 'move_page' : 'copy_page',
    description:
      action === 'move'
        ? 'Move a published page under a chosen parent in the same space. Use only for a direct request with an explicit destination link.'
        : 'Copy a published page body into one new page in the same space. Use only for a direct request with an explicit destination link and new title.',
    args: z.strictObject({}),
    changesData,
    preview: async (_args, signal) => {
      prepared = undefined
      const question = currentQuestion()
      const request = question.organization
      if (request?.action !== action)
        refuse(
          'Ask the user to specify the source page and parent link. Use Move this page under URL or Copy this page under URL as "TITLE".',
        )
      question.organization = undefined
      const plan = await prepareOrganization(request, await question.tab, signal)
      signal?.throwIfAborted()
      if (currentQuestion() !== question) return undefined
      prepared = { question, plan }
      return plan.preview
    },
    run: async (_args, signal) => {
      signal?.throwIfAborted()
      const question = currentQuestion()
      const ready = prepared
      prepared = undefined
      if (ready?.question !== question) refuse('Ask again to preview the source and destination.')
      return applyWorkspaceChange(question, signal, () => applyOrganization(ready.plan, signal))
    },
  })
}

function attachmentUploadTool(currentQuestion: () => WorkspaceQuestion) {
  let prepared: { question: WorkspaceQuestion; plan: Awaited<ReturnType<typeof prepareAttachmentUpload>> } | undefined
  return defineTool({
    name: 'upload_page_attachment',
    description:
      'Upload or replace a local file when the user has selected it and clicked the attachment action in the panel.',
    args: z.strictObject({}),
    needsConfirmation: true,
    changesData: true,
    preview: async (_args, signal) => {
      prepared = undefined
      const question = currentQuestion()
      const upload = question.attachmentUpload
      if (!upload) refuse('Choose a local file and select Upload attachment or Replace attachment in the panel.')
      question.attachmentUpload = undefined
      const plan = await prepareAttachmentUpload(upload, await question.tab, signal)
      signal?.throwIfAborted()
      if (currentQuestion() !== question) return undefined
      prepared = { question, plan }
      return plan.preview
    },
    run: async (_args, signal) => {
      signal?.throwIfAborted()
      const question = currentQuestion()
      const ready = prepared
      prepared = undefined
      if (ready?.question !== question) refuse('Choose the file again to preview the attachment.')
      return applyWorkspaceChange(question, signal, () => applyAttachmentUpload(ready.plan, signal))
    },
  })
}

export function createTools(currentQuestion: () => WorkspaceQuestion) {
  const currentTab = () => currentQuestion().tab
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
      description: 'Read the text of one published version by number. Omit page to use the current tab.',
      args: versionArgs,
      run: async (args, signal) => readPageVersion(args, await currentTab(), signal),
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
      description: 'Add or remove the exact label requested by the user on the current published page.',
      args: changeLabelArgs,
      changesData,
      run: async (args, signal) => {
        signal?.throwIfAborted()
        const question = currentQuestion()
        const next = question.labelChanges[0]
        if (next?.action !== args.action || next.label !== args.label.toLowerCase())
          throw new Error(
            'Only the user can request a label change. Ask them to say “Add label NAME” or “Remove label NAME” on the intended page.',
          )
        question.labelChanges.shift()
        return applyWorkspaceChange(question, signal, async () => applyLabel(next, await question.tab, signal))
      },
    }),
    pageWriteTool(currentQuestion, 'create'),
    pageWriteTool(currentQuestion, 'rename'),
    pageEditTool(currentQuestion),
    undoWorkspaceTool(currentQuestion),
    pageStatusTool(currentQuestion, 'trash'),
    pageStatusTool(currentQuestion, 'restore'),
    defineTool({
      name: 'list_page_comments',
      description:
        'Read a bounded batch of comments and replies on a published page, with links and parent comment IDs.',
      args: commentsArgs,
      run: async (args, signal) => listPageComments(args, await currentTab(), signal),
    }),
    commentTool(currentQuestion),
    organizationTool(currentQuestion, 'move'),
    organizationTool(currentQuestion, 'copy'),
    defineTool({
      name: 'list_page_attachments',
      description:
        'List attachments and download links on a published page. Use the filename filter for an exact match.',
      args: attachmentsArgs,
      run: async (args, signal) => listPageAttachments(args, await currentTab(), signal),
    }),
    attachmentUploadTool(currentQuestion),
  ]
}
import {
  applyAttachmentUpload,
  attachmentsArgs,
  listPageAttachments,
  prepareAttachmentUpload,
  type AttachmentUpload,
} from './confluence/attachments'
