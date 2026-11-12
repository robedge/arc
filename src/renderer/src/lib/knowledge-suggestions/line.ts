/** The sentence under a message that made knowledge suggestions; built from the count, never parsed from the brain's text. */
export function suggestionsLine(count: number): string {
  return `I have ${count} ${count === 1 ? 'suggestion' : 'suggestions'} for this group's knowledge.`
}
