/** Why a card could not be applied, kept in the store so a pushed list does not wipe it. */
export type KnowledgeSuggestionProblem =
  | { kind: 'changed' }
  | { kind: 'missing' }
  | { kind: 'name-taken' }
  | { kind: 'save-failed'; location: string }
  | { kind: 'storage-busy' }
  | { kind: 'unsaved-edits' }
  /** Any other refusal: the text already comes from `messageFor`. */
  | { kind: 'failed'; message: string }

/** The line shown on the card. */
export function problemText(problem: KnowledgeSuggestionProblem): string {
  switch (problem.kind) {
    case 'name-taken':
      return 'A note with this name already exists.'
    case 'save-failed':
      return `Couldn't save to ${problem.location}.`
    case 'storage-busy':
      return 'Storage is being moved. Try again in a moment.'
    case 'failed':
      return problem.message
    case 'changed':
      return 'This note has changed since the suggestion was made.'
    case 'missing':
      return 'This note no longer exists.'
    case 'unsaved-edits':
      return 'Save or discard your edits to this note first.'
  }
}

/** Problems whose card offers Try again. */
export function canRetry(problem: KnowledgeSuggestionProblem): boolean {
  return problem.kind === 'save-failed' || problem.kind === 'storage-busy'
}
