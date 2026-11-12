import type { Section } from '@shared/types/section'

/** The sections a suggestion may go into: Projects and Links hold no editable text, so they are dropped. */
export function eligibleSuggestionSections<T extends Pick<Section, 'kind'>>(
  sections: readonly T[]
): T[] {
  return sections.filter((s) => s.kind !== 'projects' && s.kind !== 'links')
}
