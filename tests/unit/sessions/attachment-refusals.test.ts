import { existsSync, readdirSync, writeFileSync } from 'node:fs'
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

const dir = useTempDir('arc-att-refuse-')
let e: EngineRig | undefined

afterEach(async () => {
  await e?.close()
  e = undefined
})

const plan = {
  name: 'api-retry',
  task: 'Add retry to the API client',
  repos: ['api'],
  model: 'sonnet',
  rationale: 'No retry yet.'
}

async function setup(): Promise<{
  sessionId: string
  svc: AttachmentService
  draftId: string
  ids: string[]
  rig: EngineRig
}> {
  const rig = await makeEngineRig(dir())
  e = rig
  const svc = new AttachmentService({
    stagingRoot: join(dir(), 'staging'),
    dialogs: createStubDialogs().dialogs
  })
  rig.rig.service['deps'].messageAttachmentsRepo = new MessageAttachmentsRepo(rig.rig.opened.db)
  rig.rig.service['deps'].attachmentSender = new AttachmentSender({
    db: rig.rig.opened.db,
    staging: svc,
    getSessionDir: rig.rig.deps.getSessionDir,
    now: () => Date.now(),
    log: { warn: vi.fn() }
  })
  const sessionId = await rig.startSession()
  const { draftId } = svc.newDraft()
  const paths: string[] = []
  for (const name of ['a.txt', 'b.txt']) {
    const p = join(dir(), name)
    writeFileSync(p, name)
    paths.push(p)
  }
  const staged = await svc.stagePaths(draftId, paths)
  return { sessionId, svc, draftId, ids: staged.attachments.map((a) => a.id), rig }
}

const orchestratorOf = (rig: EngineRig): Orchestrator =>
  rig.rig.service['orchestrators'].values().next().value!
const userRows = (rig: EngineRig, id: string) =>
  rig.rig.messagesRepo.latest(id, 50).filter((m) => m.role === 'user')
const sentFolder = (rig: EngineRig, id: string): string[] => {
  const folder = join(rig.rig.deps.getSessionDir(id), 'attachments')
  return existsSync(folder) ? readdirSync(folder) : []
}
const stagedIntact = (svc: AttachmentService, draftId: string, ids: string[]): boolean =>
  svc.staged(draftId, ids).length === ids.length &&
  ids.every((id) => existsSync(svc.stagedPath(id)!))

describe('attachments with a command', () => {
  it('refuses "/review" with attachments before anything is written, and a retry without the slash succeeds', async () => {
    const { sessionId, svc, draftId, ids, rig } = await setup()
    const rowsBefore = userRows(rig, sessionId).length
    const sentBefore = rig.rig.adapter.last.sent.length
    await expect(
      rig.rig.service.sendMessage(sessionId, '  /review the diff', { draftId, attachmentIds: ids })
    ).rejects.toMatchObject({ code: 'ATTACHMENTS_WITH_COMMAND' })
    expect(userRows(rig, sessionId)).toHaveLength(rowsBefore)
    expect(new MessageAttachmentsRepo(rig.rig.opened.db).listForSession(sessionId)).toEqual([])
    expect(sentFolder(rig, sessionId)).toEqual([])
    expect(stagedIntact(svc, draftId, ids)).toBe(true)
    expect(rig.rig.adapter.last.sent).toHaveLength(sentBefore)

    const res = await rig.rig.service.sendMessage(sessionId, 'review the diff', {
      draftId,
      attachmentIds: ids
    })
    expect(res.attachments.map((a) => a.id)).toEqual(ids)
    expect(stagedIntact(svc, draftId, ids)).toBe(false)
  })

  it('treats a lone slash as a command too, and a slash later in the text as an ordinary message', async () => {
    const { sessionId, draftId, ids, rig } = await setup()
    await expect(
      rig.rig.service.sendMessage(sessionId, '/', { draftId, attachmentIds: ids })
    ).rejects.toMatchObject({ code: 'ATTACHMENTS_WITH_COMMAND' })
    const res = await rig.rig.service.sendMessage(sessionId, 'look at src/a.ts and /tmp/x', {
      draftId,
      attachmentIds: ids
    })
    expect(res.attachments).toHaveLength(2)
  })

  it('still sends a /command without attachments', async () => {
    const { sessionId, rig } = await setup()
    const res = await rig.rig.service.sendMessage(sessionId, '/review')
    expect(res.attachments).toEqual([])
    await until(() => rig.rig.adapter.last.sent.at(-1)?.startsWith('/review') === true)
  })

  it('refuses a first request that starts with "/" plus attachments: no session, staged intact', async () => {
    const { svc, draftId, ids, rig } = await setup()
    const sessionsBefore = rig.rig.sessionsRepo.listByGroup(rig.rig.groupId).length
    await expect(
      rig.rig.service.create(rig.rig.groupId, '/review', 'plan_first', 3, undefined, {
        draftId,
        attachmentIds: ids
      })
    ).rejects.toMatchObject({ code: 'ATTACHMENTS_WITH_COMMAND' })
    expect(rig.rig.sessionsRepo.listByGroup(rig.rig.groupId)).toHaveLength(sessionsBefore)
    expect(stagedIntact(svc, draftId, ids)).toBe(true)
  })
})

