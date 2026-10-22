import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionProjectRow } from '../../../src/main/db/repositories/session-projects-repo'
import { createGit } from '../../../src/main/git/git'
import { createMergeGit } from '../../../src/main/git/merge'
import { createReviewGit, parseUnifiedDiff } from '../../../src/main/git/review-git'
import { createSessionGit } from '../../../src/main/git/session-git'
import type { Attribution } from '../../../src/main/review/attribution'
import { ReviewService } from '../../../src/main/review/review-service'
import { channelSchemas } from '../../../src/shared/ipc/contract'
import { createGitFixture, git, gitFixtureEnv } from '../../helpers/git-fixtures'
import type { GitFixture } from '../../helpers/git-fixtures'

const noAttribution: Attribution = { attribute: async () => new Map(), version: () => '' }
const runner = createGit({ env: gitFixtureEnv })
const mergeGit = createMergeGit(runner, createSessionGit(runner))
const reviewGit = createReviewGit(runner)
const BRANCH = 'arc/work'

let fixture: GitFixture | undefined
afterEach(() => {
  fixture?.cleanup()
  fixture = undefined
})

function commitFile(repo: string, name: string, content: string | Buffer): void {
  writeFileSync(join(repo, name), content)
  git(repo, 'add', '-A')
  git(repo, 'commit', '-m', name)
}

