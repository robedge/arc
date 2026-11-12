import type { KnowledgeSuggestionView } from '@shared/types/knowledge-suggestion'

/** The part of the open editor draft the guard looks at. */
export interface OpenDraft {
  itemId: string | null
  dirty: boolean
  hasConflict: boolean
}

/** False when accepting would change a note that is open in the editor with unsaved edits. */
export function canAcceptNow(
  suggestion: Pick<KnowledgeSuggestionView, 'kind' | 'target'>,
  draft: OpenDraft
): boolean {
  if (suggestion.kind !== 'update') return true
  const itemId = suggestion.target.itemId
  if (itemId === null || draft.itemId !== itemId) return true
  return !(draft.dirty || draft.hasConflict)
}
