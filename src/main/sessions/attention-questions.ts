import type { AttentionQuestion } from '@shared/types/session'
import type { AttentionRequestRow } from '../db/repositories/attention-repo'

/** The tool name of a command's question to the user (tech spec 2.6). */
export const ASK_USER_QUESTION_TOOL = 'AskUserQuestion'

/** What the user is told when they dismiss a question; the model reads it as an error result. */
export const DECLINED_MESSAGE = 'The user declined to answer.'

/** Stored in `reason` of a question row asked by one of the worker's background helpers. */
export const HELPER_REASON = 'helper'

const OPTION_LABEL_MAX = 200

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/**
 * The structured questions of an `AskUserQuestion` tool input `{questions:[{question, header,
 * options:[{label, description}], multiSelect}]}`; null when it carries no usable question.
 */
export function parseQuestions(input: unknown): AttentionQuestion[] | null {
  if (typeof input !== 'object' || input === null) return null
  const raw = (input as Record<string, unknown>)['questions']
  if (!Array.isArray(raw) || raw.length === 0) return null
  const questions: AttentionQuestion[] = []
  for (const item of raw as unknown[]) {
    if (typeof item !== 'object' || item === null) return null
    const q = item as Record<string, unknown>
    const question = text(q['question'])
    if (question === null) return null
    const options: AttentionQuestion['options'] = []
    if (Array.isArray(q['options'])) {
      for (const opt of q['options'] as unknown[]) {
        if (typeof opt !== 'object' || opt === null) continue
        const o = opt as Record<string, unknown>
        const label = text(o['label'])
        if (label === null) continue
        const description = text(o['description'])
        options.push({
          label: label.slice(0, OPTION_LABEL_MAX),
          ...(description === null ? {} : { description })
        })
      }
    }
    questions.push({
      question,
      header: typeof q['header'] === 'string' ? q['header'] : '',
      options,
      multiSelect: q['multiSelect'] === true
    })
  }
  return questions
}

/** The tool input of the brain's `ask_user` with choices: one single-select question. */
export function choicesInput(
  question: string,
  choices: readonly string[]
): { questions: unknown[] } {
  return {
    questions: [
      {
        question,
        header: 'Question',
        options: choices.map((label) => ({ label })),
        multiSelect: false
      }
    ]
  }
}

/** The structured questions stored on a request row, if it has any. */
export function questionsOfRow(row: AttentionRequestRow): AttentionQuestion[] | undefined {
  if (row.kind !== 'question' || row.toolInputJson === null) return undefined
  try {
    return parseQuestions(JSON.parse(row.toolInputJson)) ?? undefined
  } catch {
    return undefined
  }
}

/** The text a user turn carries for a stored AskUserQuestion answer: `"question"="answer"` pairs. */
export function describeAnswers(answers: Record<string, string>): string {
  return Object.entries(answers)
    .map(([q, a]) => `"${q}"="${a}"`)
    .join(', ')
}
