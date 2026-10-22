import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDatabase } from '../../../src/main/db/client'
import type { OpenedDatabase } from '../../../src/main/db/client'
import { GroupsRepo } from '../../../src/main/db/repositories/groups-repo'
import { MessagesRepo } from '../../../src/main/db/repositories/messages-repo'
import { ReviewNotesRepo } from '../../../src/main/db/repositories/review-notes-repo'
import { SessionProjectsRepo } from '../../../src/main/db/repositories/session-projects-repo'
import { SessionsRepo } from '../../../src/main/db/repositories/sessions-repo'
import { projects } from '../../../src/main/db/schema'
import { createGit } from '../../../src/main/git/git'
import { createMergeGit } from '../../../src/main/git/merge'
import { createReviewGit } from '../../../src/main/git/review-git'
import { createSessionGit } from '../../../src/main/git/session-git'
import type { Attribution } from '../../../src/main/review/attribution'
import { NotesService } from '../../../src/main/review/notes-service'
import type { CreateNoteInput, SendMessage } from '../../../src/main/review/notes-service'
import { ReviewService } from '../../../src/main/review/review-service'
import { createGitFixture, git, gitFixtureEnv } from '../../helpers/git-fixtures'
import type { GitFixture } from '../../helpers/git-fixtures'
import { realMigrations } from '../db/helpers'
import { useTempDir } from '../helpers/temp-dir'

const noAttribution: Attribution = { attribute: async () => new Map(), version: () => '' }
const runner = createGit({ env: gitFixtureEnv })
const mergeGit = createMergeGit(runner, createSessionGit(runner))
const reviewGit = createReviewGit(runner)
const BRANCH = 'arc/work'

const dir = useTempDir()
let opened: OpenedDatabase
let fixture: GitFixture | undefined
let repoPath: string
let notesRepo: ReviewNotesRepo
let messages: MessagesRepo
let svc: NotesService

const lines = (n: number, tag = 'line'): string[] =>
  Array.from({ length: n }, (_, i) => `${tag} ${i + 1}`)

function commit(name: string, content: string[]): void {
  writeFileSync(join(repoPath, name), content.join('\n') + '\n')
  git(repoPath, 'add', '-A')
  git(repoPath, 'commit', '-m', name)
}

/** dev has src/queue.ts and src/other.ts (30 lines); arc/work changes line 3 of queue.ts. */
beforeEach(() => {
  fixture = createGitFixture()
  repoPath = fixture.path
  git(repoPath, 'config', 'core.autocrlf', 'false')
  mkdirSync(join(repoPath, 'src'))
  commit('src/queue.ts', lines(30))
  commit('src/other.ts', lines(30, 'other'))
  const base = git(repoPath, 'rev-parse', 'HEAD').trim()
  git(repoPath, 'checkout', '-b', BRANCH)
  const queue = lines(30)
  queue[2] = 'const limit = 5'
  commit('src/queue.ts', queue)

  opened = openDatabase({ dbPath: join(dir(), 'arc.db'), migrationsFolder: realMigrations })
  new GroupsRepo(opened.db).insert({
    id: 'g1',
    name: 'g',
    nameKey: 'g',
    createdAt: 1,
    updatedAt: 1
  })
  const sessions = new SessionsRepo(opened.db)
  for (const id of ['s1', 's2']) {
    sessions.create({
      id,
      groupId: 'g1',
      name: id,
      mode: 'plan_first',
      workerLimit: 3,
      status: 'active',
      createdAt: 1,
      lastActiveAt: 1
    })
  }
  opened.db
    .insert(projects)
    .values([
      { id: 'api', path: repoPath, displayName: 'api', createdAt: 1 },
      { id: 'web', path: '/nowhere/web', displayName: 'web', createdAt: 1 }
    ])
    .run()
  const spRepo = new SessionProjectsRepo(opened.db)
  spRepo.insertMany([
    {
      sessionId: 's1',
      projectId: 'api',
      readOnly: false,
      projectPath: repoPath,
      projectName: 'api',
      branchName: BRANCH,
      baseBranch: 'dev',
      baseSha: base
    },
    {
      sessionId: 's1',
      projectId: 'web',
      readOnly: false,
      projectPath: '/nowhere/web',
      projectName: 'web'
    }
  ])
  messages = new MessagesRepo(opened.db)
  notesRepo = new ReviewNotesRepo(opened.db)
  const reviewService = new ReviewService({
    sessionProjectsRepo: spRepo,
    mergeGit,
    pushGit: { chooseRemote: () => Promise.resolve(null) },
    reviewGit,
    attribution: noAttribution,
    marksRepo: { listByProject: () => [], mark: vi.fn(), unmark: vi.fn() },
    log: { warn: vi.fn() }
  })
  svc = new NotesService({
    notesRepo,
    sessionProjectsRepo: spRepo,
    reviewService,
    log: { warn: vi.fn() }
  })
})

