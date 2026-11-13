import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { launchKey } from '../../../src/main/sessions/orchestrator'
import { AttachmentSender } from '../../../src/main/attachments/attachment-send'
import { sentAttachmentPath } from '../../../src/main/attachments/attachment-paths'
import { AttachmentService } from '../../../src/main/attachments/attachment-service'
import { MessageAttachmentsRepo } from '../../../src/main/db/repositories/message-attachments-repo'
import { createStubDialogs } from '../../../src/main/platform/dialogs'
import { channelSchemas } from '../../../src/shared/ipc/contract'
import { useTempDir } from '../helpers/temp-dir'
import { makeRig } from './helpers'
import type { Rig } from './helpers'

const dir = useTempDir('arc-send-att-')
let rig: Rig
let svc: AttachmentService

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
})
afterEach(() => {
  rig.close()
  vi.useRealTimers()
})

async function setup(): Promise<{ sessionId: string; draftId: string; ids: string[] }> {
  rig = await makeRig(dir())
  svc = new AttachmentService({
    stagingRoot: join(dir(), 'staging'),
    dialogs: createStubDialogs().dialogs
  })
  rig.service['deps'].messageAttachmentsRepo = new MessageAttachmentsRepo(rig.opened.db)
  rig.service['deps'].attachmentSender = new AttachmentSender({
    db: rig.opened.db,
    staging: svc,
    getSessionDir: rig.deps.getSessionDir,
    now: () => rig.clock.now,
    log: { warn: vi.fn() }
  })
  const result = await rig.service.create(
    rig.groupId,
    'Plan the billing refactor please',
    'plan_first',
    3
  )
  if (!('sessionId' in result)) throw new Error('expected a session id')
  await vi.advanceTimersByTimeAsync(0)
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
  return { sessionId: result.sessionId, draftId, ids: staged.attachments.map((a) => a.id) }
}

const sessionFolder = (id: string): string => rig.deps.getSessionDir(id)
const userRows = (id: string) => rig.messagesRepo.latest(id, 50).filter((m) => m.role === 'user')

