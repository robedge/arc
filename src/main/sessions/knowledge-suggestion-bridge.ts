import { BridgeToolError } from '../bridge/types'
import type { SuggestKnowledgeInput } from '../bridge/types'
import type {
  KnowledgeSuggestionRefused,
  KnowledgeSuggestionService,
  SuggestResult
} from '../knowledge/knowledge-suggestion-service'

/** The part of `KnowledgeSuggestionService` a brain session needs; it never reaches the Orchestrator back. */
export type KnowledgeSuggestionPort = Pick<KnowledgeSuggestionService, 'suggest'>

/** What the session knows about the moment a suggestion arrives. */
export interface SuggestionMoment {
  /** The brain's own claim that the user asked for suggestions in this request. */
  askedByUser: boolean
  /** True while any worker of the session has not finished, queued ones included. */
  workersRunning: boolean
  /** The Settings switch "Suggest knowledge updates", read at the moment of the call. */
  suggestionsOn: boolean
}

/**
 * Whether the brain may suggest on its own right now; a refusal code when not. A suggestion the user asked for
 * skips these checks. This is the one place the "unprompted" rules live. The switch comes first: while it is
 * off, the brain suggests only when asked, whether or not workers run.
 */
export function canSuggestUnprompted(
  moment: SuggestionMoment
): 'suggestions_off' | 'workers_running' | undefined {
  if (moment.askedByUser) return undefined
  if (!moment.suggestionsOn) return 'suggestions_off'
  return moment.workersRunning ? 'workers_running' : undefined
}

/** Matched by name: this module takes only types from the service, so the session code never loads it. */
function isRefusal(error: unknown): error is KnowledgeSuggestionRefused {
  return error instanceof Error && error.name === 'KnowledgeSuggestionRefused'
}

/** One actionable line for the brain, per refusal code. */
function hintFor(error: KnowledgeSuggestionRefused): string {
  switch (error.code) {
    case 'unknown_section':
      return `${error.message} Valid sections: ${(error.validSections ?? []).join(', ')}.`
    case 'invalid_name':
      return `${error.message} Use a plain file name without folders, for example "Service map" or "Service map.md".`
    case 'section_not_allowed':
      return `${error.message} Suggest into Notes, Docs, Playbooks or a custom section instead.`
    case 'not_text_file':
      return `${error.message} Use a name ending in a text extension such as .md or .txt.`
    case 'name_taken':
      return `${error.message} Pick a different name, or leave it out if the note already says this.`
    case 'file_not_found':
      return `${error.message} Use the file name or its path inside the section, as the knowledge folder shows it.`
    case 'edit_not_found':
      return `${error.message} Read the file again and copy old_text exactly, including spaces and line breaks.`
    case 'edit_ambiguous':
      return `${error.message} Include more surrounding text in old_text so it matches one place, and keep edits from touching the same lines.`
    case 'cap_reached':
      return `${error.message} Stop suggesting for this request; you can suggest again after the user's next message.`
    case 'duplicate':
    case 'already_discarded':
      return error.message
  }
}

/** Passes a brain's suggestion to the service; a refusal becomes a tool error with a hint. */
export async function suggestForBrain(
  port: KnowledgeSuggestionPort,
  sessionId: string,
  groupId: string,
  requestId: string,
  input: SuggestKnowledgeInput,
  moment: SuggestionMoment
): Promise<SuggestResult> {
  const refusal = canSuggestUnprompted(moment)
  if (refusal === 'suggestions_off') {
    throw new BridgeToolError(
      'suggestions_off',
      'The user switched knowledge suggestions off. Suggest only if they ask.'
    )
  }
  if (refusal === 'workers_running') {
    throw new BridgeToolError(
      'workers_running',
      'Workers are still running, so this request is not finished. Wait until the work is finished, or until the user asks for suggestions.'
    )
  }
  const suggestion = { ...input }
  delete suggestion.askedByUser
  try {
    return await port.suggest(sessionId, groupId, requestId, suggestion)
  } catch (error: unknown) {
    if (isRefusal(error)) {
      throw new BridgeToolError(error.code, hintFor(error))
    }
    throw error
  }
}
