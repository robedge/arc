import { describe, expect, it } from 'vitest'
import {
  BRAIN_PROMPT_VERSION,
  PROMPT_UPDATE_NOTE_V6,
  PROMPT_UPDATE_NOTE_V7,
  PROMPT_UPDATE_NOTE_V7_OFF,
  PROMPT_UPDATE_NOTE_V8,
  PROMPT_UPDATE_NOTE_V9,
  buildBrainPrompt,
  promptUpdateNote
} from '../../../src/main/sessions/orchestrator'
import type { ProviderId } from '../../../src/shared/types/provider'

const base = {
  groupName: 'G',
  knowledgePath: '/k',
  projects: [],
  workersEnabled: true,
  brainProvider: 'claude' as const
}

describe('brain prompt version 7', () => {
  it('is at least version 7', () => {
    expect(BRAIN_PROMPT_VERSION).toBeGreaterThanOrEqual(7)
  })

  it('has the knowledge suggestions section with the provider tool name', () => {
    const claude = buildBrainPrompt(base)
    expect(claude).toContain('Knowledge suggestions: when you finish a request')
    expect(claude).toContain('mcp__arc__suggest_knowledge_update (up to 5 per request')
    expect(claude).toContain('never Projects, Links or PDFs')
    expect(claude).toContain('never mention suggestions when you have none')
    const codex = buildBrainPrompt({ ...base, brainProvider: 'codex' as ProviderId })
    expect(codex).toContain('Knowledge suggestions:')
    expect(codex).toMatch(/call [a-z_]*suggest_knowledge_update \(up to 5/)
  })

  it('lists the tool in the brain tool intro (the ToolSearch select line)', () => {
    expect(buildBrainPrompt(base)).toContain(
      'mcp__arc__ask_user,mcp__arc__suggest_knowledge_update"'
    )
  })

  it('leaves the section out when the brain has no bridge', () => {
    expect(buildBrainPrompt({ ...base, workersEnabled: false })).not.toContain(
      'suggest_knowledge_update'
    )
  })
})

describe('the version 7 update note', () => {
  it('reads as the task says', () => {
    expect(PROMPT_UPDATE_NOTE_V7).toBe(
      "[Arc] Updated instructions: you can now suggest additions to the group's knowledge with suggest_knowledge_update, at the end of a finished request, up to 5. Read the knowledge folder first, suggest only lasting facts, and say nothing when you have none."
    )
  })

  it('gives a version 6 session the note once, then the later notes, and a current one nothing', () => {
    expect(promptUpdateNote(6, undefined, 'PROVIDERS')).toBe(
      `${PROMPT_UPDATE_NOTE_V7}\n\n${PROMPT_UPDATE_NOTE_V8}\n\n${PROMPT_UPDATE_NOTE_V9}`
    )
    expect(promptUpdateNote(9, undefined, 'PROVIDERS')).toBeUndefined()
  })

  it('leaves it out for a brain without workers', () => {
    expect(promptUpdateNote(6)).toBeUndefined()
  })

  it('gives an older session the earlier notes first, then this one', () => {
    const note = promptUpdateNote(5, undefined, 'PROVIDERS') ?? ''
    expect(note.indexOf(PROMPT_UPDATE_NOTE_V6)).toBeGreaterThanOrEqual(0)
    expect(note.endsWith(PROMPT_UPDATE_NOTE_V9)).toBe(true)
    expect(note.indexOf(PROMPT_UPDATE_NOTE_V7)).toBeLessThan(note.indexOf(PROMPT_UPDATE_NOTE_V8))
    expect(note.split(PROMPT_UPDATE_NOTE_V7)).toHaveLength(2)
  })
})

describe('the suggestOnOwn variants', () => {
  it('on (the default): invites suggestions and tells the brain to pass asked_by_user', () => {
    for (const prompt of [
      buildBrainPrompt(base),
      buildBrainPrompt({ ...base, suggestOnOwn: true })
    ]) {
      expect(prompt).toMatch(/you may call mcp__arc__suggest_knowledge_update/)
      expect(prompt).toContain('asked_by_user: true')
      expect(prompt).toMatch(/while workers are running/)
      expect(prompt).not.toContain('Knowledge suggestions are switched off')
    }
  })

  it('off: says so, keeps the rules and drops the invitation', () => {
    const prompt = buildBrainPrompt({ ...base, suggestOnOwn: false })
    expect(prompt).toContain(
      'Knowledge suggestions are switched off: do not call mcp__arc__suggest_knowledge_update on your own. If the user asks what to add to the knowledge, call it with asked_by_user: true, or say you have none.'
    )
    expect(prompt).not.toMatch(/you may call/)
    expect(prompt).not.toContain('when you finish a request')
    expect(prompt).toContain("Read the group's knowledge folder first")
    expect(prompt).toContain('never Projects, Links or PDFs')
    expect(prompt).toContain('Notes, Docs, Playbooks or custom sections')
  })

  it('off uses the provider tool name', () => {
    const codex = buildBrainPrompt({ ...base, brainProvider: 'codex', suggestOnOwn: false })
    expect(codex).toMatch(/do not call [a-z_]*suggest_knowledge_update on your own/)
  })

  it('the version 7 update note follows the setting', () => {
    expect(promptUpdateNote(6, undefined, 'PROVIDERS', true)).toBe(
      `${PROMPT_UPDATE_NOTE_V7}\n\n${PROMPT_UPDATE_NOTE_V8}\n\n${PROMPT_UPDATE_NOTE_V9}`
    )
    expect(promptUpdateNote(6, undefined, 'PROVIDERS', false)).toBe(
      `${PROMPT_UPDATE_NOTE_V7_OFF}\n\n${PROMPT_UPDATE_NOTE_V8}\n\n${PROMPT_UPDATE_NOTE_V9}`
    )
    expect(PROMPT_UPDATE_NOTE_V7_OFF).not.toMatch(/you can now suggest/i)
    expect(PROMPT_UPDATE_NOTE_V7_OFF).toContain('asked_by_user')
    expect(promptUpdateNote(9, undefined, 'PROVIDERS', false)).toBeUndefined()
  })
})
