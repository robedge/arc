import { z } from 'zod'
import { defineTool } from '../types'

export const askUserTool = defineTool({
  name: 'ask_user',
  role: 'brain',
  longRunning: true,
  waitingFor: 'the user to answer',
  description:
    'Ask the user a question that only they can answer. It appears in their Needs attention list. Pass `choices` (2 to 6 short labels, for example repository names) to show them as buttons; the user can still type their own answer. This call waits until they answer. Returns {answer}: the chosen label or the text they typed.',
  inputShape: {
    question: z.string().min(1).max(4000),
    choices: z.array(z.string().min(1).max(200)).min(2).max(6).optional()
  },
  run: (args, ctx) =>
    ctx.services.askUser(
      ctx.agent,
      { question: args.question, ...(args.choices ? { choices: args.choices } : {}) },
      { signal: ctx.signal }
    )
})
