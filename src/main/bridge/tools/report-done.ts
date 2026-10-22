import { z } from 'zod'
import { defineTool } from '../types'

export const reportDoneTool = defineTool({
  name: 'report_done',
  role: 'worker',
  description:
    'Report that the task is finished. Commit all your work in the working copy first. Arc records your commits and ends your session after this call.',
  inputShape: {
    summary: z.string().min(1).describe('What you changed and anything the reviewer should know.'),
    commits: z.array(z.string()).optional().describe('Optional commit shas or subjects.')
  },
  run: async (args, ctx) =>
    ctx.services.reportDone(ctx.agent, { summary: args.summary, commits: args.commits })
})
