import type { AttentionRecordDecision, AttentionRecordPrompt } from './types/session'

/** The decisions a stored record may carry, for validating what is read back. */
export const ATTENTION_RECORD_DECISIONS: readonly AttentionRecordDecision[] = [
  'approved',
  'denied',
  'always',
  'answered',
  'declined',
  'branch'
]

/** The label of each unsaved-changes choice, as its panel shows it. */
export const BRANCH_CHOICE_LABELS = {
  stash: 'Set aside',
  commit: 'Commit them first',
  carry: 'Bring them along',
  skip: "Don't start"
} as const

/** The one line a record says: what was decided, about what, and who asked. */
export function recordText(prompt: AttentionRecordPrompt): string {
  const { subject, from } = prompt
  switch (prompt.decision) {
    case 'approved':
      return `Approved: ${subject} (${from})`
    case 'denied':
      return `Denied: ${subject} (${from})`
    case 'always':
      return `Always allowed in this session: ${subject} (${from})`
    case 'answered':
      return `Answered: ${subject} → ${prompt.answer ?? ''} (${from})`
    case 'declined':
      return `Declined: ${subject} (${from})`
    case 'branch':
      return prompt.failed === true
        ? `Unsaved changes in ${subject}: ${prompt.answer ?? ''} did not work (${from})`
        : `Unsaved changes in ${subject}: ${prompt.answer ?? ''} (${from})`
  }
}
