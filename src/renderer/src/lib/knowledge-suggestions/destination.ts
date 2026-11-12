import type { KnowledgeSuggestionView } from '@shared/types/knowledge-suggestion'

/** The note name as shown: a trailing `.md` is dropped, other extensions stay. */
export function shownNoteName(fileName: string): string {
  return fileName.replace(/\.md$/i, '')
}

/** Where a suggestion would go, e.g. "Notes › New note: Service map" or "Docs › Database schema". */
export function destinationText(
  suggestion: Pick<KnowledgeSuggestionView, 'kind' | 'sectionName' | 'target'>
): string {
  const name = shownNoteName(suggestion.target.name)
  return suggestion.kind === 'new'
    ? `${suggestion.sectionName} › New note: ${name}`
    : `${suggestion.sectionName} › ${name}`
}
