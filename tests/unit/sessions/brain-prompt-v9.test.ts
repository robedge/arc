// @spec: 013-session-branches-on-demand
// @regression
import { describe, expect, it } from 'vitest'
import {
  BRAIN_PROMPT_VERSION,
  PROMPT_UPDATE_NOTE_V7,
  PROMPT_UPDATE_NOTE_V7_OFF,
  PROMPT_UPDATE_NOTE_V8,
  PROMPT_UPDATE_NOTE_V9,
  buildBrainPrompt,
  promptUpdateNote
} from '../../../src/main/sessions/orchestrator'

const base = {
  groupName: 'G',
  knowledgePath: '/k',
  projects: [],
  workersEnabled: true,
  brainProvider: 'claude' as const
}

/** What the prompt and the note both say about when the branch appears and what queued can mean. */
const BRANCH_LINE =
  'The session branch is created in a repository when its first worker starts there, not when the session starts.'
const QUEUED_LINE =
  'queued can also mean the worker waits for the user to answer about unsaved changes in a repository. Do not spawn it again; Arc sends a message when it starts or is not started.'

describe('brain prompt version 9', () => {
  it('is version 9', () => {
    expect(BRAIN_PROMPT_VERSION).toBe(9)
  })

  it('tells a new session that the branch is made when the first worker starts', () => {
    const prompt = buildBrainPrompt(base)
    expect(prompt).toContain(BRANCH_LINE)
    expect(prompt).toContain(QUEUED_LINE)
    expect(prompt).not.toContain('branch_not_ready')
  })

  it('leaves both out for a brain without workers', () => {
    const prompt = buildBrainPrompt({ ...base, workersEnabled: false })
    expect(prompt).not.toContain(BRANCH_LINE)
    expect(prompt).not.toContain(QUEUED_LINE)
  })
})

describe('the version 9 update note', () => {
  it('says the same as the prompt', () => {
    expect(PROMPT_UPDATE_NOTE_V9).toBe(`[Arc] Updated instructions: ${BRANCH_LINE} ${QUEUED_LINE}`)
    expect(PROMPT_UPDATE_NOTE_V9).not.toMatch(/[—–]/)
  })

  it('gives a version 8 session the note once and a current one nothing', () => {
    expect(promptUpdateNote(8, undefined, 'PROVIDERS')).toBe(PROMPT_UPDATE_NOTE_V9)
    expect(promptUpdateNote(9, undefined, 'PROVIDERS')).toBeUndefined()
  })

  it('leaves it out for a brain without workers', () => {
    expect(promptUpdateNote(8)).toBeUndefined()
  })

  it('follows the earlier notes, in order, each once', () => {
    const note = promptUpdateNote(6, undefined, 'PROVIDERS', true) ?? ''
    expect(note.endsWith(PROMPT_UPDATE_NOTE_V9)).toBe(true)
    expect(note.split(PROMPT_UPDATE_NOTE_V9)).toHaveLength(2)
    expect(note.indexOf(PROMPT_UPDATE_NOTE_V8)).toBeLessThan(note.indexOf(PROMPT_UPDATE_NOTE_V9))
    expect(note.indexOf(PROMPT_UPDATE_NOTE_V7)).toBeLessThan(note.indexOf(PROMPT_UPDATE_NOTE_V8))
  })

  it('comes after the version 8 note when suggestions are switched off', () => {
    const note = promptUpdateNote(6, undefined, 'PROVIDERS', false) ?? ''
    expect(note).toBe(
      `${PROMPT_UPDATE_NOTE_V7_OFF}\n\n${PROMPT_UPDATE_NOTE_V8}\n\n${PROMPT_UPDATE_NOTE_V9}`
    )
  })
})
