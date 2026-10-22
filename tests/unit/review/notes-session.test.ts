import { afterEach, describe, expect, it } from 'vitest'
import { ReviewNotesRepo } from '../../../src/main/db/repositories/review-notes-repo'
import { channelSchemas } from '../../../src/shared/ipc/contract'
import { makeRig } from '../sessions/helpers'
import type { Rig } from '../sessions/helpers'
import { useTempDir } from '../helpers/temp-dir'

const dir = useTempDir('arc-notes-session-')
let rig: Rig | undefined
afterEach(() => {
  rig?.close()
  rig = undefined
})

describe('review note channels', () => {
  it('are strict', () => {
    const create = channelSchemas['review:note-create']
    const valid = {
      sessionId: 's',
      projectId: 'p',
      path: 'a.ts',
      side: 'new',
      line: 3,
      lineText: 'x',
      body: 'b'
    }
    expect(create.safeParse(valid).success).toBe(true)
    expect(create.safeParse({ ...valid, side: 'left' }).success).toBe(false)
    expect(create.safeParse({ ...valid, line: 0 }).success).toBe(false)
    expect(create.safeParse({ ...valid, extra: 1 }).success).toBe(false)
    expect(channelSchemas['review:note-update'].safeParse({ noteId: 'n', body: 'b' }).success).toBe(
      true
    )
    expect(channelSchemas['review:note-update'].safeParse({ noteId: 'n' }).success).toBe(false)
    expect(channelSchemas['review:note-delete'].safeParse({ noteId: 'n', x: 1 }).success).toBe(
      false
    )
    expect(channelSchemas['review:send-notes'].safeParse({ sessionId: 's' }).success).toBe(true)
    expect(channelSchemas['review:send-notes'].safeParse({}).success).toBe(false)
  })
})

describe('SessionService.sendReviewNotes', () => {
  it('shows the message in the conversation, hands it to the brain and marks the notes sent', async () => {
    rig = await makeRig(dir())
    const created = await rig.service.create(rig.groupId, 'Fix it', 'plan_first', 3)
    if (!('sessionId' in created)) throw new Error('expected a session id')
    const sessionId = created.sessionId
    await new Promise((r) => setTimeout(r, 20))
    // Finish the first turn so the next message is delivered at once.
    rig.adapter.last.emit({
      type: 'assistant-message',
      messageId: 'm0',
      text: 'Title: Setup\nReady.'
    })
    rig.adapter.last.emit({ type: 'turn-result', ok: true, interrupted: false, durationMs: 1 })
    await new Promise((r) => setTimeout(r, 300))
    const [row] = rig.deps.sessionProjectsRepo.listBySession(sessionId)
    if (!row) throw new Error('expected a session project')
    const notes = new ReviewNotesRepo(rig.opened.db)
    notes.create({
      id: 'n1',
      sessionProjectId: row.id,
      path: 'src/sync/queue.ts',
      side: 'new',
      line: 42,
      lineText: 'const limit = 5',
      body: 'This retry limit should come from config.',
      createdAt: 1,
      updatedAt: 1
    })

    expect(() => rig?.service.sendReviewNotes('nope')).toThrow(
      expect.objectContaining({ code: 'SESSION_NOT_FOUND' })
    )
    const { messageId, count } = await rig.service.sendReviewNotes(sessionId)
    await new Promise((r) => setTimeout(r, 50))

    const text = [
      'Review notes (1):',
      `1. ${row.projectName} · src/sync/queue.ts · line 42 (new)`,
      '   > const limit = 5',
      '   This retry limit should come from config.'
    ].join('\n')
    expect(count).toBe(1)
    expect(rig.messagesRepo.latest(sessionId, 10).at(-1)).toMatchObject({
      id: messageId,
      role: 'user',
      content: text
    })
    expect(rig.adapter.last.sent.at(-1)).toBe(text)
    expect(notes.get('n1')).toMatchObject({ state: 'sent', messageId })
    await expect(rig.service.sendReviewNotes(sessionId)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED'
    })
  })
})