afterEach(() => {
  opened.sqlite.close()
  fixture?.cleanup()
  fixture = undefined
})

const input = (over: Partial<CreateNoteInput> = {}): CreateNoteInput => ({
  sessionId: 's1',
  projectId: 'api',
  path: 'src/queue.ts',
  side: 'new',
  line: 3,
  lineText: 'const limit = 5',
  body: 'This retry limit should come from config.',
  ...over
})

function appendMessage(): number {
  return messages.append({
    sessionId: 's1',
    role: 'user',
    content: 'x',
    state: 'complete',
    createdAt: 1,
    updatedAt: 1
  }).id
}

describe('create', () => {
  it('stores a draft and returns the DTO', async () => {
    const note = await svc.create(input({ body: '  trim me  ' }))
    expect(note).toMatchObject({
      projectId: 'api',
      path: 'src/queue.ts',
      side: 'new',
      line: 3,
      lineText: 'const limit = 5',
      body: 'trim me',
      state: 'draft',
      stale: false
    })
    expect(note.messageId).toBeUndefined()
    expect(await svc.list('s1')).toHaveLength(1)
  })

  it('anchors on the old side and on context lines', async () => {
    await expect(svc.create(input({ side: 'old', lineText: 'line 3' }))).resolves.toMatchObject({
      side: 'old'
    })
    await expect(svc.create(input({ line: 5, lineText: 'line 5' }))).resolves.toMatchObject({
      line: 5
    })
  })

  it('refuses a path that is not a changed file and an unknown project', async () => {
    await expect(svc.create(input({ path: 'src/other.ts' }))).rejects.toMatchObject({
      code: 'REVIEW_FILE_NOT_FOUND'
    })
    await expect(svc.create(input({ projectId: 'nope' }))).rejects.toMatchObject({
      code: 'REVIEW_FILE_NOT_FOUND'
    })
  })

  it('refuses an anchor the current hunks do not have', async () => {
    await expect(svc.create(input({ line: 25, lineText: 'line 25' }))).rejects.toMatchObject({
      code: 'VALIDATION_FAILED'
    })
    await expect(svc.create(input({ lineText: 'const limit = 6' }))).rejects.toMatchObject({
      code: 'VALIDATION_FAILED'
    })
    // The old side has the old text at line 3, not the new one.
    await expect(svc.create(input({ side: 'old' }))).rejects.toMatchObject({
      code: 'VALIDATION_FAILED'
    })
  })

  it('refuses an empty or over-long body', async () => {
    await expect(svc.create(input({ body: '   ' }))).rejects.toMatchObject({
      code: 'VALIDATION_FAILED'
    })
    await expect(svc.create(input({ body: 'x'.repeat(4001) }))).rejects.toMatchObject({
      code: 'VALIDATION_FAILED'
    })
    await expect(svc.create(input({ body: 'x'.repeat(4000) }))).resolves.toBeTruthy()
  })

  it('refuses the 51st draft', async () => {
    const [api] = opened.sqlite.prepare('select id from session_projects order by id').all() as {
      id: number
    }[]
    for (let i = 0; i < 50; i++) {
      notesRepo.create({
        id: `draft-${i}`,
        sessionProjectId: api!.id,
        path: 'src/queue.ts',
        side: 'new',
        line: 3,
        lineText: 'const limit = 5',
        body: `note ${i}`,
        createdAt: 1,
        updatedAt: 1
      })
    }
    await expect(svc.create(input({ body: 'one more' }))).rejects.toMatchObject({
      code: 'TOO_MANY_NOTES'
    })
  })

  it('truncates a long line text to 500 characters', async () => {
    const long = 'y'.repeat(700)
    const q = lines(30)
    q[2] = long
    commit('src/queue.ts', q)
    const note = await svc.create(input({ lineText: long }))
    expect(note.lineText).toBe('y'.repeat(500))
    expect((await svc.list('s1'))[0]?.stale).toBe(false)
  })
})

