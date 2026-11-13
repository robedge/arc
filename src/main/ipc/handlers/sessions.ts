import type { AppServices } from '../../app/app-services'
import { handle } from '../register'

type SessionHandlerServices = Pick<AppServices, 'sessions' | 'attention'>

export function registerSessionHandlers(services: SessionHandlerServices): void {
  const { sessions, attention } = services
  handle('sessions:attention-summary', () => attention.summary())
  handle('attention:answer', ({ requestId, ...answer }) => attention.answer(requestId, answer))
  handle('sessions:list', ({ groupId }) => sessions.list(groupId))
  handle(
    'sessions:create',
    ({ groupId, request, mode, workerLimit, brainModel, draftId, attachmentIds }) =>
      sessions.create(
        groupId,
        request,
        mode,
        workerLimit,
        brainModel,
        draftId !== undefined && attachmentIds ? { draftId, attachmentIds } : undefined
      )
  )
  handle('sessions:open', ({ sessionId }) => sessions.open(sessionId))
  handle('commands:list', ({ sessionId }) => sessions.listCommands(sessionId, false))
  handle('commands:refresh', ({ sessionId }) => sessions.listCommands(sessionId, true))
  handle('sessions:resolve-dirty', ({ token, choices }) => sessions.resolveDirty(token, choices))
  handle('sessions:rename', ({ sessionId, name }) => sessions.rename(sessionId, name))
  handle('sessions:set-config', ({ sessionId, ...patch }) => sessions.setConfig(sessionId, patch))
  handle('sessions:remove-allow-rule', ({ sessionId, ruleId }) =>
    sessions.removeAllowRule(sessionId, ruleId)
  )
  handle('sessions:send-message', ({ sessionId, text, draftId, attachmentIds }) =>
    sessions.sendMessage(
      sessionId,
      text,
      draftId !== undefined && attachmentIds ? { draftId, attachmentIds } : undefined
    )
  )
  handle('sessions:stop-reply', ({ sessionId }) => sessions.stopReply(sessionId))
  handle('sessions:delete', ({ sessionId }) => sessions.delete(sessionId))
  handle('sessions:plan-decision', ({ sessionId, planId, decision, models }) =>
    sessions.decidePlan(sessionId, planId, decision, models)
  )
  handle('sessions:dismiss-prompt', ({ sessionId, messageId }) =>
    sessions.dismissPrompt(sessionId, messageId)
  )
  handle('sessions:page-messages', ({ sessionId, beforeId, limit }) =>
    sessions.page(sessionId, 'messages', beforeId, limit)
  )
}
