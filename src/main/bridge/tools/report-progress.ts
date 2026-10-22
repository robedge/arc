import { z } from 'zod'
import { defineTool } from '../types'

export const reportProgressTool = defineTool({
  name: 'report_progress',
  role: 'worker',
  description:
    'Tell Arc what you are doing now, in one short sentence. Call it when you start and after each meaningful step.',
  inputShape: {
    note: z.string().min(1).max(500),
    filesChanged: z.array(z.string()).optional()
  },
  run: (args, ctx) =>
    ctx.services.reportProgress(ctx.agent, { note: args.note, filesChanged: args.filesChanged })
})