describe('update and delete', () => {
  it('edits and deletes a draft', async () => {
    const note = await svc.create(input())
    await expect(svc.update(note.id, ' better ')).resolves.toMatchObject({ body: 'better' })
    await expect(svc.update(note.id, '')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    svc.delete(note.id)
    expect(await svc.list('s1')).toEqual([])
  })

  it('answers NOTE_NOT_FOUND for a missing note', async () => {
    await expect(svc.update('nope', 'x')).rejects.toMatchObject({ code: 'NOTE_NOT_FOUND' })
    expect(() => svc.delete('nope')).toThrow(expect.objectContaining({ code: 'NOTE_NOT_FOUND' }))
  })

  it('answers NOT_DRAFT after the note was sent', async () => {
    const note = await svc.create(input())
    await svc.send('s1', async () => ({ messageId: appendMessage() }))
    await expect(svc.update(note.id, 'late')).rejects.toMatchObject({ code: 'NOT_DRAFT' })
    expect(() => svc.delete(note.id)).toThrow(expect.objectContaining({ code: 'NOT_DRAFT' }))
    expect((await svc.list('s1'))[0]).toMatchObject({ body: input().body, state: 'sent' })
  })
})

describe('send', () => {
  it('posts one message in repo, path, side, line order with indented bodies', async () => {
    // Insert straight into the repo so the notes need no matching diff; the "web" repo sorts after "api".
    const [api, web] = opened.sqlite
      .prepare('select id from session_projects order by id')
      .all() as { id: number }[]
    const add = (spId: number, path: string, side: 'old' | 'new', line: number, body: string) =>
      notesRepo.create({
        id: `${spId}-${path}-${side}-${line}`,
        sessionProjectId: spId,
        path,
        side,
        line,
        lineText: `text ${line}`,
        body,
        createdAt: 1,
        updatedAt: 1
      })
    add(web!.id, 'a.ts', 'new', 1, 'web note')
    add(api!.id, 'src/queue.ts', 'new', 42, 'This retry limit should come from config.')
    add(api!.id, 'src/queue.ts', 'old', 42, 'first line\nsecond line')
    add(api!.id, 'src/queue.ts', 'new', 7, 'earlier line')
    add(api!.id, 'src/a.ts', 'new', 99, 'other file')
    const send = vi.fn<SendMessage>(async () => ({ messageId: appendMessage() }))
    const result = await svc.send('s1', send)
    expect(result.count).toBe(5)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]).toEqual([
      's1',
      [
        'Review notes (5):',
        '1. api · src/a.ts · line 99 (new)',
        '   > text 99',
        '   other file',
        '2. api · src/queue.ts · line 42 (old)',
        '   > text 42',
        '   first line',
        '   second line',
        '3. api · src/queue.ts · line 7 (new)',
        '   > text 7',
        '   earlier line',
        '4. api · src/queue.ts · line 42 (new)',
        '   > text 42',
        '   This retry limit should come from config.',
        '5. web · a.ts · line 1 (new)',
        '   > text 1',
        '   web note'
      ].join('\n')
    ])
  })

  it('marks every draft sent with the message id and returns it', async () => {
    const a = await svc.create(input())
    const b = await svc.create(input({ side: 'old', lineText: 'line 3', body: 'second' }))
    const messageId = appendMessage()
    await expect(svc.send('s1', async () => ({ messageId }))).resolves.toEqual({
      messageId,
      count: 2
    })
    const listed = await svc.list('s1')
    expect(listed.map((n) => [n.id, n.state, n.messageId])).toEqual([
      [a.id, 'sent', messageId],
      [b.id, 'sent', messageId]
    ])
    await expect(svc.send('s1', async () => ({ messageId }))).rejects.toMatchObject({
      code: 'VALIDATION_FAILED'
    })
  })

  it('answers VALIDATION_FAILED without drafts and never sends', async () => {
    const send = vi.fn()
    await expect(svc.send('s1', send)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    expect(send).not.toHaveBeenCalled()
  })

  it('leaves the drafts when the message cannot be sent', async () => {
    await svc.create(input())
    await expect(svc.send('s1', () => Promise.reject(new Error('cli down')))).rejects.toThrow(
      'cli down'
    )
    expect((await svc.list('s1'))[0]?.state).toBe('draft')
  })
})

describe('stale detection', () => {
  it('is stale after a merge changes the anchored line', async () => {
    await svc.create(input())
    expect((await svc.list('s1'))[0]?.stale).toBe(false)
    const q = lines(30)
    q[2] = 'const limit = getLimit()'
    commit('src/queue.ts', q)
    expect((await svc.list('s1'))[0]?.stale).toBe(true)
  })

  it('is not stale after an unrelated change', async () => {
    await svc.create(input())
    const other = lines(30, 'other')
    other[20] = 'changed'
    commit('src/other.ts', other)
    const q = lines(30)
    q[2] = 'const limit = 5'
    q[25] = 'far away change'
    commit('src/queue.ts', q)
    expect((await svc.list('s1'))[0]?.stale).toBe(false)
  })

  it('is stale when the file leaves the changed files', async () => {
    await svc.create(input())
    commit('src/queue.ts', lines(30))
    expect((await svc.list('s1'))[0]?.stale).toBe(true)
  })

  it('applies to sent notes too', async () => {
    await svc.create(input())
    await svc.send('s1', async () => ({ messageId: appendMessage() }))
    const q = lines(30)
    q[2] = 'moved'
    commit('src/queue.ts', q)
    expect((await svc.list('s1'))[0]).toMatchObject({ state: 'sent', stale: true })
  })
})
