import { afterEach, describe, expect, it, vi } from 'vitest'
import { messageRowDto } from '../../../src/main/sessions/message-prompt'
import { useTempDir } from '../helpers/temp-dir'
import { makeEngineRig, until } from './engine-rig'
import type { EngineRig } from './engine-rig'
import { doneWorker } from './merge-rig'

vi.setConfig({ testTimeout: 30000 })

const dir = useTempDir('arc-review-link-')
let e: EngineRig | undefined

afterEach(async () => {
  await e?.close()
  e = undefined
})

const isSummary = (t: string): boolean => t.startsWith('[Arc] All workers finished')

/** One worker merged: the final summary request reaches the brain. */
async function startAtSummary(): Promise<{ sessionId: string; rig: EngineRig }> {
  e = await makeEngineRig(dir())
  const sessionId = await e.startSession('autonomous')
  const rig = e
  await doneWorker(rig, 'api-retry', 'api', { 'retry.txt': 'retry\n' })
  await rig.call(rig.brain(), 'merge_worker', { workerId: 'W1' })
  await until(() => rig.brain().sent.some(isSummary))
  return { sessionId, rig }
}

function reply(rig: EngineRig, id: string, text: string): void {
  rig.brain().emit({ type: 'assistant-message', messageId: id, text })
}

function endTurn(rig: EngineRig, interrupted = false): void {
  rig.brain().emit({ type: 'turn-result', ok: !interrupted, interrupted, durationMs: 1 })
}

const stored = (rig: EngineRig, sessionId: string) =>
  rig.rig.messagesRepo.latest(sessionId, 50).map((r) => messageRowDto(r))

const brainMessages = (rig: EngineRig) =>
  rig.rig.of('session:message').filter((p) => p.message.role === 'brain')

describe('review-link tag on the summary reply', () => {
  it('tags the reply to the summary request, persists it and pushes it', async () => {
    const { sessionId, rig } = await startAtSummary()
    reply(rig, 'a1', 'Here is the summary.')
    endTurn(rig)
    await until(() => stored(rig, sessionId).some((m) => m.prompt?.kind === 'review-link'))

    const tagged = stored(rig, sessionId).filter((m) => m.prompt?.kind === 'review-link')
    expect(tagged).toHaveLength(1)
    expect(tagged[0]).toMatchObject({ role: 'brain', content: 'Here is the summary.' })
    // The pushed message carries the tag (the last push for that id).
    const pushes = brainMessages(rig).filter((p) => p.message.id === tagged[0]?.id)
    expect(pushes.at(-1)?.message.prompt).toEqual({ kind: 'review-link' })
    expect(pushes.at(-1)?.message.content).toBe('Here is the summary.')
    // Reopen: the stored row still parses to the prompt.
    const row = rig.rig.messagesRepo.get(tagged[0]?.id ?? -1)
    expect(row && messageRowDto(row).prompt).toEqual({ kind: 'review-link' })
  })

  it('tags only the last reply of the summary turn', async () => {
    const { sessionId, rig } = await startAtSummary()
    reply(rig, 'a1', 'Checking first.')
    reply(rig, 'a2', 'Final summary.')
    endTurn(rig)
    await until(() => stored(rig, sessionId).some((m) => m.prompt?.kind === 'review-link'))
    const tagged = stored(rig, sessionId).filter((m) => m.prompt?.kind === 'review-link')
    expect(tagged.map((m) => m.content)).toEqual(['Final summary.'])
  })

  it('does not tag a later brain reply', async () => {
    const { sessionId, rig } = await startAtSummary()
    reply(rig, 'a1', 'Summary.')
    endTurn(rig)
    await until(() => stored(rig, sessionId).some((m) => m.prompt?.kind === 'review-link'))

    await rig.rig.service.sendMessage(sessionId, 'thanks, anything else?')
    reply(rig, 'a2', 'No, that is all.')
    endTurn(rig)
    await until(() => stored(rig, sessionId).some((m) => m.content === 'No, that is all.'))
    await new Promise((r) => setTimeout(r, 50))

    const tagged = stored(rig, sessionId).filter((m) => m.prompt?.kind === 'review-link')
    expect(tagged.map((m) => m.content)).toEqual(['Summary.'])
    expect(
      brainMessages(rig).filter((p) => p.message.content === 'No, that is all.')[0]?.message.prompt
    ).toBeUndefined()
  })

  it('posts "All work is merged." with the tag when the summary turn is interrupted', async () => {
    const { sessionId, rig } = await startAtSummary()
    endTurn(rig, true)
    await until(() => stored(rig, sessionId).some((m) => m.prompt?.kind === 'review-link'))

    const tagged = stored(rig, sessionId).filter((m) => m.prompt?.kind === 'review-link')
    expect(tagged).toHaveLength(1)
    expect(tagged[0]).toMatchObject({ role: 'system', content: 'All work is merged.' })
    const pushed = rig.rig.of('session:message').filter((p) => p.message.role === 'system')
    expect(pushed.at(-1)?.message.prompt).toEqual({ kind: 'review-link' })
  })

  it('posts the fallback when the turn ends without any reply text', async () => {
    const { sessionId, rig } = await startAtSummary()
    endTurn(rig)
    await until(() => stored(rig, sessionId).some((m) => m.prompt?.kind === 'review-link'))
    expect(stored(rig, sessionId).filter((m) => m.prompt?.kind === 'review-link')[0]).toMatchObject(
      { role: 'system', content: 'All work is merged.' }
    )
  })

  it('tags the summary reply only when a user message arrives meanwhile', async () => {
    const { sessionId, rig } = await startAtSummary()
    reply(rig, 'a1', 'Summary.')
    await rig.rig.service.sendMessage(sessionId, 'one more thing')
    endTurn(rig)
    reply(rig, 'a2', 'Sure.')
    endTurn(rig)
    await until(() => stored(rig, sessionId).some((m) => m.content === 'Sure.'))
    const tagged = stored(rig, sessionId).filter((m) => m.prompt?.kind === 'review-link')
    expect(tagged.map((m) => m.content)).toEqual(['Summary.'])
  })

  it('adds nothing when the session is closed mid-turn', async () => {
    const { sessionId, rig } = await startAtSummary()
    await rig.rig.service.shutdown()
    await new Promise((r) => setTimeout(r, 50))
    expect(stored(rig, sessionId).some((m) => m.prompt?.kind === 'review-link')).toBe(false)
  })
})
