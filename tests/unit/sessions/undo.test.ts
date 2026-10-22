import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MergeQueue } from '../../../src/main/git/merge-queue'
import { UndoService } from '../../../src/main/review/undo-service'
import { AppErrorException } from '../../../src/shared/errors'
import type { ErrorCode } from '../../../src/shared/errors'
import { git } from '../../helpers/git-fixtures'
import { useTempDir } from '../helpers/temp-dir'
import { makeEngineRig, until } from './engine-rig'
import type { EngineRig } from './engine-rig'
import { branchOf, doneWorker, eventTexts, finishWorker, spawnWorker } from './merge-rig'

vi.setConfig({ testTimeout: 30000 })

const dir = useTempDir('arc-undo-')
let e: EngineRig | undefined
let sessionId = ''

afterEach(async () => {
  await e?.close()
  e = undefined
})

async function start(): Promise<EngineRig> {
  e = await makeEngineRig(dir())
  sessionId = await e.startSession('autonomous')
  return e
}

const readme = (r: EngineRig) => join(r.api.path, 'README.md')
const subject = (r: EngineRig) => git(r.api.path, 'log', '-1', '--format=%s').trim()
const reviewFiles = async (r: EngineRig) =>
  (await r.rig.service.getReview(sessionId)).repos
    .find((x) => x.projectId === 'p-api')
    ?.files.map((f) => f.path) ?? []
const markCount = (r: EngineRig) =>
  (
    r.rig.opened.sqlite.prepare('select count(*) as n from review_file_marks').get() as {
      n: number
    }
  ).n
const reviewPushes = (r: EngineRig) => r.rig.of('session:review-changed')

async function codeOf(promise: Promise<unknown>): Promise<ErrorCode | 'resolved'> {
  try {
    await promise
    return 'resolved'
  } catch (error: unknown) {
    if (error instanceof AppErrorException) return error.code
    throw error
  }
}

/** A worker commits a change to README.md in its working copy and is merged. */
async function mergeReadmeEdit(r: EngineRig): Promise<void> {
  await doneWorker(r, 'edit-readme', 'api', { 'README.md': 'hello\nfrom the worker\n' })
  await r.call(r.brain(), 'merge_worker', { workerId: 'W1' })
  await brainHasHeardTheMerge(r)
}

/** The "All workers finished" message that follows a merge goes out first, so it cannot take a later note. */
async function brainHasHeardTheMerge(r: EngineRig): Promise<void> {
  await until(() => r.brain().sent.some((m) => m.includes('All workers finished')))
}

