import { z } from 'zod'
import { defineTool } from '../types'

/**
 * The tool behind `--permission-prompt-tool mcp__arc__request_permission`. The CLI calls it, not the
 * model, whenever a tool needs a permission the agent does not already have (S0 item 1). Workers
 * and the brain both use it.
 */
export const requestPermissionTool = defineTool({
  name: 'request_permission',
  role: 'any',
  longRunning: true,
  description:
    'Used by Claude Code itself to ask Arc whether a tool call is allowed. Do not call this yourself. ' +
    'Returns {behavior:"allow", updatedInput} or {behavior:"deny", message}.',
  inputShape: {
    tool_name: z.string().min(1),
    input: z.record(z.string(), z.unknown()),
    tool_use_id: z.string().optional()
  },
  run: (args, ctx) =>
    ctx.services.requestPermission(
      ctx.agent,
      { tool_name: args.tool_name, input: args.input, tool_use_id: args.tool_use_id },
      { signal: ctx.signal }
    )
})
