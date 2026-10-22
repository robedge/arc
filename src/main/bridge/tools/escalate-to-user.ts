import { z } from 'zod'
import { defineTool } from '../types'

export const escalateToUserTool = defineTool({
  name: 'escalate_to_user',
  role: 'brain',
  longRunning: true,
  waitingFor: 'the user',
  description:
    'Pass a worker request you cannot or should not decide to the user. `reason` is one short sentence the user sees on the request card. ' +
    'The worker keeps waiting until the user answers.',
  inputShape: {
    requestId: z.string().min(1),
    reason: z.string().min(1).max(500)
  },
  run: (args, ctx) => ctx.services.escalateToUser(ctx.agent, args)
})
