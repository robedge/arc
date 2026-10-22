import { z } from 'zod'
import { PROVIDER_IDS } from '../../../shared/types/provider'
import { defineTool } from '../types'

export const spawnWorkerTool = defineTool({
  name: 'spawn_worker',
  role: 'brain',
  description:
    "Start one worker in its own working copy of the named projects; call it once per worker, and independent workers can run at the same time. Returns {workerId, status, provider, model, note}: what the worker really runs on, and note says why when the user's choice or availability overrode yours. " +
    'Errors: plan_not_approved (Plan-first mode and no approved plan entry matches this name, repos and command), unknown_repo, branch_not_ready, worktree_failed, unknown_command (the command is not in the list), ambiguous_command (both Claude and Codex have a command of that name: use codex:name or claude:name), command_args_invalid (a Codex prompt needs arguments it was not given), command_not_in_repo (a repository command that the chosen repository does not have).',
  inputShape: {
    name: z.string().min(1).max(60),
    task: z.string().min(1),
    repos: z.array(z.string().min(1)).min(1),
    provider: z
      .enum(PROVIDER_IDS)
      .optional()
      .describe('The provider that runs the worker. The user may override it; omit for Claude.'),
    model: z
      .string()
      .optional()
      .describe(
        'A model of that provider: opus, sonnet or haiku for Claude, a Codex model id, or a Cursor model id (the id as Arc lists it, brackets included, for example default[] for Auto). The user may override it.'
      ),
    dependsOn: z.array(z.string()).optional().describe('Worker ids this worker depends on.'),
    command: z
      .string()
      .regex(
        new RegExp(`^(?:/|(?:${PROVIDER_IDS.join('|')}):)\\S`),
        'must start with / followed by the command name, or be an id such as claude:name, codex:name or cursor:name'
      )
      .optional()
      .describe(
        'A slash command the worker runs as its first message, with its arguments, for example "/awos:spec retry settings", or "codex:review" / "claude:review" when both providers have that name. It must be in the command list Arc gave you. A command runs on its own provider whatever the Workers setting says. The task is then a short description.'
      )
  },
  run: async (args, ctx) =>
    ctx.services.spawnWorker(ctx.agent, {
      name: args.name,
      task: args.task,
      repos: args.repos,
      provider: args.provider,
      model: args.model,
      dependsOn: args.dependsOn,
      command: args.command
    })
})