describe('attachments with plan feedback', () => {
  it('refuses attachments while a plan awaits approval, leaving the plan waiting; the same text alone is the comment', async () => {
    const { sessionId, svc, draftId, ids, rig } = await setup()
    let settled = false
    const pending = rig.call(rig.brain(), 'propose_plan', { workers: [plan] }).then((r) => {
      settled = true
      return r
    })
    await until(() => rig.rig.deps.plansRepo.latest(sessionId) !== undefined)
    const planId = rig.rig.deps.plansRepo.latest(sessionId)!.id
    const rowsBefore = userRows(rig, sessionId).length

    await expect(
      rig.rig.service.sendMessage(sessionId, 'tighten step 2', { draftId, attachmentIds: ids })
    ).rejects.toMatchObject({ code: 'ATTACHMENTS_WITH_PLAN_FEEDBACK' })
    await new Promise((r) => setTimeout(r, 60))
    expect(settled).toBe(false)
    expect(rig.rig.deps.plansRepo.get(planId)?.status).toBe('proposed')
    expect(userRows(rig, sessionId)).toHaveLength(rowsBefore)
    expect(new MessageAttachmentsRepo(rig.rig.opened.db).listForSession(sessionId)).toEqual([])
    expect(sentFolder(rig, sessionId)).toEqual([])
    expect(stagedIntact(svc, draftId, ids)).toBe(true)

    await rig.rig.service.sendMessage(sessionId, 'tighten step 2')
    const result = await pending
    expect(result.value).toMatchObject({
      planId,
      decision: 'changes_requested',
      comment: 'tighten step 2'
    })
  })

  it('sends attachments normally once no plan is waiting', async () => {
    const { sessionId, draftId, ids, rig } = await setup()
    expect(orchestratorOf(rig).hasPlanAwaitingFeedback()).toBe(false)
    const res = await rig.rig.service.sendMessage(sessionId, 'here you go', {
      draftId,
      attachmentIds: ids
    })
    expect(res.attachments).toHaveLength(2)
  })
})

describe('Orchestrator.send is defensive', () => {
  const refs = [
    {
      id: 'A1',
      name: 'n.txt',
      kind: 'text' as const,
      mime: 'text/plain',
      size: 1,
      path: '/p/n.txt'
    }
  ]

  it('throws rather than drop attachments sent with a command', async () => {
    const { rig } = await setup()
    const sentBefore = rig.rig.adapter.last.sent.length
    await expect(orchestratorOf(rig).send('/review', refs)).rejects.toThrow(/attachments/i)
    expect(rig.rig.adapter.last.sent).toHaveLength(sentBefore)
  })

  it('throws rather than drop attachments sent while a plan awaits feedback', async () => {
    const { sessionId, rig } = await setup()
    const pending = rig.call(rig.brain(), 'propose_plan', { workers: [plan] })
    await until(() => rig.rig.deps.plansRepo.latest(sessionId) !== undefined)
    const orchestrator = orchestratorOf(rig)
    expect(orchestrator.hasPlanAwaitingFeedback()).toBe(true)
    await expect(orchestrator.send('tighten', refs)).rejects.toThrow(/attachments/i)
    expect(orchestrator.hasPlanAwaitingFeedback()).toBe(true)
    // Without attachments the same text is still the comment.
    expect(await orchestrator.send('tighten')).toBe(true)
    expect((await pending).value).toMatchObject({ comment: 'tighten' })
    expect(orchestrator.hasPlanAwaitingFeedback()).toBe(false)
  })
})
