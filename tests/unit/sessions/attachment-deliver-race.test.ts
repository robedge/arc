import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AttachmentSender } from '../../../src/main/attachments/attachment-send'
import { AttachmentService } from '../../../src/main/attachments/attachment-service'
import { MessageAttachmentsRepo } from '../../../src/main/db/repositories/message-attachments-repo'
import { createStubDialogs } from '../../../src/main/platform/dialogs'
import { useTempDir } from '../helpers/temp-dir'
import { makeEngineRig, until } from './engine-rig'
import type { EngineRig } from './engine-rig'
import type { Orchestrator } from '../../../src/main/sessions/orchestrator'

const dir = useTempDir('arc-att-race-')
let e: EngineRig | undefined
const unhandled: unknown[] = []
const onUnhandled = (reason: unknown): void => void unhandled.push(reason)

afterEach(async () => {
  process.off('unhandledRejection', onUnhandled)
  await e?.close()
  e = undefined
  unhandled.length = 0
})

const plan = {
  name: 'api-retry',
  task: 'Add retry to the API client',
  repos: ['api'],
  model: 'sonnet',
  rationale: 'No retry yet.'
}

describe('a plan starts waiting between the service check and the delivery', () => {
  it('raises no unhandled rejection, keeps the stored message, and tells the user it was not delivered', async () => {
    process.on('unhandledRejection', onUnhandled)
    const rig = await makeEngineRig(dir())
    e = rig
    const svc = new AttachmentService({
      stagingRoot: join(dir(), 'staging'),
      dialogs: createStubDialogs().dialogs
    })
    const deps = rig.rig.service['deps']
    deps.messageAttachmentsRepo = new MessageAttachmentsRepo(rig.rig.opened.db)
    deps.attachmentSender = new AttachmentSender({
      db: rig.rig.opened.db,
      staging: svc,
      getSessionDir: rig.rig.deps.getSessionDir,
      now: () => Date.now(),
      log: { warn: vi.fn() }
    })
    const warn = vi.spyOn(deps.log, 'warn')
    const sessionId = await rig.startSession()
    const orchestrator: Orchestrator = rig.rig.service['orchestrators'].values().next().value!

    const { draftId } = svc.newDraft()
    const file = join(dir(), 'notes.txt')
    writeFileSync(file, 'x')
    const ids = (await svc.stagePaths(draftId, [file])).attachments.map((a) => a.id)

    // The plan appears after the service's check has passed: the check sees no waiter once, then
    // the orchestrator's own guard sees the real one.
    const pending = rig.call(rig.brain(), 'propose_plan', { workers: [plan] })
    await until(() => rig.rig.deps.plansRepo.latest(sessionId) !== undefined)
    expect(orchestrator.hasPlanAwaitingFeedback()).toBe(true)
    const check = vi.spyOn(orchestrator, 'hasPlanAwaitingFeedback').mockReturnValueOnce(false)

    const res = await rig.rig.service.sendMessage(sessionId, 'tighten step 2', {
      draftId,
      attachmentIds: ids
    })
    expect(check).toHaveBeenCalled()
    await until(() =>
      rig.rig.messagesRepo
        .latest(sessionId, 20)
        .some((m) => m.role === 'system' && /not delivered/i.test(m.content))
    )
    await new Promise((r) => setTimeout(r, 30))

    expect(unhandled).toEqual([])
    // The message and its attachment stay stored and visible.
    const user = rig.rig.messagesRepo
      .latest(sessionId, 20)
      .filter((m) => m.role === 'user')
      .at(-1)
    expect(user?.content).toBe('tighten step 2')
    expect(res.attachments).toHaveLength(1)
    expect(new MessageAttachmentsRepo(rig.rig.opened.db).listForSession(sessionId)).toHaveLength(1)
    // The system message says what to do, and the plan is still waiting.
    const note = rig.rig.messagesRepo
      .latest(sessionId, 20)
      .find((m) => m.role === 'system' && /not delivered/i.test(m.content))
    expect(note?.content).toMatch(/plan/i)
    expect(orchestrator.hasPlanAwaitingFeedback()).toBe(true)
    // The warning holds the session id and an error name, never the file's name or path.
    const logged = JSON.stringify(warn.mock.calls)
    expect(logged).toContain(sessionId)
    expect(logged).not.toContain('notes.txt')
    expect(logged).not.toContain(dir())

    // Unblock the pending plan call so the rig closes cleanly.
    await orchestrator.send('tighten')
    await pending
  })
})
