import { z } from 'zod'
import { defineTool } from '../types'

export const resolveRequestTool = defineTool({
  name: 'resolve_request',
  role: 'brain',
  description:
    'Decide a request a worker sent you ("[Arc] ... (request <id>)"). Use decision "approve" or "deny" for a permission request and "answer" with `answer` for a question. ' +
    "Add a short `note`; Arc logs it. Requests about leaving the machine, destructive commands, global installs or files outside the worker's working copy are not yours to approve: " +
    'Arc returns the error policy_requires_user and the user decides. If you cannot decide or answer, call escalate_to_user. Arc passes a request to the user on its own if you do nothing for 60 seconds.',
  inputShape: {
    requestId: z.string().min(1),
    decision: z.enum(['approve', 'deny', 'answer']),
    answer: z.string().optional().describe('The answer, for a question.'),
    note: z.string().max(500).optional().describe('One sentence on why, for the event log.')
  },
  run: (args, ctx) => ctx.services.resolveRequest(ctx.agent, args)
})
