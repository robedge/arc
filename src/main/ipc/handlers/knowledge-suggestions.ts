import type { AppServices } from '../../app/app-services'
import { handle } from '../register'

type KnowledgeSuggestionServices = Pick<AppServices, 'knowledgeSuggestions'>

export function registerKnowledgeSuggestionHandlers(services: KnowledgeSuggestionServices): void {
  const { knowledgeSuggestions } = services
  handle('knowledge-suggestions:list', ({ sessionId }) =>
    knowledgeSuggestions.listWaiting(sessionId)
  )
  handle('knowledge-suggestions:accept', ({ id, edits }) => knowledgeSuggestions.accept(id, edits))
  handle('knowledge-suggestions:accept-all', ({ sessionId }) =>
    knowledgeSuggestions.acceptAll(sessionId)
  )
  handle('knowledge-suggestions:discard-all', ({ sessionId }) => {
    knowledgeSuggestions.discardAll(sessionId)
  })
  handle('knowledge-suggestions:current', ({ id }) => knowledgeSuggestions.current(id))
  handle('knowledge-suggestions:result-text', ({ id }) => knowledgeSuggestions.resultText(id))
  handle('knowledge-suggestions:discard', ({ id }) => knowledgeSuggestions.discard(id))
}
