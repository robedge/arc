import { z } from 'zod'
import { compileExpress, componentSignatures, ExpressError } from '../../surface/express'
import { BridgeToolError, defineTool } from '../types'

/** What the tool is and how to write Express; also sent back when a call uses the old JSON shape. */
function guide(): string {
  return (
    'Show the user an interactive panel in the conversation: text, inputs, buttons, KPI tiles, tables and charts. It does not wait: it returns at once, and when the user clicks a button you get a message that starts with "[Surface action]" carrying the event name and its context values. ' +
    'Each call adds a new panel at the end of the conversation; earlier panels stay where they are. The user sees the panel, so do not repeat its contents in your reply.\n\n' +
    'Write the panel in `express` as A2UI Express, one statement per line:\n' +
    '- `name = Component(args)`. Arguments are positional in the order of the signatures below; use `key=value` to skip ahead. Components can be nested inline or referred to by variable name.\n' +
    '- The top component MUST be assigned to `root`.\n' +
    '- Strings in double quotes, numbers, true/false, lists `[a, b]`, maps `{label: "Mon", value: 3}`.\n' +
    '- Data: `$/path = value` puts a value in the data model, and `$/path` as an argument binds to it. Inputs write what the user types to their path.\n' +
    '- A button action is `Event("name", {key: $/path})`; the context comes back with the values as the user left them.\n' +
    '- Arguments marked (static) must be literals, not `$/path` bindings.\n' +
    'Example:\n' +
    '$/env = "staging"\n$/notify = true\n$/days = [{label: "Mon", value: 4}, {label: "Tue", value: 9}]\n' +
    'kpis = Grid([Stat("Deploys", "13", "+3", "up"), Stat("Failures", "1", tone="danger")], 2)\n' +
    'go = Button(Text("Deploy"), Event("deploy", {env: $/env, notify: $/notify}), "primary")\n' +
    'root = Column([Text("Release 2.4", "h2"), kpis, BarChart("Deploys per day", data=$/days, unit="deploys"), TextField("Environment", $/env), CheckBox("Notify the team", $/notify), go])\n\n' +
    'Components:\n' +
    componentSignatures() +
    '\n\nA refusal names what is wrong; fix the text and call again.'
  )
}

/** SPIKE (A2UI): shows a declarative panel, written in A2UI Express, in the conversation. Throwaway. */
export const showSurfaceTool = defineTool({
  name: 'show_surface',
  role: 'brain',
  get description() {
    return guide()
  },
  inputShape: {
    surfaceId: z.string().min(1).max(64).describe('A short name for the panel.'),
    express: z.string().min(1).max(20_000).optional().describe('The panel in A2UI Express.'),
    // The first spike took component JSON; a brain that learned that shape is told what changed.
    components: z.unknown().optional()
  },
  run: (args, ctx) => {
    if (args.express === undefined) {
      throw new BridgeToolError(
        'format_changed',
        `This tool no longer takes \`components\` JSON. Pass the panel as text in \`express\`. ${guide()}`
      )
    }
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
