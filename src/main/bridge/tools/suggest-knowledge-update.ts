import { z } from 'zod'
import { BridgeToolError, defineTool } from '../types'

export const suggestKnowledgeUpdateTool = defineTool({
  name: 'suggest_knowledge_update',
  role: 'brain',
  description:
    "Suggest an addition to the group's knowledge: a lasting fact about the user's system or how they work. " +
    'Call it once per suggestion, at the end of your reply. The user sees the suggestion and accepts, edits or discards it; nothing changes until they accept. ' +
    'Use kind "new" with `section`, `name` and `content` for a new note or document. ' +
    'Use kind "update" with `section`, `file` and `edits` to change an existing note: each edit replaces `old_text`, which must occur exactly once in the file, with `new_text`; use an empty `new_text` to remove lines. ' +
    '`section` is a section name (Notes, Docs, Playbooks or a custom section); Projects, Links and PDFs are not allowed. ' +
    '`title` is one line, `reason` says in one or two sentences where in the session you learned it. ' +
    'Do not suggest what the knowledge folder already says. A refusal comes back with a code and a hint; fix the call or stop.',
  inputShape: {
    kind: z.enum(['new', 'update']).describe('"new" is a new note or document.'),
    title: z.string().min(1).max(80).describe('One-line title.'),
    reason: z.string().min(1).max(400).describe('Where in the session you learned it.'),
    section: z.string().min(1).max(80).describe('Section name or folder, case-insensitive.'),
    name: z
      .string()
      .min(1)
      .max(80)
      .optional()
      .describe('New only. May end in a text extension; .md by default.'),
    content: z.string().min(1).max(20_000).optional().describe('New only. The full text.'),
    file: z
      .string()
      .optional()
      .describe('Update only. Name or path of the file inside the section.'),
    edits: z
      .array(
        z.object({
          old_text: z.string().min(1).max(4_000),
          new_text: z.string().max(4_000)
        })
      )
      .min(1)
      .max(5)
      .optional()
      .describe('Update only. Replacement pairs; old_text must occur exactly once.'),
    asked_by_user: z
      .boolean()
      .optional()
      .describe('True when the user asked for suggestions in this request.')
  },
  run: async (args, ctx) => {
    const asked = args.asked_by_user === true ? { askedByUser: true } : {}
    if (args.kind === 'update') {
      if (args.file === undefined || args.edits === undefined) {
        throw new BridgeToolError('invalid_input', 'kind "update" needs both `file` and `edits`.')
      }
      const result = await ctx.services.suggestKnowledgeUpdate(ctx.agent, {
        kind: 'update',
        title: args.title,
        reason: args.reason,
        section: args.section,
        file: args.file,
        edits: args.edits,
        ...asked
      })
      return { ok: true, ...result }
    }
    if (args.name === undefined || args.content === undefined) {
      throw new BridgeToolError('invalid_input', 'kind "new" needs both `name` and `content`.')
    }
    const result = await ctx.services.suggestKnowledgeUpdate(ctx.agent, {
      kind: 'new',
      title: args.title,
      reason: args.reason,
      section: args.section,
      name: args.name,
      content: args.content,
      ...asked
    })
    return { ok: true, ...result }
  }
})
