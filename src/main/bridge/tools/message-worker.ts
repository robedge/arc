import { z } from 'zod'
import { defineTool } from '../types'

export const messageWorkerTool = defineTool({
  name: 'message_worker',
  role: 'brain',
  description:
    'Send a message to a running worker (it arrives as its next user turn). workerId is the id from spawn_worker or "W<number>". ' +
    'Returns {delivered, queued?}; queued: true means the user is controlling that worker right now, so the message is held and delivered after they hand it back.',
  inputShape: { workerId: z.string().min(1), text: z.string().min(1) },
  run: async (args, ctx) => ctx.services.messageWorker(ctx.agent, args)
})
