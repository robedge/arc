import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppErrorException } from '../../../src/shared/errors'
import type { AppError } from '../../../src/shared/errors'
import { eventNames, channelSchemas } from '../../../src/shared/ipc/contract'
import { createRemoteFixture, git } from '../../helpers/git-fixtures'
import type { RemoteFixture } from '../../helpers/git-fixtures'
import { useTempDir } from '../helpers/temp-dir'
import { makeEngineRig, until } from '../sessions/engine-rig'
import type { EngineRig } from '../sessions/engine-rig'
import { branchOf, doneWorker, eventTexts } from '../sessions/merge-rig'

vi.setConfig({ testTimeout: 30000 })

const dir = useTempDir('arc-push-')
let e: EngineRig | undefined
let remote: RemoteFixture | undefined
let sessionId = ''

afterEach(async () => {
  await e?.close()
  e = undefined
  remote?.cleanup()
  remote = undefined
})

/** A session whose `api` repository has `origin` pointing at a temporary bare remote (or no remote). */
async function start(withRemote = true): Promise<EngineRig> {
  e = await makeEngineRig(dir())
  if (withRemote) {
    remote = createRemoteFixture()
    git(e.api.path, 'remote', 'add', 'origin', remote.remote)
  }
  sessionId = await e.startSession('autonomous')
  return e
}

async function errorOf(promise: Promise<unknown>): Promise<AppError | 'resolved'> {
  try {
    await promise
    return 'resolved'
  } catch (error: unknown) {
    if (error instanceof AppErrorException) {
      return error.details ? { code: error.code, details: error.details } : { code: error.code }
    }
    throw error
  }
}

async function mergeFile(r: EngineRig, name: string, workerId: string): Promise<void> {
  await doneWorker(r, name, 'api', { [`${name}.txt`]: `${name}\n` })
  await r.call(r.brain(), 'merge_worker', { workerId })
}

/**
 * The merge announces its change to the review a moment after `merge_worker` returns (the file count is read
 * first). Wait for that event before clearing, or under load it lands after the clear and is mistaken for one
 * the push made.
 */
async function forgetMergeEvents(r: EngineRig): Promise<void> {
  await until(() => r.rig.of('session:review-changed').length >= 1)
  r.rig.pushed.length = 0
}

const apiRepo = async (r: EngineRig) =>
  (await r.rig.service.getReview(sessionId)).repos.find((x) => x.projectId === 'p-api')
const pushedRow = (r: EngineRig) =>
  r.rig.opened.sqlite
    .prepare(
      'select pushed_remote as remote, pushed_branch as branch, pushed_sha as sha, pushed_at as at from session_projects where project_id = ?'
    )
    .get('p-api') as {
    remote: string | null
    branch: string | null
    sha: string | null
    at: number | null
  }

describe('review:push contract', () => {
  it('requires confirm: true and is a renderer channel with a preview', () => {
    const push = channelSchemas['review:push']
    expect(push.safeParse({ sessionId: 's', projectId: 'p', confirm: true }).success).toBe(true)
    expect(push.safeParse({ sessionId: 's', projectId: 'p', confirm: false }).success).toBe(false)
    expect(push.safeParse({ sessionId: 's', projectId: 'p' }).success).toBe(false)
    expect(
      channelSchemas['review:push-preview'].safeParse({ sessionId: 's', projectId: 'p' }).success
    ).toBe(true)
    expect(eventNames).toContain('session:review-changed')
  })
})

