import { z } from 'zod'
import { defineTool } from '../types'

export const getWorkerStatusTool = defineTool({
  name: 'get_worker_status',
  role: 'brain',
  description:
    'Status of one worker, or of all workers when workerId is omitted. Returns [{id, number, name, status, note, files, lastReport}].',
  inputShape: { workerId: z.string().optional() },
  readOnly: true,
  run: (args, ctx) => ctx.services.getWorkerStatus(ctx.agent, { workerId: args.workerId })
})
