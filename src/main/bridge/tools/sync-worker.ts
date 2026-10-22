import { z } from 'zod'
import { defineTool } from '../types'

export const syncWorkerTool = defineTool({
  name: 'sync_worker',
  role: 'brain',
  waitingFor: 'the sync to finish',
  description:
    "Bring one worker's changes into another worker's working copy: merge the session branch (if the source is Merged) or the source's commits (if it is Done) there, then message the receiving worker. " +
    'Merge the source first with merge_worker when the receiving worker should build on the session branch. ' +
    'note is what you want the receiving worker told about the change (default: the files that changed). ' +
    'Returns {synced, conflicts?, files[], notified, queued?}; conflicts are left for the receiving worker to resolve. queued: true means the user is controlling the receiving worker, so the message is held until they hand it back (the changes are already in its working copy). ' +
    'Errors: unknown_worker, invalid_sync, source_not_ready, worker_not_syncable, no_shared_repo, sync_failed.',
  inputShape: {
    workerId: z.string().min(1).describe('The worker that receives the change.'),
    fromWorkerId: z.string().min(1).describe('The worker whose change is shared.'),
    note: z.string().optional().describe('What changed, in a sentence.')
  },
  run: (args, ctx) =>
    ctx.services.syncWorker(ctx.agent, {
      workerId: args.workerId,
      fromWorkerId: args.fromWorkerId,
      note: args.note
    })
})
