import { describe, expect, it } from 'vitest'
import { buildAttentionSurface } from '../../../src/main/surface/attention-surface'
import { toAnswer } from '../../../src/shared/attention-action'
import { channelSchemas } from '../../../src/shared/ipc/contract'
import type { AttentionRequest, AttentionView } from '../../../src/shared/types/session'

type PermissionRequest = Extract<AttentionRequest, { kind: 'permission' }>
type QuestionRequest = Extract<AttentionRequest, { kind: 'question' }>
type BranchRequest = Extract<AttentionRequest, { kind: 'branch' }>

/** The view the main process would send: the request with its built surface. */
function viewOf<T extends AttentionRequest>(
  request: T,
  allowAlways = true
): T & Pick<AttentionView, 'surface'> {
  return { ...request, surface: buildAttentionSurface(request, { allowAlways }) }
}

const base: PermissionRequest = {
  id: 'req-1',
  route: 'queue',
  kind: 'permission',
  from: 'Brain',
  action: 'git push origin arc/fix'
}

const plain: QuestionRequest = {
  id: 'q-1',
  route: 'queue',
  kind: 'question',
  from: 'Brain',
  question: 'Which branch?'
}

const structured: QuestionRequest = {
  ...plain,
  id: 'q-2',
  questions: [
    {
      question: 'Which library?',
      header: 'Library',
      options: [{ label: 'zod' }, { label: 'valibot' }],
      multiSelect: false
    },
    {
      question: 'Which checks?',
      header: '',
      options: [{ label: 'lint' }, { label: 'types' }],
      multiSelect: true
    }
  ]
}

const branch: BranchRequest = {
  id: 'b-1',
  route: 'queue',
  kind: 'branch',
  from: 'Arc',
  projectId: 'p1',
  projectName: 'web',
  files: ['src/a.ts'],
  moreFiles: 0,
  workers: []
}

/** Every payload a panel can produce must pass the IPC contract of its channel. */
function expectContract(answer: ReturnType<typeof toAnswer>): void {
  expect(answer).not.toBeNull()
  if (!answer) return
  expect(channelSchemas[answer.ipc].safeParse(answer.payload).success).toBe(true)
}

describe('toAnswer, permission events', () => {
  const view = viewOf(base)

  it('maps approve to an approval', () => {
    expect(toAnswer(view, 'approve', {})).toEqual({
      ipc: 'attention:answer',
      payload: { requestId: 'req-1', approve: true }
    })
  })

  it('maps deny to a denial', () => {
    expect(toAnswer(view, 'deny', {})).toEqual({
      ipc: 'attention:answer',
      payload: { requestId: 'req-1', approve: false }
    })
  })

  it('maps always to an approval that is remembered', () => {
    expect(toAnswer(view, 'always', {})).toEqual({
      ipc: 'attention:answer',
      payload: { requestId: 'req-1', approve: true, always: true }
    })
  })

  it('returns null for an unknown event', () => {
    expect(toAnswer(view, 'explode', {})).toBeNull()
  })

  it('returns null for always when the surface does not offer it', () => {
    const noAlways = viewOf(base, false)
    expect(toAnswer(noAlways, 'always', {})).toBeNull()
    expect(toAnswer(noAlways, 'approve', {})).not.toBeNull()
  })

  it('returns null for always on a more-access request', () => {
    const access = viewOf({
      ...base,
      tool: { kind: 'permissions', reason: 'Needs the cache', read: ['/a'], network: false }
    })
    expect(toAnswer(access, 'always', {})).toBeNull()
  })

  it('returns null for a view that is not a permission', () => {
    expect(toAnswer(viewOf(plain), 'approve', {})).toBeNull()
    expect(toAnswer(viewOf(branch), 'deny', {})).toBeNull()
  })
})

describe('toAnswer, a plain question', () => {
  const view = viewOf(plain)

  it('sends the trimmed text', () => {
    const answer = toAnswer(view, 'send', { text: '  main  ' })
    expect(answer).toEqual({
      ipc: 'attention:answer',
      payload: { requestId: 'q-1', text: 'main' }
    })
    expectContract(answer)
  })

  it('returns null for empty, whitespace or missing text', () => {
    expect(toAnswer(view, 'send', { text: '' })).toBeNull()
    expect(toAnswer(view, 'send', { text: '   ' })).toBeNull()
    expect(toAnswer(view, 'send', {})).toBeNull()
  })

  it('returns null for send on a question with choices and for decline on a plain one', () => {
    expect(toAnswer(viewOf(structured), 'send', { text: 'x' })).toBeNull()
    expect(toAnswer(view, 'decline', {})).toBeNull()
    expect(toAnswer(view, 'submit', { q0: ['a'], o0: '' })).toBeNull()
  })
})

