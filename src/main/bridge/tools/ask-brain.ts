import { z } from 'zod'
import { defineTool } from '../types'

export const askBrainTool = defineTool({
  name: 'ask_brain',
  role: 'worker',
  longRunning: true,
  waitingFor: 'the brain to answer',
  description:
    'Ask the brain a question when you are blocked and cannot decide from your task alone. This call waits for the answer. ' +
    'If the brain cannot answer, Arc passes the question to the user. Returns {answer}.',
  inputShape: { question: z.string().min(1).max(4000) },
  run: (args, ctx) =>
    ctx.services.askBrain(ctx.agent, { question: args.question }, { signal: ctx.signal })
})
