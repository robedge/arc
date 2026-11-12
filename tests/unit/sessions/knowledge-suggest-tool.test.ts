import { afterEach, describe, expect, it, vi } from 'vitest'
import { KnowledgeSuggestionRefused } from '../../../src/main/knowledge/knowledge-suggestion-service'
import type { KnowledgeSuggestionPort } from '../../../src/main/sessions/knowledge-suggestion-bridge'
import { useTempDir } from '../helpers/temp-dir'
import { makeEngineRig } from './engine-rig'
import type { EngineRig } from './engine-rig'

vi.setConfig({ testTimeout: 30000 })

const dir = useTempDir('arc-suggest-tool-')
let e: EngineRig | undefined

afterEach(async () => {
  await e?.close()
  e = undefined
})

const args = {
  kind: 'new',
  title: 'Orders table is partitioned by month',
  reason: 'Read in the schema dump',
  section: 'Notes',
  name: 'Service map',
  content: 'Checkout calls pricing twice.'
}

async function start(
  suggest: KnowledgeSuggestionPort['suggest']
): Promise<{ rig: EngineRig; sessionId: string }> {
  e = await makeEngineRig(dir(), { knowledgeSuggestions: { suggest } })
  return { rig: e, sessionId: await e.startSession('autonomous') }
}

describe('suggest_knowledge_update through the orchestrator', () => {
  it('passes the session id, the group id and the latest user message id', async () => {
    const suggest = vi.fn(() => Promise.resolve({ id: 'k1', remainingThisRequest: 4 }))
    const { rig, sessionId } = await start(suggest)
    const outcome = await rig.call(rig.brain(), 'suggest_knowledge_update', args)
    expect(outcome).toEqual({
      isError: false,
      value: { ok: true, id: 'k1', remainingThisRequest: 4 }
    })
    const firstUser = rig.rig.messagesRepo.latestUserId(sessionId)
    expect(firstUser).toBeDefined()
    expect(suggest).toHaveBeenCalledWith(
      sessionId,
      rig.rig.groupId,
      String(firstUser),
      expect.objectContaining({ kind: 'new', section: 'Notes', name: 'Service map' })
    )
  })

  it('uses a new request id after a new user message', async () => {
    const suggest = vi.fn(() => Promise.resolve({ id: 'k1', remainingThisRequest: 4 }))
    const { rig, sessionId } = await start(suggest)
    await rig.call(rig.brain(), 'suggest_knowledge_update', args)
    const { messageId } = await rig.rig.service.sendMessage(sessionId, 'Also cover the web app')
    await rig.call(rig.brain(), 'suggest_knowledge_update', { ...args, name: 'Other' })
    const ids = suggest.mock.calls.map((c) => (c as unknown as string[])[2])
    expect(ids).toHaveLength(2)
    expect(ids[1]).toBe(String(messageId))
    expect(ids[1]).not.toBe(ids[0])
  })

  it('maps unknown_section to a hint that lists the valid sections', async () => {
    const { rig } = await start(() =>
      Promise.reject(
        new KnowledgeSuggestionRefused('unknown_section', 'No section named "Wiki".', [
          'Notes',
          'Docs',
          'Playbooks'
        ])
      )
    )
    const outcome = await rig.call(rig.brain(), 'suggest_knowledge_update', args)
    expect(outcome.isError).toBe(true)
    expect(outcome.value['error']).toBe('unknown_section')
    expect(outcome.value['message']).toContain('Notes, Docs, Playbooks')
  })

  it.each([
    ['section_not_allowed', 'Suggestions cannot go into Projects.'],
    ['not_text_file', 'Only text files can be suggested, not .pdf.'],
    ['invalid_name', 'The note name is not allowed.'],
    ['duplicate', 'This suggestion was already made in this session.'],
    ['file_not_found', 'No file named "Nope" in Docs.'],
    ['edit_not_found', 'Edit 2: old_text does not occur in the file.'],
    ['edit_ambiguous', 'Edit 1: old_text occurs 2 times in the file.']
  ] as const)('maps %s to an error result with that code', async (code, message) => {
    const { rig } = await start(() => Promise.reject(new KnowledgeSuggestionRefused(code, message)))
    const outcome = await rig.call(rig.brain(), 'suggest_knowledge_update', args)
    expect(outcome.isError).toBe(true)
    expect(outcome.value['error']).toBe(code)
    expect(outcome.value['message']).toContain(message)
  })

  it('passes an update with its file and edits to the service port', async () => {
    const suggest = vi.fn(() => Promise.resolve({ id: 'k2', remainingThisRequest: 4 }))
    const { rig, sessionId } = await start(suggest)
    const outcome = await rig.call(rig.brain(), 'suggest_knowledge_update', {
      kind: 'update',
      title: 'Orders table is partitioned by month',
      reason: 'Read in the schema dump',
      section: 'Docs',
      file: 'Database schema',
      edits: [{ old_text: 'stored daily', new_text: 'partitioned by month' }]
    })
    expect(outcome).toEqual({
      isError: false,
      value: { ok: true, id: 'k2', remainingThisRequest: 4 }
    })
    expect(suggest).toHaveBeenCalledWith(
      sessionId,
      rig.rig.groupId,
      expect.any(String),
      expect.objectContaining({
        kind: 'update',
        section: 'Docs',
        file: 'Database schema',
        edits: [{ old_text: 'stored daily', new_text: 'partitioned by month' }]
      })
    )
  })

  it('answers an update without edits with invalid_input', async () => {
    const suggest = vi.fn(() => Promise.resolve({ id: 'k2', remainingThisRequest: 4 }))
    const { rig } = await start(suggest)
    const outcome = await rig.call(rig.brain(), 'suggest_knowledge_update', {
      kind: 'update',
      title: 't',
      reason: 'r',
      section: 'Docs',
      file: 'Database schema'
    })
    expect(outcome.isError).toBe(true)
    expect(outcome.value['error']).toBe('invalid_input')
    expect(suggest).not.toHaveBeenCalled()
  })

  it.each([
    ['file_not_found', 'No file named "Nope" in Docs.', /section/i],
    ['edit_not_found', 'Edit 2: old_text does not occur in the file.', /read the file.*exactly/i],
    ['edit_ambiguous', 'Edit 1: old_text occurs 2 times in the file.', /more surrounding text/i]
  ] as const)('gives %s a hint the brain can act on', async (code, message, hint) => {
    const { rig } = await start(() => Promise.reject(new KnowledgeSuggestionRefused(code, message)))
    const outcome = await rig.call(rig.brain(), 'suggest_knowledge_update', args)
    expect(String(outcome.value['message'])).toMatch(hint)
  })

  it('is unavailable when no service is wired', async () => {
    e = await makeEngineRig(dir())
    await e.startSession('autonomous')
    const outcome = await e.call(e.brain(), 'suggest_knowledge_update', args)
    expect(outcome.isError).toBe(true)
    expect(outcome.value['error']).toBe('unavailable')
  })
})
