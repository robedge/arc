import { afterEach, describe, expect, it } from 'vitest'
import { channelSchemas } from '../../../src/shared/ipc/contract'
import type { ReviewSnapshot } from '../../../src/shared/types/review'
import type { SessionSnapshot } from '../../../src/shared/types/session'
import { useTempDir } from '../helpers/temp-dir'
import { makeRig } from './helpers'
import type { Rig } from './helpers'

const dir = useTempDir('arc-review-count-')
let rig: Rig | undefined

afterEach(async () => {
  await rig?.service.shutdown()
  rig?.close()
  rig = undefined
})

const snapshot: ReviewSnapshot = { sessionId: 'S1', repos: [], workers: [], notes: [] }

async function openSession(
  changedFileCount: () => Promise<number>
): Promise<{ r: Rig; opened: SessionSnapshot; sessionId: string }> {
  const r = await makeRig(dir(), {
    reviewService: {
      changedFileCount,
      getReview: () => Promise.resolve(snapshot),
      getFile: () => Promise.resolve({ kind: 'text', hunks: [] }),
      setReviewed: () => Promise.resolve()
    }
  })
  rig = r
  const created = await r.service.create(r.groupId, 'Fix it', 'plan_first', 3)
  if (!('sessionId' in created)) throw new Error('expected a session id')
  const opened = await r.service.open(created.sessionId)
  if ('needsDirtyChoice' in opened) throw new Error('expected a snapshot')
  return { r, opened, sessionId: created.sessionId }
}

describe('review:get contract', () => {
  it('requires a sessionId and rejects extra keys', () => {
    const schema = channelSchemas['review:get']
    expect(schema.safeParse({ sessionId: 'a' }).success).toBe(true)
    expect(schema.safeParse({ sessionId: 'a', extra: 1 }).success).toBe(false)
    expect(schema.safeParse({}).success).toBe(false)
  })
})

describe('SessionService review', () => {
  it('puts the changed-file count in the opened snapshot', async () => {
    const { opened } = await openSession(() => Promise.resolve(7))
    expect(opened.changedFileCount).toBe(7)
  })

  it('opens with 0 and logs when the count fails', async () => {
    const { r, opened } = await openSession(() => Promise.reject(new Error('git down')))
    expect(opened.changedFileCount).toBe(0)
    expect(r.deps.log.warn).toHaveBeenCalled()
  })

  it('returns the review snapshot for a known session and SESSION_NOT_FOUND otherwise', async () => {
    const { r, sessionId } = await openSession(() => Promise.resolve(0))
    await expect(r.service.getReview(sessionId)).resolves.toEqual(snapshot)
    expect(() => r.service.getReview('nope')).toThrow(
      expect.objectContaining({ code: 'SESSION_NOT_FOUND' })
    )
  })
})