describe('review:undo for each status', () => {
  it('puts a changed file back, adds a commit, and fast-forwards the checkout', async () => {
    const r = await start()
    await mergeReadmeEdit(r)
    expect(readFileSync(readme(r), 'utf8')).toBe('hello\nfrom the worker\n')
    const before = git(r.api.path, 'rev-list', '--count', 'HEAD').trim()

    await r.rig.service.undoFile(sessionId, 'p-api', 'README.md')

    expect(readFileSync(readme(r), 'utf8')).toBe('hello\n')
    expect(subject(r)).toBe('Undo session changes to README.md')
    expect(git(r.api.path, 'rev-list', '--count', 'HEAD').trim()).toBe(String(Number(before) + 1))
    expect(git(r.api.path, 'status', '--porcelain')).toBe('')
    expect(await reviewFiles(r)).toEqual([])
    // The temporary merge working copy is gone.
    expect(git(r.api.path, 'worktree', 'list')).not.toContain('_merge')
  })

  it('brings a deleted file back', async () => {
    const r = await start()
    const w = await spawnWorker(r, 'drop-readme', 'api')
    git(w.treePath, 'rm', 'README.md')
    git(w.treePath, 'commit', '-m', 'drop readme')
    await finishWorker(r, w)
    await r.call(r.brain(), 'merge_worker', { workerId: 'W1' })
    expect(existsSync(readme(r))).toBe(false)

    await r.rig.service.undoFile(sessionId, 'p-api', 'README.md')

    expect(readFileSync(readme(r), 'utf8')).toBe('hello\n')
    expect(await reviewFiles(r)).toEqual([])
  })

  it('deletes a file the session added', async () => {
    const r = await start()
    await doneWorker(r, 'add-files', 'api', { 'src.txt': 'new\n', 'keep.txt': 'keep\n' })
    await r.call(r.brain(), 'merge_worker', { workerId: 'W1' })
    expect(existsSync(join(r.api.path, 'src.txt'))).toBe(true)

    await r.rig.service.undoFile(sessionId, 'p-api', 'src.txt')

    expect(existsSync(join(r.api.path, 'src.txt'))).toBe(false)
    expect(readFileSync(join(r.api.path, 'keep.txt'), 'utf8')).toBe('keep\n')
    expect(subject(r)).toBe('Undo session changes to src.txt')
    expect(await reviewFiles(r)).toEqual(['keep.txt'])
  })

  it('reverses a rename: the old path returns and the new one goes', async () => {
    const r = await start()
    const w = await spawnWorker(r, 'rename-readme', 'api')
    git(w.treePath, 'mv', 'README.md', 'GUIDE.md')
    git(w.treePath, 'commit', '-m', 'rename')
    await finishWorker(r, w)
    await r.call(r.brain(), 'merge_worker', { workerId: 'W1' })
    expect(await reviewFiles(r)).toEqual(['GUIDE.md'])

    await r.rig.service.undoFile(sessionId, 'p-api', 'GUIDE.md')

    expect(readFileSync(readme(r), 'utf8')).toBe('hello\n')
    expect(existsSync(join(r.api.path, 'GUIDE.md'))).toBe(false)
    expect(subject(r)).toBe('Undo session changes to README.md -> GUIDE.md')
    expect(await reviewFiles(r)).toEqual([])
    // The push is sent once the changed-file count is read, after undoFile returns; the merge's own push may
    // still be in flight too, so wait for the one that names both paths rather than taking the latest.
    await until(() => reviewPushes(r).some((p) => p.changedPaths.join() === 'GUIDE.md,README.md'))
  })

  it('refuses a path that is not a changed session file', async () => {
    const r = await start()
    await mergeReadmeEdit(r)
    expect(await codeOf(r.rig.service.undoFile(sessionId, 'p-api', 'nope.txt'))).toBe(
      'REVIEW_FILE_NOT_FOUND'
    )
    expect(await codeOf(r.rig.service.undoPreview(sessionId, 'p-api', 'nope.txt'))).toBe(
      'REVIEW_FILE_NOT_FOUND'
    )
    expect(await codeOf(r.rig.service.undoFile(sessionId, 'p-web', 'README.md'))).toBe(
      'REVIEW_FILE_NOT_FOUND'
    )
  })
})

