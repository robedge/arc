import { z } from 'zod'
import { defineTool } from '../types'

export const mergeWorkerTool = defineTool({
  name: 'merge_worker',
  role: 'brain',
  longRunning: true,
  waitingFor: 'the merge to finish',
  description:
    "Merge a Done worker's commits into the session branch, one worker at a time per repository; the worker's card turns Merged and its working copy is removed. " +
    'Conflicts are resolved by a short-lived resolver worker that Arc starts (you never edit code). ' +
    'Returns {merged, result: clean|resolved|needs_user, files[], pendingFastForward?, note?}: needs_user means the resolver asked the user and the merge finishes after the answer (merged is false until then). ' +
    'workerId is the id from spawn_worker or "W<number>". Errors: unknown_worker, worker_user_control (the user is controlling that worker; try again after they hand it back), worker_not_done, already_merged, merge_in_progress, no_working_copy, merge_failed, branch_diverged.',
  inputShape: { workerId: z.string().min(1) },
  run: (args, ctx) => ctx.services.mergeWorker(ctx.agent, { workerId: args.workerId })
})
