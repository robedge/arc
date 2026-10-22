import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDatabase } from '../../../src/main/db/client'
import type { OpenedDatabase } from '../../../src/main/db/client'
import { CommitsRepo } from '../../../src/main/db/repositories/commits-repo'
import { GroupsRepo } from '../../../src/main/db/repositories/groups-repo'
import { MergesRepo } from '../../../src/main/db/repositories/merges-repo'
import { SessionsRepo } from '../../../src/main/db/repositories/sessions-repo'
import type { SessionProjectRow } from '../../../src/main/db/repositories/session-projects-repo'
import { WorkersRepo } from '../../../src/main/db/repositories/workers-repo'
import { createGit } from '../../../src/main/git/git'
import { createMergeGit } from '../../../src/main/git/merge'
import { createReviewGit } from '../../../src/main/git/review-git'
import { createSessionGit } from '../../../src/main/git/session-git'
import {
  createAttribution,
  parseCommitPaths,
  sortLabels,
  workersOfFile
} from '../../../src/main/review/attribution'
import { ReviewService } from '../../../src/main/review/review-service'
import { createGitFixture, git, gitFixtureEnv } from '../../helpers/git-fixtures'
import type { GitFixture } from '../../helpers/git-fixtures'
import { realMigrations } from '../db/helpers'
import { useTempDir } from '../helpers/temp-dir'

const dir = useTempDir()
const runner = createGit({ env: gitFixtureEnv })
const BRANCH = 'arc/work'

let opened: OpenedDatabase
let fixture: GitFixture | undefined
let repo: string
let base: string
let workersRepo: WorkersRepo
let commitsRepo: CommitsRepo
let mergesRepo: MergesRepo
let nextId = 0

beforeEach(() => {
  opened = openDatabase({ dbPath: join(dir(), 'arc.db'), migrationsFolder: realMigrations })
  new GroupsRepo(opened.db).insert({
    id: 'g1',
    name: 'g',
    nameKey: 'g',
    createdAt: 1,
    updatedAt: 1
  })
  new SessionsRepo(opened.db).create({
    id: 's1',
    groupId: 'g1',
    name: 's1',
    mode: 'plan_first',
    workerLimit: 3,
    status: 'active',
    createdAt: 1,
    lastActiveAt: 1
  })
  workersRepo = new WorkersRepo(opened.db)
  commitsRepo = new CommitsRepo(opened.db)
  mergesRepo = new MergesRepo(opened.db)

  fixture = createGitFixture()
  repo = fixture.path
  writeFileSync(join(repo, 'old.txt'), 'one\ntwo\nthree\nfour\nfive\nsix\n')
  writeFileSync(join(repo, 'shared.txt'), 'base\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-m', 'Seed')
  base = rev('HEAD')
  git(repo, 'checkout', '-b', BRANCH)
})

afterEach(() => {
  opened.sqlite.close()
  fixture?.cleanup()
  fixture = undefined
})

function rev(ref: string): string {
  return git(repo, 'rev-parse', ref).trim()
}

function addWorker(number: number, resolver = false): string {
  const id = `w${number}`
  workersRepo.insert({
    id,
    sessionId: 's1',
    number,
    slug: `task-${number}`,
    task: 'do it',
    projectIdsJson: '[]',
    model: 'sonnet',
    status: 'merged',
    dependsOnJson: resolver ? '["arc:merge-resolver"]' : '[]',
    createdAt: 1,
    updatedAt: 1
  })
  return id
}

function commit(files: Record<string, string>, message: string): string {
  for (const [name, content] of Object.entries(files)) writeFileSync(join(repo, name), content)
  git(repo, 'add', '-A')
  git(repo, 'commit', '-m', message)
  return rev('HEAD')
}

/** Commits on a side branch off the session branch's base, then returns to the session branch. */
function workOnSide(name: string, files: Record<string, string>, record: string | null): string {
  git(repo, 'checkout', '-b', name, base)
  const sha = commit(files, `${name} work`)
  if (record !== null) {
    commitsRepo.add({ workerId: record, projectId: null, sha, subject: name, committedAt: 1 })
  }
  git(repo, 'checkout', BRANCH)
  return sha
}

function mergeSide(name: string, workerId: string | null, conflictFiles: string[] = []): string {
  git(repo, 'merge', '--no-ff', '-m', `Merge ${name}`, name)
  const sha = rev('HEAD')
  if (workerId !== null) {
    mergesRepo.record({
      id: `m${nextId++}`,
      sessionId: 's1',
      workerId,
      projectId: null,
      result: conflictFiles.length > 0 ? 'resolved' : 'clean',
      filesJson: '[]',
      conflictFilesJson: conflictFiles.length > 0 ? JSON.stringify(conflictFiles) : null,
      mergeSha: sha,
      notes: null,
      mergedAt: 1
    })
  }
  return sha
}