describe('what an undo records', () => {
  it('drops the Reviewed mark, logs the event, emits review-changed, and tells the brain once', async () => {
    const r = await start()
    await mergeReadmeEdit(r)
    await r.rig.service.setReviewed(sessionId, 'p-api', 'README.md', true)
    expect(markCount(r)).toBe(1)
    const pushesBefore = reviewPushes(r).length
    const brainSent = r.brain().sent.length

    await r.rig.service.undoFile(sessionId, 'p-api', 'README.md')

    expect(markCount(r)).toBe(0)
    const commit = git(r.api.path, 'rev-parse', 'HEAD').trim()
    const event = r.rig.eventsRepo.latest(sessionId, 50).find((x) => x.kind === 'undo')
    expect(event?.text).toBe('You undid changes to api/README.md')
    expect(JSON.parse(event?.dataJson ?? 'null')).toEqual({
      repo: 'api',
      path: 'README.md',
      commit
    })
    expect(eventTexts(r, sessionId)).toContain('You undid changes to api/README.md')

    await until(() =>
      reviewPushes(r)
        .slice(pushesBefore)
        .some((p) => p.fileCount === 0)
    )
    expect(reviewPushes(r).slice(pushesBefore).at(-1)).toMatchObject({
      sessionId,
      projectId: 'p-api',
      changedPaths: ['README.md'],
      fileCount: 0
    })

    // No turn was started for the undo itself.
    expect(r.brain().sent).toHaveLength(brainSent)
    await r.rig.service.sendMessage(sessionId, 'What now?')
    await until(() => r.brain().sent.some((m) => m.endsWith('What now?')))
    const note =
      "[Arc] The user undid the session's changes to api/README.md. Don't make that change again without asking."
    expect(r.brain().sent.find((m) => m.endsWith('What now?'))).toBe(`${note}\n\nWhat now?`)
    await r.rig.service.sendMessage(sessionId, 'And then?')
    await until(() => r.brain().sent.includes('And then?'))
    expect(r.brain().sent.at(-1)).toBe('And then?')
  })

  it('puts several undos in one note', async () => {
    const r = await start()
    await doneWorker(r, 'add-files', 'api', { 'a.txt': 'a\n', 'b.txt': 'b\n' })
    await r.call(r.brain(), 'merge_worker', { workerId: 'W1' })
    await brainHasHeardTheMerge(r)
    await r.rig.service.undoFile(sessionId, 'p-api', 'a.txt')
    await r.rig.service.undoFile(sessionId, 'p-api', 'b.txt')

    await r.rig.service.sendMessage(sessionId, 'Status?')
    await until(() => r.brain().sent.some((m) => m.endsWith('Status?')))
    const sent = r.brain().sent.find((m) => m.endsWith('Status?')) ?? ''
    expect(sent).toBe(
      "[Arc] The user undid the session's changes to these files: api/a.txt, api/b.txt. Don't make those changes again without asking.\n\nStatus?"
    )
    expect(sent.match(/\[Arc\]/g)).toHaveLength(1)
  })
})