describe('send with attachments', () => {
  it('writes the message, rows in order, files at the derived paths, and clears staging', async () => {
    const { sessionId, draftId, ids } = await setup()
    const stagedPaths = ids.map((id) => svc.stagedPath(id)!)
    const res = await rig.service.sendMessage(sessionId, 'see these', {
      draftId,
      attachmentIds: [ids[1]!, ids[0]!]
    })
    expect(res.attachments).toEqual([
      { id: ids[1], name: 'b.txt', kind: 'text', size: 5 },
      { id: ids[0], name: 'a.txt', kind: 'text', size: 5 }
    ])
    const rows = new MessageAttachmentsRepo(rig.opened.db).listForMessages([res.messageId])
    expect(rows.get(res.messageId)?.map((r) => [r.id, r.position])).toEqual([
      [ids[1], 0],
      [ids[0], 1]
    ])
    const dirOf = sessionFolder(sessionId)
    expect(readFileSync(sentAttachmentPath(dirOf, ids[0]!, 'a.txt'), 'utf8')).toBe('alpha')
    expect(readFileSync(sentAttachmentPath(dirOf, ids[1]!, 'b.txt'), 'utf8')).toBe('bravo')
    for (const p of stagedPaths) expect(existsSync(p)).toBe(false)
    expect(svc.staged(draftId, ids)).toEqual([])
    await vi.advanceTimersByTimeAsync(0)
    // The brain gets the text, then the block, in the order the user attached them.
    expect(rig.adapter.last.sent.at(-1)).toBe('see these')
    expect(rig.adapter.last.sentAttachments.at(-1)).toEqual([
      expect.objectContaining({
        id: ids[1],
        name: 'b.txt',
        path: sentAttachmentPath(dirOf, ids[1]!, 'b.txt')
      }),
      expect.objectContaining({
        id: ids[0],
        name: 'a.txt',
        path: sentAttachmentPath(dirOf, ids[0]!, 'a.txt')
      })
    ])
  })

  it('moves the thumbnail of an image with the file, and sends an image without one fine', async () => {
    const { sessionId } = await setup()
    const withThumb = new AttachmentService({
      stagingRoot: join(dir(), 'staging2'),
      dialogs: createStubDialogs().dialogs,
      makeThumbnail: async (_src, dest) => {
        writeFileSync(dest, 'thumb')
        return true
      }
    })
    rig.service['deps'].attachmentSender = new AttachmentSender({
      db: rig.opened.db,
      staging: withThumb,
      getSessionDir: rig.deps.getSessionDir,
      now: () => rig.clock.now,
      log: { warn: vi.fn() }
    })
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
    const { draftId } = withThumb.newDraft()
    const [a] = (await withThumb.stageBytes(draftId, png)).attachments
    await rig.service.sendMessage(sessionId, '', { draftId, attachmentIds: [a!.id] })
    const folder = join(sessionFolder(sessionId), 'attachments', a!.id)
    expect((await readdir(folder)).sort()).toEqual(['pasted-image-1.png', 'thumb.png'])
    expect(readFileSync(join(folder, 'thumb.png'), 'utf8')).toBe('thumb')

    const { draftId: d2 } = withThumb.newDraft()
    const staged = (await withThumb.stageBytes(d2, png)).attachments[0]!
    rmSync(join(dir(), 'staging2', d2, staged.id, 'thumb.png'))
    await rig.service.sendMessage(sessionId, 'again', { draftId: d2, attachmentIds: [staged.id] })
    expect(await readdir(join(sessionFolder(sessionId), 'attachments', staged.id))).toEqual([
      'pasted-image-1.png'
    ])
  })

  it('sends with no text: empty content, and the brain gets the attachments alone', async () => {
    const { sessionId, draftId, ids } = await setup()
    const sentBefore = rig.adapter.last.sent.length
    const res = await rig.service.sendMessage(sessionId, '   ', { draftId, attachmentIds: ids })
    await vi.advanceTimersByTimeAsync(0)
    expect(userRows(sessionId).at(-1)).toMatchObject({ id: res.messageId, content: '' })
    expect(res.attachments).toHaveLength(2)
    expect(rig.adapter.last.sent).toHaveLength(sentBefore + 1)
    expect(rig.adapter.last.sent.at(-1)).toBe('')
    expect(rig.adapter.last.sentAttachments.at(-1)?.map((a) => a.name)).toEqual(['a.txt', 'b.txt'])
  })

  it('refuses a missing staged file with ATTACHMENT_UNREADABLE and writes nothing', async () => {
    const { sessionId, draftId, ids } = await setup()
    const { rm } = await import('node:fs/promises')
    await rm(svc.stagedPath(ids[1]!)!)
    await expect(
      rig.service.sendMessage(sessionId, 'x', { draftId, attachmentIds: ids })
    ).rejects.toMatchObject({ code: 'ATTACHMENT_UNREADABLE', details: { name: 'b.txt' } })
    expect(userRows(sessionId)).toHaveLength(1)
    expect(await readdir(join(sessionFolder(sessionId), 'attachments'))).toEqual([])
    expect(existsSync(svc.stagedPath(ids[0]!)!)).toBe(true)
  })

  it('refuses an id that is not staged', async () => {
    const { sessionId, draftId, ids } = await setup()
    await expect(
      rig.service.sendMessage(sessionId, 'x', { draftId, attachmentIds: [ids[0]!, 'NOPE'] })
    ).rejects.toMatchObject({ code: 'ATTACHMENT_UNREADABLE' })
    expect(userRows(sessionId)).toHaveLength(1)
  })

  it('leaves no rows or folders when a copy fails', async () => {
    const { sessionId, draftId, ids } = await setup()
    // A file where the attachments folder should be makes every copy fail.
    rmSync(join(sessionFolder(sessionId), 'attachments'), { recursive: true })
    writeFileSync(join(sessionFolder(sessionId), 'attachments'), 'in the way')
    await expect(
      rig.service.sendMessage(sessionId, 'x', { draftId, attachmentIds: ids })
    ).rejects.toMatchObject({ code: 'IO_FAILED' })
    expect(userRows(sessionId)).toHaveLength(1)
    expect(new MessageAttachmentsRepo(rig.opened.db).listForSession(sessionId)).toEqual([])
    expect(existsSync(svc.stagedPath(ids[0]!)!)).toBe(true)
  })

  it('rolls back and removes the copied folders when the insert fails', async () => {
    const { sessionId, draftId, ids } = await setup()
    // A size of 0 violates the table's CHECK, so the second row fails the insert.
    svc.staged(draftId, [ids[1]!])[0]!.meta.size = 0
    await expect(
      rig.service.sendMessage(sessionId, 'x', { draftId, attachmentIds: ids })
    ).rejects.toBeDefined()
    expect(userRows(sessionId)).toHaveLength(1)
    expect(new MessageAttachmentsRepo(rig.opened.db).listForSession(sessionId)).toEqual([])
    const root = join(sessionFolder(sessionId), 'attachments')
    expect(existsSync(root) ? await readdir(root) : []).toEqual([])
    expect(existsSync(svc.stagedPath(ids[0]!)!)).toBe(true)
  })

  it('sends a draft once: a double click fails the second call and stores one message', async () => {
    const { sessionId, draftId, ids } = await setup()
    const send = () => rig.service.sendMessage(sessionId, 'twice', { draftId, attachmentIds: ids })
    const results = await Promise.allSettled([send(), send()])
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected'])
    const failed = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
    expect(failed.reason).toMatchObject({ code: 'ATTACHMENT_UNREADABLE' })
    expect(userRows(sessionId).filter((m) => m.content === 'twice')).toHaveLength(1)
    expect(new MessageAttachmentsRepo(rig.opened.db).listForSession(sessionId)).toHaveLength(2)
  })

  it('returns attachments on a snapshot and a page, and none on plain messages', async () => {
    const { sessionId, draftId, ids } = await setup()
    const plain = await rig.service.sendMessage(sessionId, 'plain')
    expect(plain.attachments).toEqual([])
    const withFiles = await rig.service.sendMessage(sessionId, 'files', {
      draftId,
      attachmentIds: ids
    })
    const snap = rig.service.snapshot(sessionId).messages
    expect(snap.find((m) => m.id === plain.messageId)?.attachments).toBeUndefined()
    expect(snap.find((m) => m.id === withFiles.messageId)?.attachments).toEqual(
      withFiles.attachments
    )
    const page = rig.service.page(sessionId, 'messages', withFiles.messageId + 1, 10)
    expect(page.find((m) => m.id === withFiles.messageId)?.attachments).toHaveLength(2)
  })

  it('still refuses empty text without attachments', async () => {
    await setup()
    await expect(rig.service.sendMessage('x', '  ')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED'
    })
  })
})

