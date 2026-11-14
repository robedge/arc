import type { ChannelRequest } from './ipc/contract'
import { eventOf } from './surface'
import type { AttentionView, BranchChoiceValue } from './types/session'

/** What a panel's button turns into: the IPC channel to call and its input. */
export type AttentionAnswer =
  | { ipc: 'attention:answer'; payload: ChannelRequest<'attention:answer'> }
  | {
      ipc: 'sessions:answer-branch-question'
      payload: ChannelRequest<'sessions:answer-branch-question'>
    }

/** Whether the request's own surface has a button that raises `eventName`. */
function offers(view: AttentionView, eventName: string): boolean {
  return view.surface.components.some(
    (node) => node.component === 'Button' && eventOf(node)?.name === eventName
  )
}

/** The values of the picker with the given id; empty when the surface has none. */
function optionValues(view: AttentionView, pickerId: string): string[] {
  const picker = view.surface.components.find(
    (node) => node.id === pickerId && node.component === 'ChoicePicker'
  )
  const options = picker?.['options']
  if (!Array.isArray(options)) return []
  return options.flatMap((option: unknown) => {
    const value = (option as { value?: unknown } | null)?.value
    return typeof value === 'string' ? [value] : []
  })
}

/** A pick arrives as a list, or as one string for a single selection; anything else is no pick. */
function picksOf(value: unknown): string[] {
  const list = typeof value === 'string' ? [value] : Array.isArray(value) ? value : []
  return list.filter((v): v is string => typeof v === 'string' && v.trim() !== '')
}

function submitAnswer(
  view: Extract<AttentionView, { kind: 'question' }>,
  context: Record<string, unknown>
): AttentionAnswer | null {
  const questions = view.questions
  if (!questions || questions.length === 0) return null
  const answers: Record<string, string[]> = {}
  for (const [i, q] of questions.entries()) {
    const other = context[`o${i}`]
    const typed = typeof other === 'string' ? other.trim() : ''
    const answer = typed !== '' ? [typed] : picksOf(context[`q${i}`])
    if (answer.length === 0) return null
    answers[q.question] = answer
  }
  return { ipc: 'attention:answer', payload: { requestId: view.id, answers } }
}

/**
 * Turns a button event of a request panel into the call that answers the request, or null when
 * the event does not fit the view. Pure: the renderer sends what it returns.
 */
export function toAnswer(
  view: AttentionView,
  eventName: string,
  context: Record<string, unknown>
): AttentionAnswer | null {
  switch (view.kind) {
    case 'permission':
      switch (eventName) {
        case 'approve':
          return { ipc: 'attention:answer', payload: { requestId: view.id, approve: true } }
        case 'deny':
          return { ipc: 'attention:answer', payload: { requestId: view.id, approve: false } }
        case 'always':
          if (!offers(view, 'always')) return null
          return {
            ipc: 'attention:answer',
            payload: { requestId: view.id, approve: true, always: true }
          }
        default:
          return null
      }
    case 'question': {
      const hasChoices = (view.questions?.length ?? 0) > 0
      switch (eventName) {
        case 'send': {
          const text = typeof context['text'] === 'string' ? context['text'].trim() : ''
          if (hasChoices || text === '') return null
          return { ipc: 'attention:answer', payload: { requestId: view.id, text } }
        }
        case 'submit':
          return submitAnswer(view, context)
        case 'decline':
          return hasChoices
            ? { ipc: 'attention:answer', payload: { requestId: view.id, decline: true } }
            : null
        default:
          return null
      }
    }
    case 'branch': {
      if (eventName !== 'continue') return null
      const picked = picksOf(context['choice'])[0]
      if (picked === undefined || !optionValues(view, 'choice').includes(picked)) return null
      return {
        ipc: 'sessions:answer-branch-question',
        payload: { questionId: view.id, choice: picked as BranchChoiceValue }
      }
    }
  }
}
