import { z } from 'zod'
import { defineTool } from '../types'
import { attachmentsField } from './attachments-field'

export const messageWorkerTool = defineTool({
  name: 'message_worker',
  role: 'brain',
  description:
    'Send a message to a running worker (it arrives as its next user turn). workerId is the id from spawn_worker or "W<number>". ' +
    'Returns {delivered, queued?}; queued: true means the user is controlling that worker right now, so the message is held and delivered after they hand it back. ' +
    'Errors: unknown_attachment (an id in `attachments` is not an attachment of this session; the error lists the valid ids).',
  inputShape: {
    workerId: z.string().min(1),
    text: z.string().min(1),
    attachments: attachmentsField
  },
  run: async (args, ctx) => ctx.services.messageWorker(ctx.agent, args)
})
