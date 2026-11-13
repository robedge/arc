import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AttachmentSender } from '../../../src/main/attachments/attachment-send'
import { sentAttachmentPath } from '../../../src/main/attachments/attachment-paths'
import { AttachmentService } from '../../../src/main/attachments/attachment-service'
import { MessageAttachmentsRepo } from '../../../src/main/db/repositories/message-attachments-repo'
import { createStubDialogs } from '../../../src/main/platform/dialogs'
import { channelSchemas } from '../../../src/shared/ipc/contract'
import { useTempDir } from '../helpers/temp-dir'
import { makeRig } from './helpers'
import type { Rig } from './helpers'

const dir = useTempDir('arc-create-att-')
let rig: Rig
let svc: AttachmentService

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
})
afterEach(() => {
  rig.close()
  vi.useRealTimers()
})

async function setup(
  getSessionDir?: (id: string) => string
): Promise<{ draftId: string; ids: string[] }> {
  rig = await makeRig(dir())
  svc = new AttachmentService({
    stagingRoot: join(dir(), 'staging'),
    dialogs: createStubDialogs().dialogs
  })
  rig.service['deps'].messageAttachmentsRepo = new MessageAttachmentsRepo(rig.opened.db)
  rig.service['deps'].attachmentSender = new AttachmentSender({
    db: rig.opened.db,
    staging: svc,
    getSessionDir: getSessionDir ?? rig.deps.getSessionDir,
    now: () => rig.clock.now,
    log: { warn: vi.fn() }
  })
  const { draftId } = svc.newDraft()
  const paths: string[] = []
  for (const [name, body] of [
    ['a.txt', 'alpha'],
    ['b.txt', 'bravo']
  ] as const) {
    const p = join(dir(), name)
    writeFileSync(p, body)
    paths.push(p)
  }
  const staged = await svc.stagePaths(draftId, paths)
  return { draftId, ids: staged.attachments.map((a) => a.id) }
}

const sessionRows = (): number => rig.sessionsRepo.listByGroup(rig.groupId).length
const countAttachments = (): number =>
  ['S1', 'S2'].reduce(
    (n, id) => n + new MessageAttachmentsRepo(rig.opened.db).listForSession(id).length,
    0
  )
const stagedStill = (ids: string[]): boolean => ids.every((id) => existsSync(svc.stagedPath(id)!))

