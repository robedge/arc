import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { eventNames } from '../../../src/shared/ipc/contract'
import { git } from '../../helpers/git-fixtures'
import { useTempDir } from '../helpers/temp-dir'
import { makeEngineRig, until } from './engine-rig'
import type { EngineRig } from './engine-rig'
import { doneWorker } from './merge-rig'

vi.setConfig({ testTimeout: 30000 })

const dir = useTempDir('arc-review-changed-')
let e: EngineRig | undefined

afterEach(async () => {
  await e?.close()
  e = undefined
})

async function start(overrides: Parameters<typeof makeEngineRig>[1] = {}): Promise<string> {
  e = await makeEngineRig(dir(), overrides)
  return e.startSession('autonomous')
}

const reviewPushes = (r: EngineRig) => r.rig.of('session:review-changed')

describe('session:review-changed', () => {
  it('is a registered push event', () => {
    expect(eventNames).toContain('session:review-changed')
  })

  it('is pushed after a merge is recorded, with repo-relative paths and the session file count', async () => {
    const sessionId = await start()
    if (!e) throw new Error('rig')
    await doneWorker(e, 'api-retry', 'api', { 'retry.txt': 'retry\n', 'two.txt': '2\n' })
    e.rig.pushed.length = 0

    await e.call(e.brain(), 'merge_worker', { workerId: 'W1' })
    const rig = e
    await until(() => reviewPushes(rig).length === 1)
    const [push] = reviewPushes(e)
    expect(push).toMatchObject({
      sessionId,
      projectId: 'p-api',
      changedPaths: ['retry.txt', 'two.txt'],
      fileCount: 2
    })
    expect(push?.seq).toBeGreaterThan(0)

    // The next merge counts the files across both merges and its seq is higher.
    await doneWorker(e, 'api-more', 'api', { 'three.txt': '3\n' })
    await e.call(e.brain(), 'merge_worker', { workerId: 'W2' })
    await until(() => reviewPushes(rig).length === 2)
    const second = reviewPushes(e)[1]
    expect(second).toMatchObject({ changedPaths: ['three.txt'], fileCount: 3 })
    expect(second?.seq).toBeGreaterThan(push?.seq ?? 0)
  })

  it('is pushed when a waiting merge lands', async () => {
    const sessionId = await start()
    if (!e) throw new Error('rig')
    await doneWorker(e, 'api-retry', 'api', { 'retry.txt': 'retry\n' })
    writeFileSync(join(e.api.path, 'README.md'), 'hello\nunsaved\n')
    await e.call(e.brain(), 'merge_worker', { workerId: 'W1' })
    const rig = e
    // The merge itself reviews the pending tip, so it is already pushed once.
    await until(() => reviewPushes(rig).length === 1)
    expect(reviewPushes(e)[0]).toMatchObject({ changedPaths: ['retry.txt'], fileCount: 1 })

    git(e.api.path, 'checkout', 'README.md')
    await e.rig.service.open(sessionId)
    await until(() => reviewPushes(rig).length === 2)
    expect(reviewPushes(e)[1]).toMatchObject({
      sessionId,
      projectId: 'p-api',
      changedPaths: [],
      fileCount: 1
    })
  })

  it('is not pushed, and the merge still succeeds, when counting the files fails', async () => {
    await start({
      reviewService: {
        changedFileCount: () => Promise.reject(new Error('git down')),
        getReview: () => Promise.resolve({ sessionId: 's', repos: [], workers: [] }),
        getFile: () => Promise.reject(new Error('unused')),
        setReviewed: () => Promise.resolve()
      }
    })
    if (!e) throw new Error('rig')
    await doneWorker(e, 'api-retry', 'api', { 'retry.txt': 'retry\n' })
    const result = await e.call(e.brain(), 'merge_worker', { workerId: 'W1' })
    expect(result).toMatchObject({ isError: false, value: { merged: true } })
    const warn = vi.mocked(e.rig.deps.log.warn)
    await until(() => warn.mock.calls.length > 0)
    expect(reviewPushes(e)).toHaveLength(0)
    expect(warn).toHaveBeenCalledWith('could not count the changed files', expect.any(Error))
  })
})