describe('toAnswer, questions with choices', () => {
  const view = viewOf(structured)

  it('answers by the exact question text, normalising a single pick to a list', () => {
    const answer = toAnswer(view, 'submit', {
      q0: 'zod',
      o0: '',
      q1: ['lint', 'types'],
      o1: ''
    })
    expect(answer).toEqual({
      ipc: 'attention:answer',
      payload: {
        requestId: 'q-2',
        answers: { 'Which library?': ['zod'], 'Which checks?': ['lint', 'types'] }
      }
    })
    expectContract(answer)
  })

  it('accepts a one-item list for a single pick', () => {
    const answer = toAnswer(view, 'submit', { q0: ['valibot'], o0: '', q1: ['lint'], o1: '' })
    expect(answer).toMatchObject({ payload: { answers: { 'Which library?': ['valibot'] } } })
  })

  it('lets the Other text replace the picks', () => {
    const answer = toAnswer(view, 'submit', {
      q0: ['zod'],
      o0: '  arktype ',
      q1: ['lint'],
      o1: ''
    })
    expect(answer).toMatchObject({
      payload: { answers: { 'Which library?': ['arktype'], 'Which checks?': ['lint'] } }
    })
    expectContract(answer)
  })

  it('takes the Other text when there are no picks', () => {
    const answer = toAnswer(view, 'submit', { q0: [], o0: 'arktype', q1: [], o1: 'none' })
    expect(answer).toMatchObject({
      payload: { answers: { 'Which library?': ['arktype'], 'Which checks?': ['none'] } }
    })
  })

  it('returns null when one question has no answer', () => {
    expect(toAnswer(view, 'submit', { q0: ['zod'], o0: '', q1: [], o1: '' })).toBeNull()
    expect(toAnswer(view, 'submit', { q0: ['zod'], o0: '', q1: [], o1: '   ' })).toBeNull()
    expect(toAnswer(view, 'submit', { q0: ['zod'], o0: '' })).toBeNull()
  })

  it('returns null for submit without questions', () => {
    expect(toAnswer(viewOf(plain), 'submit', { q0: ['x'], o0: '' })).toBeNull()
  })

  it('declines', () => {
    const answer = toAnswer(view, 'decline', {})
    expect(answer).toEqual({
      ipc: 'attention:answer',
      payload: { requestId: 'q-2', decline: true }
    })
    expectContract(answer)
  })
})

describe('toAnswer, unsaved changes', () => {
  const view = viewOf(branch)

  it.each(['stash', 'commit', 'carry', 'skip'] as const)('continues with %s', (choice) => {
    const answer = toAnswer(view, 'continue', { choice: [choice] })
    expect(answer).toEqual({
      ipc: 'sessions:answer-branch-question',
      payload: { questionId: 'b-1', choice }
    })
    expectContract(answer)
  })

  it('accepts the choice as a plain string', () => {
    expect(toAnswer(view, 'continue', { choice: 'stash' })).toMatchObject({
      payload: { choice: 'stash' }
    })
  })

  it('returns null for no choice or one that does not exist', () => {
    expect(toAnswer(view, 'continue', { choice: [] })).toBeNull()
    expect(toAnswer(view, 'continue', {})).toBeNull()
    expect(toAnswer(view, 'continue', { choice: ['explode'] })).toBeNull()
  })

  it('refuses carry when the surface does not offer it (after a failed carry)', () => {
    const failed = viewOf({ ...branch, message: 'Could not carry the changes' })
    expect(toAnswer(failed, 'continue', { choice: ['carry'] })).toBeNull()
    expect(toAnswer(failed, 'continue', { choice: ['stash'] })).not.toBeNull()
  })

  it('returns null for continue on another kind and unknown events on a branch', () => {
    expect(toAnswer(viewOf(base), 'continue', { choice: ['stash'] })).toBeNull()
    expect(toAnswer(view, 'approve', {})).toBeNull()
  })
})

describe('toAnswer, permission payloads', () => {
  it('satisfy the contract', () => {
    const view = viewOf(base)
    for (const event of ['approve', 'deny', 'always']) expectContract(toAnswer(view, event, {}))
  })
})