describe('sessions:create with attachments', () => {
  it('writes the session, message and rows in order, copies the files, releases staging and briefs the brain', async () => {
    const { draftId, ids } = await setup()
    const result = await rig.service.create(
      rig.groupId,
      'Look at these',
      'plan_first',
      3,
      undefined,
      {
        draftId,
        attachmentIds: ids
      }
    )
    if (!('sessionId' in result)) throw new Error('expected a session id')
    await vi.advanceTimersByTimeAsync(0)
    const sessionId = result.sessionId
    const rows = new MessageAttachmentsRepo(rig.opened.db).listForSession(sessionId)
    expect(rows.map((r) => r.name)).toEqual(['a.txt', 'b.txt'])
    for (const r of rows) {
      const path = sentAttachmentPath(rig.deps.getSessionDir(sessionId), r.id, r.storedName)
      expect(existsSync(path)).toBe(true)
    }
    expect(
      readFileSync(
        sentAttachmentPath(rig.deps.getSessionDir(sessionId), rows[0]!.id, rows[0]!.storedName),
        'utf8'
      )
    ).toBe('alpha')
    expect(svc.staged(draftId, ids)).toEqual([])
    expect(rig.adapter.last.sent.at(-1)).toBe('Look at these')
    expect(rig.adapter.last.sentAttachments.at(-1)?.map((a) => a.name)).toEqual(['a.txt', 'b.txt'])
    // The renderer opens the new session and gets the first message with its attachments.
    const first = rig.service.snapshot(sessionId).messages.find((m) => m.role === 'user')
    expect(first?.content).toBe('Look at these')
    expect(first?.attachments?.map((a) => a.name)).toEqual(['a.txt', 'b.txt'])
  })

  it('starts with attachments and no request: empty first message, placeholder name, brain gets the files', async () => {
    const { draftId, ids } = await setup()
    const result = await rig.service.create(rig.groupId, '  ', 'plan_first', 3, undefined, {
      draftId,
      attachmentIds: ids
    })
    if (!('sessionId' in result)) throw new Error('expected a session id')
    await vi.advanceTimersByTimeAsync(0)
    const first = rig.messagesRepo.latest(result.sessionId, 5).find((m) => m.role === 'user')
    expect(first?.content).toBe('')
    expect(rig.adapter.last.sentAttachments.at(-1)).toHaveLength(2)
    expect(rig.service.list(rig.groupId)[0]?.name).toBe('New session')
    expect(rig.service.snapshot(result.sessionId).header.name).toBe('New session')
  })

  it('writes nothing and keeps the staged files when Claude Code is unavailable', async () => {
    const { draftId, ids } = await setup()
    rig.recheck.mockResolvedValue({ state: 'signed_out', message: 'no' })
    rig.service['deps'].getCliStatus = () => undefined
    await expect(
      rig.service.create(rig.groupId, 'hi', 'plan_first', 3, undefined, {
        draftId,
        attachmentIds: ids
      })
    ).rejects.toMatchObject({ code: 'CLI_UNAVAILABLE' })
    expect(sessionRows()).toBe(0)
    expect(countAttachments()).toBe(0)
    expect(existsSync(join(dir(), 'userData', 'sessions'))).toBe(false)
    expect(stagedStill(ids)).toBe(true)
  })

  it('refuses a missing staged file with ATTACHMENT_UNREADABLE and writes nothing', async () => {
    const { draftId, ids } = await setup()
    rmSyncStaged(ids[1]!)
    await expect(
      rig.service.create(rig.groupId, 'hi', 'plan_first', 3, undefined, {
        draftId,
        attachmentIds: ids
      })
    ).rejects.toMatchObject({ code: 'ATTACHMENT_UNREADABLE' })
    expect(sessionRows()).toBe(0)
    expect(countAttachments()).toBe(0)
  })

  it('writes nothing, removes the session folder and keeps staging when a copy fails', async () => {
    const blocker = join(dir(), 'blocker')
    writeFileSync(blocker, 'a file')
    const { draftId, ids } = await setup((id) => join(blocker, id))
    await expect(
      rig.service.create(rig.groupId, 'hi', 'plan_first', 3, undefined, {
        draftId,
        attachmentIds: ids
      })
    ).rejects.toMatchObject({ code: 'IO_FAILED' })
    expect(sessionRows()).toBe(0)
    expect(countAttachments()).toBe(0)
    expect(stagedStill(ids)).toBe(true)
  })

  it('rolls back the session and removes the session folder when the insert fails', async () => {
    const { draftId, ids } = await setup()
    // A size of 0 violates the table's CHECK, so the second row fails the insert.
    svc.staged(draftId, [ids[1]!])[0]!.meta.size = 0
    await expect(
      rig.service.create(rig.groupId, 'hi', 'plan_first', 3, undefined, {
        draftId,
        attachmentIds: ids
      })
    ).rejects.toBeDefined()
    expect(sessionRows()).toBe(0)
    expect(rig.messagesRepo.latest('S1', 5)).toEqual([])
    expect(countAttachments()).toBe(0)
    expect(existsSync(rig.deps.getSessionDir('S1'))).toBe(false)
    expect(stagedStill(ids)).toBe(true)
  })

  it('leaves a plain text create unchanged', async () => {
    rig = await makeRig(dir())
    const result = await rig.service.create(rig.groupId, ' build it ', 'plan_first', 3)
    if (!('sessionId' in result)) throw new Error('expected a session id')
    await vi.advanceTimersByTimeAsync(0)
    expect(rig.messagesRepo.latest(result.sessionId, 5).map((m) => m.content)).toEqual(['build it'])
    expect(rig.adapter.last.sent.at(-1)).toBe('build it')
    await expect(rig.service.create(rig.groupId, '  ', 'plan_first', 3)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED'
    })
  })
})

function rmSyncStaged(id: string): void {
  rmSync(svc.stagedPath(id)!)
}

describe('sessions:create schema', () => {
  const schema = channelSchemas['sessions:create']
  const D = '01HZZZZZZZZZZZZZZZZZZZZZZZ'
  const id = (n: number): string => `01HZZZZZZZZZZZZZZZZZZZZZ${String(n).padStart(2, '0')}`
  const base = { groupId: 'g', mode: 'plan_first', workerLimit: 3 }
  it('accepts text, and an empty request with attachments', () => {
    expect(schema.safeParse({ ...base, request: 'hi' }).success).toBe(true)
    expect(
      schema.safeParse({ ...base, request: '', draftId: D, attachmentIds: [id(1)] }).success
    ).toBe(true)
  })
  it('rejects an empty request without attachments, ids without a draft, duplicates and 11 ids', () => {
    expect(schema.safeParse({ ...base, request: ' ' }).success).toBe(false)
    expect(schema.safeParse({ ...base, request: 'x', attachmentIds: [id(1)] }).success).toBe(false)
    expect(
      schema.safeParse({ ...base, request: 'x', draftId: D, attachmentIds: [id(1), id(1)] }).success
    ).toBe(false)
    const eleven = Array.from({ length: 11 }, (_, i) => id(i))
    expect(
      schema.safeParse({ ...base, request: 'x', draftId: D, attachmentIds: eleven }).success
    ).toBe(false)
    expect(schema.safeParse({ ...base, request: 'x', extra: 1 }).success).toBe(false)
  })
})