function attribution() {
  return createAttribution({ git: runner, workersRepo, commitsRepo, mergesRepo })
}

async function attribute(): Promise<ReadonlyMap<string, readonly string[]>> {
  return attribution().attribute({ sessionId: 's1', repo, base, tip: rev('HEAD') })
}

describe('rule 1: worker commits', () => {
  it('attributes the files of a recorded worker commit to that worker', async () => {
    const w1 = addWorker(1)
    workOnSide('side-1', { 'a.txt': 'a\n' }, w1)
    mergeSide('side-1', w1)
    const result = await attribute()
    expect(result.get('a.txt')).toEqual(['W1'])
  })

  it('keeps the first worker for a commit recorded by two (one worker received it from another)', async () => {
    const w1 = addWorker(1)
    const w3 = addWorker(3)
    const sha = workOnSide('side-1', { 'a.txt': 'a\n' }, w1)
    // W3 was given W1's commit and recorded it too; the later row must not take it over.
    commitsRepo.add({ workerId: w3, projectId: null, sha, subject: 'shared', committedAt: 2 })
    mergeSide('side-1', w1)
    expect((await attribute()).get('a.txt')).toEqual(['W1'])
  })

  it('drops a commit recorded by a resolver worker, so it falls through to the user', async () => {
    const resolver = addWorker(2, true)
    workOnSide('side-r', { 'r.txt': 'r\n' }, resolver)
    mergeSide('side-r', null)
    expect((await attribute()).get('r.txt')).toEqual(['You'])
  })
})

describe('rule 2: rewritten commits', () => {
  it('attributes a commit that is not in worker_commits to the worker whose merge brought it in', async () => {
    const w2 = addWorker(2)
    const original = workOnSide('side-2', { 'b.txt': 'b\n' }, w2)
    // The worker's branch is rewritten before the merge: the recorded sha is no longer in history.
    git(repo, 'checkout', 'side-2')
    git(repo, 'commit', '--amend', '-m', 'rewritten', '--no-verify')
    git(repo, 'checkout', BRANCH)
    expect(rev('side-2')).not.toBe(original)
    mergeSide('side-2', w2)
    expect((await attribute()).get('b.txt')).toEqual(['W2'])
  })

  it('leaves the same rewritten commit to the user when no merge row exists', async () => {
    const w2 = addWorker(2)
    workOnSide('side-2', { 'b.txt': 'b\n' }, w2)
    git(repo, 'checkout', 'side-2')
    git(repo, 'commit', '--amend', '-m', 'rewritten', '--no-verify')
    git(repo, 'checkout', BRANCH)
    mergeSide('side-2', null)
    expect((await attribute()).get('b.txt')).toEqual(['You'])
  })
})

describe('rule 3: conflict-resolved files', () => {
  it('attributes a file changed only inside the merge commit to the merged worker', async () => {
    const w3 = addWorker(3)
    workOnSide('side-3', { 'c.txt': 'c\n' }, w3)
    git(repo, 'merge', '--no-ff', '--no-commit', 'side-3')
    writeFileSync(join(repo, 'shared.txt'), 'resolved by hand\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-m', 'Merge side-3')
    mergesRepo.record({
      id: 'mc',
      sessionId: 's1',
      workerId: w3,
      projectId: null,
      result: 'resolved',
      filesJson: '["api/c.txt","api/shared.txt"]',
      // Repository-relative, unlike files_json.
      conflictFilesJson: '["shared.txt"]',
      mergeSha: rev('HEAD'),
      notes: null,
      mergedAt: 1
    })
    const result = await attribute()
    expect(result.get('shared.txt')).toEqual(['W3'])
    expect(result.get('c.txt')).toEqual(['W3'])
  })
})

describe('rule 4: everything else is You', () => {
  it('attributes the user own commit to You', async () => {
    commit({ 'mine.txt': 'mine\n' }, 'By hand')
    expect((await attribute()).get('mine.txt')).toEqual(['You'])
  })
})