describe('review:push', () => {
  it('previews the exact command, pushes only on confirm, records it, logs it and refreshes the review', async () => {
    const r = await start()
    await mergeFile(r, 'one', 'W1')
    const branch = branchOf(r, sessionId)
    expect(branch).toMatch(/^arc\//)
    expect(await apiRepo(r).then((x) => x?.push)).toEqual({ state: 'never' })

    const preview = await r.rig.service.pushPreview(sessionId, 'p-api')
    expect(preview).toEqual({ command: `git push -u origin ${branch}`, remote: 'origin' })
    // Previewing sends nothing.
    expect(git(remote!.remote, 'branch', '--list', branch).trim()).toBe('')
    expect(pushedRow(r).at).toBeNull()

    await forgetMergeEvents(r)
    const result = await r.rig.service.pushBranch(sessionId, 'p-api')
    const tip = git(r.api.path, 'rev-parse', branch).trim()
    expect(result).toMatchObject({ remote: 'origin', sha: tip })
    expect(result.pushedAt).toBeGreaterThan(0)
    expect(git(remote!.remote, 'rev-parse', `refs/heads/${branch}`).trim()).toBe(tip)
    expect(pushedRow(r)).toEqual({ remote: 'origin', branch, sha: tip, at: result.pushedAt })
    expect(eventTexts(r, sessionId)).toContain(`Pushed ${branch} to origin`)
    const rig = r
    await until(() => rig.rig.of('session:review-changed').length === 1)
    expect(r.rig.of('session:review-changed')[0]).toMatchObject({
      sessionId,
      projectId: 'p-api',
      changedPaths: []
    })
    expect(await apiRepo(r).then((x) => x?.push)).toEqual({
      state: 'pushed',
      remote: 'origin',
      at: result.pushedAt,
      newerCommits: 0
    })
  })

  it('counts commits made after the push (a later merge)', async () => {
    const r = await start()
    await mergeFile(r, 'one', 'W1')
    const branch = branchOf(r, sessionId)
    const pushed = await r.rig.service.pushBranch(sessionId, 'p-api')
    await mergeFile(r, 'two', 'W2')
    const expected = Number(
      git(r.api.path, 'rev-list', '--count', `${pushed.sha}..${branch}`).trim()
    )
    expect(expected).toBeGreaterThan(0)
    expect(await apiRepo(r).then((x) => x?.push)).toMatchObject({
      state: 'pushed',
      newerCommits: expected
    })
  })

  it('returns PUSH_FAILED with git stderr for a non-fast-forward and records nothing', async () => {
    const r = await start()
    await mergeFile(r, 'one', 'W1')
    const branch = branchOf(r, sessionId)
    // The remote already has this branch name on a different history.
    const other = dir() + '/other'
    git(dir(), 'clone', '-q', remote!.remote, other)
    git(other, 'checkout', '-q', '-b', branch)
    writeFileSync(join(other, 'theirs.txt'), 'theirs\n')
    git(other, 'add', '-A')
    git(other, 'commit', '-q', '-m', 'theirs')
    git(other, 'push', '-q', 'origin', branch)

    await forgetMergeEvents(r)
    const error = await errorOf(r.rig.service.pushBranch(sessionId, 'p-api'))
    expect(error).not.toBe('resolved')
    const failure = error as AppError
    expect(failure.code).toBe('PUSH_FAILED')
    const reason = failure.details?.reason ?? ''
    expect(reason).toMatch(/\[rejected\]/)
    expect(reason).toMatch(/fetch first|non-fast-forward/)
    expect(reason).toBe(reason.trim())
    expect(pushedRow(r)).toEqual({ remote: null, branch: null, sha: null, at: null })
    expect(eventTexts(r, sessionId).some((t) => t.startsWith('Pushed '))).toBe(false)
    expect(r.rig.of('session:review-changed')).toHaveLength(0)
    expect(await apiRepo(r).then((x) => x?.push)).toEqual({ state: 'never' })
  })

  it('errors NO_REMOTE when the repository has no remote', async () => {
    const r = await start(false)
    await mergeFile(r, 'one', 'W1')
    expect(await errorOf(r.rig.service.pushPreview(sessionId, 'p-api'))).toEqual({
      code: 'NO_REMOTE'
    })
    expect(await errorOf(r.rig.service.pushBranch(sessionId, 'p-api'))).toEqual({
      code: 'NO_REMOTE'
    })
    expect(await apiRepo(r).then((x) => x?.push)).toEqual({ state: 'no-remote' })
  })

  it('errors WAITING_FOR_CHECKOUT while a merge waits for the checkout, and pushes nothing', async () => {
    const r = await start()
    await doneWorker(r, 'one', 'api', { 'one.txt': 'one\n' })
    writeFileSync(join(r.api.path, 'README.md'), 'hello\nunsaved\n')
    await r.call(r.brain(), 'merge_worker', { workerId: 'W1' })
    const branch = branchOf(r, sessionId)
    expect(await errorOf(r.rig.service.pushPreview(sessionId, 'p-api'))).toEqual({
      code: 'WAITING_FOR_CHECKOUT'
    })
    expect(await errorOf(r.rig.service.pushBranch(sessionId, 'p-api'))).toEqual({
      code: 'WAITING_FOR_CHECKOUT'
    })
    expect(git(remote!.remote, 'branch', '--list', branch).trim()).toBe('')
    expect(await apiRepo(r).then((x) => x?.push)).toEqual({ state: 'waiting' })
  })

  it('errors SESSION_NOT_FOUND for an unknown project', async () => {
    const r = await start()
    expect(await errorOf(r.rig.service.pushPreview(sessionId, 'p-missing'))).toEqual({
      code: 'SESSION_NOT_FOUND'
    })
  })
})
