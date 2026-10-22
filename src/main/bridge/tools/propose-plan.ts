import { z } from 'zod'
import { PROVIDER_IDS } from '../../../shared/types/provider'
import { defineTool } from '../types'

export const proposePlanTool = defineTool({
  name: 'propose_plan',
  role: 'brain',
  longRunning: true,
  waitingFor: 'the user to decide on the plan',
  description:
    'Show the user a plan of the workers you want to start, listing every independent worker in the one plan, and wait for their decision. This call blocks until the user approves, asks for changes or rejects. ' +
    'In Plan-first mode you must call it before spawn_worker, and spawn_worker only accepts workers that the approved plan lists (same name, repos and command). ' +
    'Results: {decision:"approved", models, providers} (models and providers map each worker name to the model and provider the user chose), {decision:"changes_requested", comment} (revise and call propose_plan again), or {decision:"rejected"} (do not start workers).',
  inputShape: {
    workers: z
      .array(
        z.object({
          name: z.string().min(1).max(60).describe('Short worker name, for example "api-retry".'),
          task: z
            .string()
            .min(1)
            .describe('What the worker must do, with enough context to start.'),
          repos: z
            .array(z.string().min(1))
            .min(1)
            .describe('Names of the session projects this worker changes.'),
          provider: z
            .enum(PROVIDER_IDS)
            .optional()
            .describe('Your proposed provider. The user can change it. Omit for Claude.'),
          model: z
            .string()
            .optional()
            .describe(
              'Your proposed model of that provider: opus, sonnet or haiku for Claude, a Codex model id, or a Cursor model id (the id as Arc lists it, brackets included, for example default[] for Auto). Omit for the default.'
            ),
          command: z
            .string()
            .regex(
              new RegExp(`^(?:/|(?:${PROVIDER_IDS.join('|')}):)\\S`),
              'must start with / followed by the command name, or be an id such as claude:name, codex:name or cursor:name'
            )
            .optional()
            .describe(
              'A slash command this worker will run, with arguments, for example "/awos:spec retry settings". spawn_worker must later pass the same command.'
            ),
          rationale: z.string().default('').describe('Why this worker, in one sentence.')
        })
      )
      .min(1)
      .max(12)
  },
  run: async (args, ctx) =>
    ctx.services.proposePlan(ctx.agent, { workers: args.workers }, { signal: ctx.signal })
})