describe('rule 5: union and order', () => {
  it('unites a rename over its old and new paths', async () => {
    const w1 = addWorker(1)
    const w2 = addWorker(2)
    workOnSide('side-1', { 'old.txt': 'one\ntwo!\nthree\nfour\nfive\nsix\n' }, w1)
    mergeSide('side-1', w1)
    git(repo, 'checkout', '-b', 'side-2', base)
    git(repo, 'mv', 'old.txt', 'new.txt')
    git(repo, 'commit', '-m', 'rename')
    commitsRepo.add({
      workerId: w2,
      projectId: null,
      sha: rev('HEAD'),
      subject: 'rename',
      committedAt: 2
    })
    git(repo, 'checkout', BRANCH)
    // Resolve the modify/rename by hand in the merge (not asserted on here).
    git(repo, 'merge', '--no-ff', '-m', 'Merge side-2', 'side-2')

    const result = await attribute()
    expect(result.get('new.txt')).toEqual(['W2'])
    expect(workersOfFile(result, 'new.txt', 'old.txt')).toEqual(['W1', 'W2'])
    expect(workersOfFile(result, 'new.txt')).toEqual(['W2'])
  })

  it('orders by worker number with You last', async () => {
    const w3 = addWorker(3)
    const w10 = addWorker(10)
    const w1 = addWorker(1)
    commit({ 'shared.txt': 'user\n' }, 'user edit')
    for (const [name, id, line] of [
      ['side-3', w3, 'three'],
      ['side-10', w10, 'ten'],
      ['side-1', w1, 'one']
    ] as const) {
      git(repo, 'checkout', '-b', name, base)
      const sha = commit({ [`${name}.txt`]: `${line}\n` }, name)
      commitsRepo.add({ workerId: id, projectId: null, sha, subject: name, committedAt: 1 })
      git(repo, 'checkout', BRANCH)
      mergeSide(name, id)
    }
    expect(sortLabels(['You', 'W10', 'W3', 'W1', 'W3'])).toEqual(['W1', 'W3', 'W10', 'You'])
    const result = await attribute()
    const all = ['side-3.txt', 'side-10.txt', 'side-1.txt', 'shared.txt'].flatMap((p) => [
      ...(result.get(p) ?? [])
    ])
    expect(sortLabels(all)).toEqual(['W1', 'W3', 'W10', 'You'])
    expect(workersOfFile(result, 'side-10.txt', 'shared.txt')).toEqual(['W10', 'You'])
  })

  it('treats a path no commit touched as the user', () => {
    expect(workersOfFile(new Map(), 'x.txt')).toEqual(['You'])
  })
})

describe('parseCommitPaths', () => {
  it('reads sha and paths from the NUL-separated log', () => {
    const out = '\x01aaa\0\nx.txt\0y/z.txt\0\x01bbb\0\n\x01ccc\0\nq.txt\0'
    expect(parseCommitPaths(out)).toEqual([
      { sha: 'aaa', paths: ['x.txt', 'y/z.txt'] },
      { sha: 'bbb', paths: [] },
      { sha: 'ccc', paths: ['q.txt'] }
    ])
  })
})

describe('review snapshot', () => {
  it('puts workers on every file and the labels present on the snapshot', async () => {
    const w1 = addWorker(1)
    workOnSide('side-1', { 'a.txt': 'a\n' }, w1)
    mergeSide('side-1', w1)
    commit({ 'mine.txt': 'mine\n' }, 'By hand')
    const rows: SessionProjectRow[] = [
      {
        id: 1,
        sessionId: 's1',
        projectId: 'api',
        branchName: BRANCH,
        baseBranch: 'dev',
        previousBranch: 'dev',
        readOnly: false,
        dirtyHandling: 'none',
        stashRef: null,
        baseSha: base,
        pushedRemote: null,
        pushedBranch: null,
        pushedSha: null,
        pushedAt: null,
        projectPath: repo,
        projectName: 'api',
        membership: 'active'
      }
    ]
    const svc = new ReviewService({
      sessionProjectsRepo: { listBySession: () => rows, setBaseSha: vi.fn(() => true) },
      mergeGit: createMergeGit(runner, createSessionGit(runner)),
      pushGit: { chooseRemote: () => Promise.resolve(null) },
      reviewGit: createReviewGit(runner),
      attribution: attribution(),
      marksRepo: { listByProject: () => [], mark: vi.fn(), unmark: vi.fn() },
      log: { warn: vi.fn() }
    })
    const snapshot = await svc.getReview('s1')
    const byPath = Object.fromEntries((snapshot.repos[0]?.files ?? []).map((f) => [f.path, f]))
    expect(byPath['a.txt']?.workers).toEqual(['W1'])
    expect(byPath['mine.txt']?.workers).toEqual(['You'])
    expect(snapshot.workers).toEqual(['W1', 'You'])
  })
})