describe('review:undo and the user checkout', () => {
  it('waits on the pending ref while the checkout has unsaved changes, and lands when it is clean', async () => {
    const r = await start()
    await doneWorker(r, 'add-files', 'api', { 'retry.txt': 'retry\n', 'other.txt': 'other\n' })
    writeFileSync(readme(r), 'hello\nunsaved\n')
    await r.call(r.brain(), 'merge_worker', { workerId: 'W1' })
    const branch = branchOf(r, sessionId)
    const pendingRef = `refs/arc/pending/${branch.replace('arc/', '')}`
    // The merge itself waits for the checkout.
    expect(existsSync(join(r.api.path, 'retry.txt'))).toBe(false)

    await r.rig.service.undoFile(sessionId, 'p-api', 'retry.txt')

    const pending = git(r.api.path, 'rev-parse', pendingRef).trim()
    expect(git(r.api.path, 'log', '-1', '--format=%s', pending).trim()).toBe(
      'Undo session changes to retry.txt'
    )
    // The unsaved edit is untouched and the branch has not moved.
    expect(readFileSync(readme(r), 'utf8')).toBe('hello\nunsaved\n')
    expect(git(r.api.path, 'rev-parse', `refs/heads/${branch}`).trim()).not.toBe(pending)
    expect(await reviewFiles(r)).toEqual(['other.txt'])

    git(r.api.path, 'checkout', 'README.md')
    await r.rig.service.open(sessionId)
    await until(() => git(r.api.path, 'rev-parse', 'HEAD').trim() === pending)
    expect(existsSync(join(r.api.path, 'retry.txt'))).toBe(false)
    expect(readFileSync(join(r.api.path, 'other.txt'), 'utf8')).toBe('other\n')
    expect(await reviewFiles(r)).toEqual(['other.txt'])
  })

  it('retries when the branch moves while it is published', async () => {
    const r = await start()
    await doneWorker(r, 'add-files', 'api', { 'a.txt': 'a\n' })
    await r.call(r.brain(), 'merge_worker', { workerId: 'W1' })
    const real = r.rig.deps.mergeGit
    let calls = 0
    const publish = vi.fn((...args: Parameters<typeof real.publish>) => {
      calls += 1
      if (calls === 1) {
        writeFileSync(join(r.api.path, 'mine.txt'), 'mine\n')
        git(r.api.path, 'add', 'mine.txt')
        git(r.api.path, 'commit', '-m', 'my own commit')
      }
      return real.publish(...args)
    })
    r.rig.deps.undoService = new UndoService({
      ...r.rig.undoDeps,
      mergeGit: { ...real, publish },
      queue: new MergeQueue()
    })

    await r.rig.service.undoFile(sessionId, 'p-api', 'a.txt')

    expect(publish).toHaveBeenCalledTimes(2)
    expect(existsSync(join(r.api.path, 'a.txt'))).toBe(false)
    expect(readFileSync(join(r.api.path, 'mine.txt'), 'utf8')).toBe('mine\n')
    expect(subject(r)).toBe('Undo session changes to a.txt')
    expect(git(r.api.path, 'log', '--format=%s', '-3').trim().split('\n')).toEqual([
      'Undo session changes to a.txt',
      'my own commit',
      'Merge W1 add-files'
    ])
  })

  it('fails with BRANCH_DIVERGED when the user committed while an update waited', async () => {
    const r = await start()
    await doneWorker(r, 'add-files', 'api', { 'a.txt': 'a\n' })
    writeFileSync(readme(r), 'hello\nunsaved\n')
    await r.call(r.brain(), 'merge_worker', { workerId: 'W1' })
    // The user commits on the branch while the merge waits on the pending ref.
    writeFileSync(join(r.api.path, 'mine.txt'), 'mine\n')
    git(r.api.path, 'add', 'mine.txt')
    git(r.api.path, 'commit', '-m', 'my own commit')

    expect(await codeOf(r.rig.service.undoFile(sessionId, 'p-api', 'a.txt'))).toBe(
      'BRANCH_DIVERGED'
    )
    expect(git(r.api.path, 'worktree', 'list')).not.toContain('_merge')
  })
})

describe('review:undo-preview', () => {
  it('lists running workers that changed the file, not resolvers or finished workers', async () => {
    const r = await start()
    await mergeReadmeEdit(r) // W1, merged
    const touch = async (name: string, content: string) => {
      const w = await spawnWorker(r, name, 'api', { 'README.md': content })
      return w
    }
    const w2 = await touch('still-working', 'hello\nw2\n')
    const w3 = await touch('resolver', 'hello\nw3\n')
    await spawnWorker(r, 'elsewhere', 'api', { 'other.txt': 'x\n' }) // W4 runs, other file
    r.rig.opened.sqlite
      .prepare('update workers set depends_on_json = ? where id = ?')
      .run('["arc:merge-resolver"]', w3.workerId)
    expect(w2.workerId).not.toBe(w3.workerId)

    expect(await r.rig.service.undoPreview(sessionId, 'p-api', 'README.md')).toEqual({
      activeWorkers: ['W2']
    })

    // A finished worker is not listed any more.
    await finishWorker(r, w2)
    expect(await r.rig.service.undoPreview(sessionId, 'p-api', 'README.md')).toEqual({
      activeWorkers: []
    })
  })

  it('matches the old path of a renamed file', async () => {
    const r = await start()
    const w1 = await spawnWorker(r, 'rename-readme', 'api')
    git(w1.treePath, 'mv', 'README.md', 'GUIDE.md')
    git(w1.treePath, 'commit', '-m', 'rename')
    await finishWorker(r, w1)
    await r.call(r.brain(), 'merge_worker', { workerId: 'W1' })
    await spawnWorker(r, 'edits-old', 'api', { 'README.md': 'hello\nagain\n' })

    expect(await r.rig.service.undoPreview(sessionId, 'p-api', 'GUIDE.md')).toEqual({
      activeWorkers: ['W2']
    })
  })
})
