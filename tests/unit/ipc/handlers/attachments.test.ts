import { beforeEach, describe, expect, it, vi } from 'vitest'
import { channelSchemas } from '../../../../src/shared/ipc/contract'
import { call, type Captured } from './capture'
import type { AppServices } from '../../../../src/main/app/app-services'

const captured = vi.hoisted<Captured>(() => new Map())
vi.mock('../../../../src/main/ipc/register', async () => {
  const { registerMock } = await import('./capture')
  return registerMock(captured)
})

const DRAFT = '01HZZZZZZZZZZZZZZZZZZZZZZZ'

async function register(attachments: unknown): Promise<void> {
  const { registerAttachmentHandlers } =
    await import('../../../../src/main/ipc/handlers/attachments')
  registerAttachmentHandlers({ attachments } as unknown as AppServices)
}

describe('attachments handlers', () => {
  beforeEach(() => captured.clear())

  it('forwards each channel to the service', async () => {
    const result = { attachments: [], refused: [] }
    const svc = {
      newDraft: vi.fn(() => ({ draftId: DRAFT })),
      stagePaths: vi.fn(async () => result),
      stageBytes: vi.fn(async () => result),
      pick: vi.fn(async () => result),
      remove: vi.fn(async () => undefined),
      discardDraft: vi.fn(async () => undefined)
    }
    await register(svc)
    expect(await call(captured, 'attachments:new-draft')).toEqual({ draftId: DRAFT })
    expect(await call(captured, 'attachments:stage-paths', { draftId: DRAFT, paths: ['/a'] })).toBe(
      result
    )
    expect(svc.stagePaths).toHaveBeenCalledWith(DRAFT, ['/a'])
    const bytes = new Uint8Array([1, 2, 3])
    expect(
      await call(captured, 'attachments:stage-bytes', { draftId: DRAFT, bytes, mime: 'image/png' })
    ).toBe(result)
    expect(svc.stageBytes).toHaveBeenCalledWith(DRAFT, bytes)
    expect(await call(captured, 'attachments:pick', { draftId: DRAFT })).toBe(result)
    await call(captured, 'attachments:remove', { draftId: DRAFT, id: DRAFT })
    expect(svc.remove).toHaveBeenCalledWith(DRAFT, DRAFT)
    await call(captured, 'attachments:discard-draft', { draftId: DRAFT })
    expect(svc.discardDraft).toHaveBeenCalledWith(DRAFT)
  })

  it('has strict schemas', () => {
    const stage = channelSchemas['attachments:stage-paths']
    expect(stage.safeParse({ draftId: DRAFT, paths: ['/a'] }).success).toBe(true)
    expect(stage.safeParse({ draftId: DRAFT, paths: [] }).success).toBe(false)
    expect(stage.safeParse({ draftId: DRAFT, paths: Array(101).fill('/a') }).success).toBe(false)
    expect(stage.safeParse({ draftId: 'not-a-ulid', paths: ['/a'] }).success).toBe(false)
    expect(stage.safeParse({ draftId: DRAFT, paths: ['/a'], extra: 1 }).success).toBe(false)
    const bytesSchema = channelSchemas['attachments:stage-bytes']
    const ok = { draftId: DRAFT, bytes: new Uint8Array(1), mime: 'image/png' }
    expect(bytesSchema.safeParse(ok).success).toBe(true)
    expect(bytesSchema.safeParse({ ...ok, bytes: Buffer.from([1]) }).success).toBe(true)
    expect(bytesSchema.safeParse({ ...ok, bytes: [1, 2] }).success).toBe(false)
    expect(bytesSchema.safeParse({ ...ok, bytes: 'abc' }).success).toBe(false)
    expect(bytesSchema.safeParse({ ...ok, extra: 1 }).success).toBe(false)
    expect(bytesSchema.safeParse({ ...ok, draftId: '../x' }).success).toBe(false)
    expect(channelSchemas['attachments:pick'].safeParse({ draftId: '../x' }).success).toBe(false)
    expect(channelSchemas['attachments:new-draft'].safeParse({ x: 1 }).success).toBe(false)
  })
})
