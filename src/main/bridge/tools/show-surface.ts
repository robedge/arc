import { z } from 'zod'
import { compileExpress, componentSignatures, ExpressError } from '../../surface/express'
import { BridgeToolError, defineTool } from '../types'

/** What the tool is and how to write Express. */
function guide(): string {
  return (
    'Show the user a panel in the conversation: text, code, inputs, buttons, KPI tiles, tables, charts. It returns at once; a button click reaches you as a message starting with "[Surface action]" with the event name and context. ' +
    'Each call adds a panel; earlier ones stay. Do not repeat its contents in your reply.\n\n' +
    'Write it in `express` (A2UI Express), one statement per line:\n' +
    '- `name = Component(args)`. Arguments are positional as in the signatures below; `key=value` skips ahead. Nest inline or refer by variable name.\n' +
    '- The top component MUST be assigned to `root`.\n' +
    '- Literals: "text", numbers, true/false, `[a, b]`, `{label: "Mon", value: 3}`.\n' +
    '- `$/path = value` sets data; `$/path` as an argument binds to it. Inputs write to their path.\n' +
    '- A button action is `Event("name", {key: $/path})`; the context returns the values as the user left them.\n' +
    '- (static) arguments must be literals, except `requires` (a list of `$/path`; a nested list means any of) and `submit` (a Button variable name as a string).\n' +
    'Example:\n' +
    '$/env = "staging"\n$/days = [{label: "Mon", value: 4}, {label: "Tue", value: 9}]\n' +
    'go = Button(Text("Deploy"), Event("deploy", {env: $/env}), "primary", [$/env])\n' +
    'root = Column([Text("Release 2.4", "h2"), Grid([Stat("Deploys", "13", "+3", "up"), Stat("Failures", "1", tone="danger")]), BarChart("Deploys per day", data=$/days), TextField("Environment", $/env, submit="go"), go])\n\n' +
    'Components:\n' +
    componentSignatures() +
    '\n\nA refusal names the problem; fix it and call again.'
  )
}

/** Shows a declarative panel, written in A2UI Express, in the conversation. */
export const showSurfaceTool = defineTool({
  name: 'show_surface',
  role: 'brain',
  get description() {
    return guide()
  },
  inputShape: {
    surfaceId: z.string().min(1).max(64).describe('A short name for the panel.'),
    express: z.string().min(1).max(20_000).describe('The panel in A2UI Express.')
  },
  run: (args, ctx) => {
    let surface
    try {
      surface = compileExpress(args.surfaceId, args.express)
    } catch (error) {
      if (error instanceof ExpressError) throw new BridgeToolError('invalid_surface', error.message)
      throw error
    }
    return {
      ...ctx.services.showSurface(ctx.agent, surface),
      note: 'The user now sees the panel. Do not repeat or describe its contents in your reply; say at most one short sentence.'
    }
  }
})