describe('delivery to the brain', () => {
  it('creates the attachments folder with the session and always has it in the brain addDirs', async () => {
    const { sessionId } = await setup()
    const folder = join(sessionFolder(sessionId), 'attachments')
    expect(existsSync(folder)).toBe(true)
    expect(rig.adapter.starts[0]?.addDirs).toContain(folder)
    expect(rig.adapter.starts[0]?.addDirs?.at(-1)).toBe(folder)
  })

  it('ensures the folder at launch for a session that has none yet', async () => {
    const { sessionId } = await setup()
    rmSync(join(sessionFolder(sessionId), 'attachments'), { recursive: true })
    const launch = rig.service['buildLaunch'](sessionId)
    expect(launch.addDirs.at(-1)).toBe(join(sessionFolder(sessionId), 'attachments'))
    expect(existsSync(launch.addDirs.at(-1)!)).toBe(true)
  })

  it('keeps launchKey, and the running brain, the same across a message with attachments', async () => {
    const { sessionId, draftId, ids } = await setup()
    const startsBefore = rig.adapter.starts.length
    const first = rig.adapter.starts[0]!
    const keyBefore = launchKey({ cwd: first.cwd, addDirs: [...(first.addDirs ?? [])] })
    await rig.service.sendMessage(sessionId, 'with files', { draftId, attachmentIds: ids })
    await vi.advanceTimersByTimeAsync(0)
    expect(launchKey(rig.service['buildLaunch'](sessionId))).toBe(keyBefore)
    expect(rig.adapter.starts).toHaveLength(startsBefore)
  })

  it('passes the attachments after a pending note and the text (Claude joins them in the adapter)', async () => {
    const { sessionId, draftId, ids } = await setup()
    rig.service.setConfig(sessionId, { mode: 'autonomous' })
    await rig.service.sendMessage(sessionId, 'with files', { draftId, attachmentIds: ids })
    await vi.advanceTimersByTimeAsync(0)
    const sent = rig.adapter.last.sent.at(-1)!
    expect(sent.startsWith('[Arc]')).toBe(true)
    expect(sent.endsWith('\n\nwith files')).toBe(true)
    expect(rig.adapter.last.sentAttachments.at(-1)).toHaveLength(2)
  })
})

describe('sessions:send-message schema', () => {
  const schema = channelSchemas['sessions:send-message']
  const D = '01HZZZZZZZZZZZZZZZZZZZZZZZ'
  const id = (n: number): string => `01HZZZZZZZZZZZZZZZZZZZZZ${String(n).padStart(2, '0')}`
  it('accepts plain text and text with files', () => {
    expect(schema.safeParse({ sessionId: 's', text: 'hi' }).success).toBe(true)
    expect(
      schema.safeParse({ sessionId: 's', text: '', draftId: D, attachmentIds: [id(1)] }).success
    ).toBe(true)
  })
  it('rejects empty text without files, ids without a draft, duplicates and 11 ids', () => {
    expect(schema.safeParse({ sessionId: 's', text: ' ' }).success).toBe(false)
    expect(schema.safeParse({ sessionId: 's', text: 'x', attachmentIds: [id(1)] }).success).toBe(
      false
    )
    expect(
      schema.safeParse({ sessionId: 's', text: 'x', draftId: D, attachmentIds: [id(1), id(1)] })
        .success
    ).toBe(false)
    const eleven = Array.from({ length: 11 }, (_, i) => id(i))
    expect(
      schema.safeParse({ sessionId: 's', text: 'x', draftId: D, attachmentIds: eleven }).success
    ).toBe(false)
    expect(
      schema.safeParse({ sessionId: 's', text: 'x', draftId: D, attachmentIds: ['bad'] }).success
    ).toBe(false)
    expect(schema.safeParse({ sessionId: 's', text: 'x', extra: 1 }).success).toBe(false)
  })
})