/** A repo with the seed files on dev, then `arc/work` checked out; returns a service over it. */
function session(files: Record<string, string | Buffer> = {}) {
  fixture = createGitFixture()
  const repo = fixture.path
  for (const [name, content] of Object.entries(files)) writeFileSync(join(repo, name), content)
  git(repo, 'add', '-A')
  git(repo, 'commit', '--allow-empty', '-m', 'Seed')
  const base = git(repo, 'rev-parse', 'HEAD').trim()
  git(repo, 'checkout', '-b', BRANCH)
  const row: SessionProjectRow = {
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
  const svc = new ReviewService({
    sessionProjectsRepo: { listBySession: () => [row], setBaseSha: vi.fn(() => true) },
    mergeGit,
    pushGit: { chooseRemote: () => Promise.resolve(null) },
    reviewGit,
    attribution: noAttribution,
    marksRepo: { listByProject: () => [], mark: vi.fn(), unmark: vi.fn() },
    log: { warn: vi.fn() }
  })
  return { repo, svc }
}

const numbered = (n: number, tag = 'line'): string =>
  Array.from({ length: n }, (_, i) => `${tag} ${i + 1}`).join('\n') + '\n'

describe('parseUnifiedDiff', () => {
  it('numbers both sides across several hunks', () => {
    const text = [
      'diff --git a/f.txt b/f.txt',
      'index 111..222 100644',
      '--- a/f.txt',
      '+++ b/f.txt',
      '@@ -2,4 +2,4 @@ section one',
      ' two',
      '-three',
      '+THREE',
      ' four',
      ' five',
      '@@ -20,3 +20,4 @@',
      ' twenty',
      '+new',
      ' twenty-one',
      ' twenty-two',
      ''
    ].join('\n')
    const hunks = parseUnifiedDiff(text)
    expect(hunks).toHaveLength(2)
    expect(hunks[0]).toMatchObject({
      oldStart: 2,
      oldLines: 4,
      newStart: 2,
      newLines: 4,
      header: '@@ -2,4 +2,4 @@ section one'
    })
    expect(hunks[0]?.lines).toEqual([
      { kind: 'ctx', oldNo: 2, newNo: 2, text: 'two' },
      { kind: 'del', oldNo: 3, text: 'three' },
      { kind: 'add', newNo: 3, text: 'THREE' },
      { kind: 'ctx', oldNo: 4, newNo: 4, text: 'four' },
      { kind: 'ctx', oldNo: 5, newNo: 5, text: 'five' }
    ])
    expect(hunks[1]?.lines.map((l) => [l.kind, l.oldNo, l.newNo])).toEqual([
      ['ctx', 20, 20],
      ['add', undefined, 21],
      ['ctx', 21, 22],
      ['ctx', 22, 23]
    ])
  })

  it('defaults a missing count to 1 and flags a line without a trailing newline', () => {
    const hunks = parseUnifiedDiff(
      ['@@ -1 +1 @@', '-old', '\\ No newline at end of file', '+new', ''].join('\n')
    )
    expect(hunks[0]).toMatchObject({ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 })
    expect(hunks[0]?.lines).toEqual([
      { kind: 'del', oldNo: 1, text: 'old', noNewline: true },
      { kind: 'add', newNo: 1, text: 'new' }
    ])
  })

  it('keeps a CR in the text, and treats a body line that starts with @@ as content', () => {
    const hunks = parseUnifiedDiff(
      ['@@ -1,2 +1,2 @@', '-a\r', '+b\r', ' +@@ -1 +1 @@', ''].join('\n')
    )
    expect(hunks).toHaveLength(1)
    expect(hunks[0]?.lines.map((l) => l.text)).toEqual(['a\r', 'b\r', '+@@ -1 +1 @@'])
  })

  it('gives no hunks for a pure rename or a mode-only change', () => {
    const rename =
      'diff --git a/a.txt b/b.txt\nsimilarity index 100%\nrename from a.txt\nrename to b.txt\n'
    const mode = 'diff --git a/x.sh b/x.sh\nold mode 100644\nnew mode 100755\n'
    expect(parseUnifiedDiff(rename)).toEqual([])
    expect(parseUnifiedDiff(mode)).toEqual([])
    expect(parseUnifiedDiff('')).toEqual([])
  })
})

describe('ReviewService.getFile', () => {
  it('returns hunks from git for a modified file, with line numbers and no-newline', async () => {
    const { repo, svc } = session({ 'a.txt': numbered(10) })
    commitFile(repo, 'a.txt', numbered(10).replace('line 5', 'LINE 5'))
    const diff = await svc.getFile('s1', 'api', 'a.txt', false)
    expect(diff.kind).toBe('text')
    if (diff.kind !== 'text') return
    expect(diff.hunks).toHaveLength(1)
    const lines = diff.hunks[0]?.lines ?? []
    expect(lines.find((l) => l.kind === 'del')).toMatchObject({ oldNo: 5, text: 'line 5' })
    expect(lines.find((l) => l.kind === 'add')).toMatchObject({ newNo: 5, text: 'LINE 5' })
    expect(lines.filter((l) => l.kind === 'ctx')).toHaveLength(6)
    expect(lines.some((l) => l.noNewline === true)).toBe(false)
  })

  it('marks a last line without a newline', async () => {
    const { repo, svc } = session({ 'a.txt': 'one\ntwo\n' })
    commitFile(repo, 'a.txt', 'one\ntwo')
    const diff = await svc.getFile('s1', 'api', 'a.txt', false)
    expect(diff).toMatchObject({ kind: 'text' })
    const lines = diff.kind === 'text' ? (diff.hunks[0]?.lines ?? []) : []
    expect(lines.filter((l) => l.noNewline === true).map((l) => [l.kind, l.text])).toEqual([
      ['add', 'two']
    ])
  })

  it('shows an added file and keeps CRLF', async () => {
    const { repo, svc } = session()
    commitFile(repo, 'crlf.txt', 'a\r\nb\r\n')
    const diff = await svc.getFile('s1', 'api', 'crlf.txt', false)
    expect(diff).toEqual({
      kind: 'text',
      hunks: [
        {
          oldStart: 0,
          oldLines: 0,
          newStart: 1,
          newLines: 2,
          header: '@@ -0,0 +1,2 @@',
          lines: [
            { kind: 'add', newNo: 1, text: 'a\r' },
            { kind: 'add', newNo: 2, text: 'b\r' }
          ]
        }
      ]
    })
  })

  it('gives no hunks for an empty added file', async () => {
    const { repo, svc } = session()
    commitFile(repo, 'empty.txt', '')
    expect(await svc.getFile('s1', 'api', 'empty.txt', false)).toEqual({ kind: 'text', hunks: [] })
  })

  it('shows a rename with edits against the old path', async () => {
    const { repo, svc } = session({ 'old.txt': numbered(20) })
    git(repo, 'mv', 'old.txt', 'new.txt')
    commitFile(repo, 'new.txt', numbered(20).replace('line 10', 'LINE 10'))
    const diff = await svc.getFile('s1', 'api', 'new.txt', false)
    expect(diff.kind).toBe('text')
    const lines = diff.kind === 'text' ? (diff.hunks[0]?.lines ?? []) : []
    expect(lines.filter((l) => l.kind !== 'ctx').map((l) => [l.kind, l.text])).toEqual([
      ['del', 'line 10'],
      ['add', 'LINE 10']
    ])
  })

  it('gives empty hunks for a pure rename', async () => {
    const { repo, svc } = session({ 'old.txt': numbered(20) })
    git(repo, 'mv', 'old.txt', 'new.txt')
    git(repo, 'commit', '-m', 'rename')
    expect(await svc.getFile('s1', 'api', 'new.txt', false)).toEqual({ kind: 'text', hunks: [] })
  })

  it('gives empty hunks for a mode-only change', async () => {
    const { repo, svc } = session({ 'x.sh': 'echo hi\n' })
    git(repo, 'update-index', '--chmod=+x', 'x.sh')
    git(repo, 'commit', '-m', 'chmod')
    expect(await svc.getFile('s1', 'api', 'x.sh', false)).toEqual({ kind: 'text', hunks: [] })
  })

  it('answers binary without text', async () => {
    const { repo, svc } = session()
    commitFile(repo, 'logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 0, 255]))
    expect(await svc.getFile('s1', 'api', 'logo.png', true)).toEqual({ kind: 'binary' })
  })

  it('holds a file over 2,000 lines back until showAnyway', async () => {
    const { repo, svc } = session()
    commitFile(repo, 'big.txt', numbered(2001))
    expect(await svc.getFile('s1', 'api', 'big.txt', false)).toEqual({
      kind: 'large',
      changedLines: 2001
    })
    const shown = await svc.getFile('s1', 'api', 'big.txt', true)
    expect(shown.kind).toBe('text')
    expect(shown.kind === 'text' ? shown.hunks[0]?.lines : []).toHaveLength(2001)
  })

  it('shows exactly 2,000 lines without the gate', async () => {
    const { repo, svc } = session()
    commitFile(repo, 'edge.txt', numbered(2000))
    expect((await svc.getFile('s1', 'api', 'edge.txt', false)).kind).toBe('text')
  })

  it('never shows a file over 50,000 lines, even with showAnyway', async () => {
    const { repo, svc } = session()
    commitFile(repo, 'huge.txt', numbered(50_001))
    const expected = { kind: 'tooLarge', changedLines: 50_001 }
    expect(await svc.getFile('s1', 'api', 'huge.txt', false)).toEqual(expected)
    expect(await svc.getFile('s1', 'api', 'huge.txt', true)).toEqual(expected)
  })

  it('refuses a path that did not change, or a project that is not in the session', async () => {
    const { repo, svc } = session({ 'a.txt': 'x\n' })
    commitFile(repo, 'b.txt', 'y\n')
    await expect(svc.getFile('s1', 'api', 'a.txt', false)).rejects.toMatchObject({
      code: 'REVIEW_FILE_NOT_FOUND'
    })
    await expect(svc.getFile('s1', 'api', 'nope.txt', false)).rejects.toMatchObject({
      code: 'REVIEW_FILE_NOT_FOUND'
    })
    await expect(svc.getFile('s1', 'other', 'b.txt', false)).rejects.toMatchObject({
      code: 'REVIEW_FILE_NOT_FOUND'
    })
  })
})

describe('review:file contract', () => {
  it('needs session, project and path; showAnyway is optional; extra keys are rejected', () => {
    const schema = channelSchemas['review:file']
    expect(schema.safeParse({ sessionId: 's', projectId: 'p', path: 'a.ts' }).success).toBe(true)
    expect(
      schema.safeParse({ sessionId: 's', projectId: 'p', path: 'a.ts', showAnyway: true }).success
    ).toBe(true)
    expect(schema.safeParse({ sessionId: 's', projectId: 'p' }).success).toBe(false)
    expect(schema.safeParse({ sessionId: 's', projectId: 'p', path: '' }).success).toBe(false)
    expect(schema.safeParse({ sessionId: 's', projectId: 'p', path: 'a', extra: 1 }).success).toBe(
      false
    )
  })
})
