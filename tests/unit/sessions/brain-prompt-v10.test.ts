// @spec: 014-inline-needs-attention
import { afterEach, describe, expect, it } from 'vitest'
import {
  BRAIN_PROMPT_VERSION,
  PROMPT_UPDATE_NOTE_V7,
  PROMPT_UPDATE_NOTE_V7_OFF,
  PROMPT_UPDATE_NOTE_V8,
  PROMPT_UPDATE_NOTE_V9,
  PROMPT_UPDATE_NOTE_V10,
  buildBrainPrompt,
  promptUpdateNote
} from '../../../src/main/sessions/orchestrator'
import type { ProviderId } from '../../../src/shared/types/provider'
import { useTempDir } from '../helpers/temp-dir'
import { makeEngineRig, until } from './engine-rig'
import type { EngineRig } from './engine-rig'

const dir = useTempDir('arc-brain-v10-')
let e: EngineRig | undefined

afterEach(async () => {
  await e?.close()
  e = undefined
})

const base = {
  groupName: 'G',
  knowledgePath: '/k',
  projects: [],
  workersEnabled: true,
  brainProvider: 'claude' as const
}

/** What the prompt's show_surface line and the note both say about the panel and a click. */
const REPLY_LINE =
  'The user sees the panel, so do not repeat its contents in your reply. A click comes back as a message that starts with "[Surface action]".'

describe('brain prompt version 10', () => {
  it('is at least version 10', () => {
    expect(BRAIN_PROMPT_VERSION).toBeGreaterThanOrEqual(10)
  })

  it('says the same about the panel in the prompt and in the note', () => {
    expect(buildBrainPrompt(base)).toContain(`- show_surface: Shows the user an interactive panel`)
    expect(buildBrainPrompt(base)).toContain(REPLY_LINE)
    expect(PROMPT_UPDATE_NOTE_V10).toContain(REPLY_LINE)
  })

  it('names the tool for every provider that has the bridge, needing nothing more', () => {
    expect(buildBrainPrompt(base)).toContain('mcp__arc__show_surface"')
    for (const brainProvider of ['codex', 'cursor'] as ProviderId[]) {
      expect(buildBrainPrompt({ ...base, brainProvider })).toMatch(
        /suggest_knowledge_update, show_surface\./
      )
    }
  })

  it('leaves the panel out for a brain without workers', () => {
    const prompt = buildBrainPrompt({ ...base, workersEnabled: false })
    expect(prompt).not.toContain('show_surface')
  })
})

describe('the version 10 update note', () => {
  it('reads as the task says', () => {
    expect(PROMPT_UPDATE_NOTE_V10).toBe(
      `[Arc] Updated instructions: you can show the user an interactive panel in the conversation with show_surface: text, inputs, buttons, tiles, tables, charts, code and name/value lists. Write the panel as A2UI Express in the express field; the tool description has the format. ${REPLY_LINE}`
    )
    expect(PROMPT_UPDATE_NOTE_V10).not.toMatch(/[—–]/)
  })

  it('gives a version 9 session the note once and a current one nothing', () => {
    expect(promptUpdateNote(9, undefined, 'PROVIDERS')).toBe(PROMPT_UPDATE_NOTE_V10)
    expect(promptUpdateNote(10, undefined, 'PROVIDERS')).toBeUndefined()
  })

  it('leaves it out for a brain without the bridge', () => {
    expect(promptUpdateNote(9)).toBeUndefined()
    expect(promptUpdateNote(9, [])).toBeUndefined()
  })

  it('follows the earlier notes of an older session, in order, each once', () => {
    const note = promptUpdateNote(6, undefined, 'PROVIDERS', true) ?? ''
    expect(note).toBe(
      `${PROMPT_UPDATE_NOTE_V7}\n\n${PROMPT_UPDATE_NOTE_V8}\n\n${PROMPT_UPDATE_NOTE_V9}\n\n${PROMPT_UPDATE_NOTE_V10}`
    )
    expect(note.split(PROMPT_UPDATE_NOTE_V10)).toHaveLength(2)
  })

  it('comes after the version 9 note when suggestions are switched off', () => {
    expect(promptUpdateNote(6, undefined, 'PROVIDERS', false)).toBe(
      `${PROMPT_UPDATE_NOTE_V7_OFF}\n\n${PROMPT_UPDATE_NOTE_V8}\n\n${PROMPT_UPDATE_NOTE_V9}\n\n${PROMPT_UPDATE_NOTE_V10}`
    )
  })
})

describe('a resumed version 9 session', () => {
  it('is sent the version 10 note once, stored as version 10, and the next message carries none', async () => {
    e = await makeEngineRig(dir(), {})
    const id = await e.startSession('autonomous')
    e.rig.sessionsRepo.setBrainPromptVersion(id, 9)
    await e.rig.service.shutdown()
    await e.rig.service.sendMessage(id, 'and then?')
    await until(() => e!.rig.adapter.starts.length > 1)
    const brain = e.rig.adapter.last
    await until(() => brain.sent.length > 0)
    expect(brain.sent[0]).toBe(`${PROMPT_UPDATE_NOTE_V10}\n\nand then?`)
    expect(e.rig.sessionsRepo.getById(id)?.brainPromptVersion).toBe(BRAIN_PROMPT_VERSION)
    await e.rig.service.sendMessage(id, 'again')
    await until(() => brain.sent.length > 1)
    expect(brain.sent[1]).toBe('again')
  })
})
