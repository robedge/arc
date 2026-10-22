import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createGit } from '../../../src/main/git/git'
import { createSessionGit, parsePorcelainZ, slugify } from '../../../src/main/git/session-git'
import type { SessionGitProject } from '../../../src/main/git/session-git'
import {
  createGitFixture,
  git,
  gitFixtureEnv,
  trackedFile,
  untrackedFile
} from '../../helpers/git-fixtures'
import type { GitFixture, GitFixtureKind } from '../../helpers/git-fixtures'

const sessionGit = createSessionGit(createGit({ env: gitFixtureEnv }))

const fixtures: GitFixture[] = []
const extraDirs: string[] = []
afterEach(() => {
  while (fixtures.length) fixtures.pop()?.cleanup()
  while (extraDirs.length) rmSync(extraDirs.pop() as string, { recursive: true, force: true })
})

function fixture(kind: GitFixtureKind): GitFixture {
  const fx = createGitFixture({ kind })
  fixtures.push(fx)
  return fx
}

function project(id: string, fx: GitFixture, isGit = true): SessionGitProject {
  return { projectId: id, name: id, path: fx.path, isGit }
}

const branchOf = (repo: string): string => git(repo, 'symbolic-ref', '--short', 'HEAD').trim()

describe('detectBaseBranch', () => {
  it('prefers local dev', async () => {
    expect(await sessionGit.detectBaseBranch(fixture('clean').path)).toBe('dev')
  })

  it('falls back to main when there is no dev', async () => {
    expect(await sessionGit.detectBaseBranch(fixture('no-dev').path)).toBe('main')
  })

  it('falls back to master when only master exists', async () => {
    const fx = fixture('no-dev')
    git(fx.path, 'branch', '-m', 'master')
    expect(await sessionGit.detectBaseBranch(fx.path)).toBe('master')
  })

  it('uses origin/HEAD (stripped) before init.defaultBranch and main', async () => {
    const origin = fixture('no-dev')
    git(origin.path, 'branch', '-m', 'trunk')
    const dir = mkdtempSync(join(tmpdir(), 'arc-git-clone-'))
    extraDirs.push(dir)
    const clone = join(dir, 'clone')
    git(dir, 'clone', origin.path, clone)
    expect(await sessionGit.detectBaseBranch(clone)).toBe('trunk')
  })

  it('uses init.defaultBranch when it exists locally', async () => {
    const fx = fixture('no-dev')
    git(fx.path, 'branch', 'develop')
    git(fx.path, 'config', 'init.defaultBranch', 'develop')
    expect(await sessionGit.detectBaseBranch(fx.path)).toBe('develop')
  })

  it('falls back to the current HEAD when nothing else matches', async () => {
    const fx = fixture('no-dev')
    git(fx.path, 'branch', '-m', 'feature-x')
    expect(await sessionGit.detectBaseBranch(fx.path)).toBe('feature-x')
  })
})

describe('slugify and uniqueBranch', () => {
  it('makes kebab-case ASCII of at most 40 characters', () => {
    expect(slugify('Fix order sync')).toBe('fix-order-sync')
    expect(slugify('  Café -- Déjà vu!  ')).toBe('cafe-deja-vu')
    const long = slugify('a'.repeat(30) + ' ' + 'b'.repeat(30))
    expect(long.length).toBeLessThanOrEqual(40)
    expect(long.endsWith('-')).toBe(false)
  })

  it('falls back to session-<shortid> when nothing survives', () => {
    expect(slugify('!!!', 'abc123')).toBe('session-abc123')
    expect(slugify('日本語', 'abc123')).toBe('session-abc123')
    expect(slugify('')).toMatch(/^session-[0-9a-f]{6}$/)
  })

  it('adds -2, -3 when arc/<slug> exists in any repo', async () => {
    const a = fixture('clean')
    const b = fixture('clean')
    expect(await sessionGit.uniqueBranch([a.path, b.path], 'fix')).toBe('arc/fix')
    git(b.path, 'branch', 'arc/fix')
    expect(await sessionGit.uniqueBranch([a.path, b.path], 'fix')).toBe('arc/fix-2')
    git(a.path, 'branch', 'arc/fix-2')
    expect(await sessionGit.uniqueBranch([a.path, b.path], 'fix')).toBe('arc/fix-3')
  })
})

describe('checkDirty', () => {
  it('is clean for a clean repo', async () => {
    expect(await sessionGit.checkDirty(fixture('clean').path)).toEqual({ dirty: false, files: [] })
  })

  it('reports modified and untracked files', async () => {
    const status = await sessionGit.checkDirty(fixture('dirty').path)
    expect(status.dirty).toBe(true)
    expect(status.files.sort()).toEqual([trackedFile, untrackedFile].sort())
  })

  it('counts an untracked file alone as dirty', async () => {
    const fx = fixture('clean')
    writeFileSync(join(fx.path, 'only-untracked.txt'), 'x')
    expect((await sessionGit.checkDirty(fx.path)).files).toEqual(['only-untracked.txt'])
  })

  it('reads the new path of a rename and skips the source', () => {
    expect(parsePorcelainZ('R  new.txt\0old.txt\0?? other.txt\0')).toEqual(['new.txt', 'other.txt'])
  })
})

describe('planSessionStart / applySessionStart', () => {
  const opts = (choices: Record<string, 'stash' | 'commit' | 'carry' | 'cancel'> = {}) => ({
    sessionName: 'Fix order sync',
    slug: 'fix-order-sync',
    choices
  })

  it('lists dirty git repos and ignores non-git projects', async () => {
    const dirty = fixture('dirty')
    const plain = fixture('plain')
    const plan = await sessionGit.planSessionStart([
      project('api', fixture('clean')),
      project('web', dirty),
      project('notes', plain, false)
    ])
    expect(plan.dirtyRepos.map((d) => d.projectId)).toEqual(['web'])
    expect(plan.dirtyRepos[0]?.files.length).toBe(2)
  })

  it('branches clean repos off their base and marks non-git projects read-only', async () => {
    const api = fixture('clean')
    const web = fixture('no-dev')
    const plain = fixture('plain')
    const plan = await sessionGit.planSessionStart([
      project('api', api),
      project('web', web),
      project('notes', plain, false)
    ])
    const outcome = await sessionGit.applySessionStart(plan, opts())
    expect(outcome.status).toBe('started')
    if (outcome.status !== 'started') return
    expect(outcome.results).toEqual([
      {
        projectId: 'api',
        branchName: 'arc/fix-order-sync',
        baseBranch: 'dev',
        previousBranch: 'dev',
        baseSha: git(api.path, 'rev-parse', 'refs/heads/dev').trim(),
        readOnly: false,
        dirtyHandling: 'none',
        stashRef: null
      },
      {
        projectId: 'web',
        branchName: 'arc/fix-order-sync',
        baseBranch: 'main',
        previousBranch: 'main',
        baseSha: git(web.path, 'rev-parse', 'refs/heads/main').trim(),
        readOnly: false,
        dirtyHandling: 'none',
        stashRef: null
      },
      {
        projectId: 'notes',
        branchName: null,
        baseBranch: null,
        previousBranch: null,
        baseSha: null,
        readOnly: true,
        dirtyHandling: 'none',
        stashRef: null
      }
    ])
    expect(branchOf(api.path)).toBe('arc/fix-order-sync')
    expect(branchOf(web.path)).toBe('arc/fix-order-sync')
    expect(existsSync(join(plain.path, '.git'))).toBe(false)
  })

  it('stash: stashes with the session message, records the ref, leaves the tree clean', async () => {
    const fx = fixture('dirty')
    const plan = await sessionGit.planSessionStart([project('api', fx)])
    const outcome = await sessionGit.applySessionStart(plan, opts({ api: 'stash' }))
    expect(outcome.status).toBe('started')
    if (outcome.status !== 'started') return
    const result = outcome.results[0]
    expect(result?.dirtyHandling).toBe('stashed')
    expect(result?.stashRef).toBe(git(fx.path, 'rev-parse', 'stash@{0}').trim())
    expect(git(fx.path, 'stash', 'list')).toContain('arc:Fix order sync')
    expect(branchOf(fx.path)).toBe('arc/fix-order-sync')
    expect((await sessionGit.checkDirty(fx.path)).dirty).toBe(false)
    expect(existsSync(join(fx.path, untrackedFile))).toBe(false)
  })

  it('commit: adds a WIP commit on the previous branch, then branches', async () => {
    const fx = fixture('dirty')
    const plan = await sessionGit.planSessionStart([project('api', fx)])
    const outcome = await sessionGit.applySessionStart(plan, opts({ api: 'commit' }))
    expect(outcome.status).toBe('started')
    if (outcome.status !== 'started') return
    expect(outcome.results[0]?.dirtyHandling).toBe('committed')
    expect(branchOf(fx.path)).toBe('arc/fix-order-sync')
    expect(git(fx.path, 'log', '-1', '--format=%s', 'dev').trim()).toBe(
      'WIP before Arc session Fix order sync'
    )
    expect(git(fx.path, 'show', 'dev:' + untrackedFile)).toBe('new\n')
    expect((await sessionGit.checkDirty(fx.path)).dirty).toBe(false)
  })

  it('carry: keeps the changes in the tree on the session branch', async () => {
    const fx = fixture('dirty')
    const plan = await sessionGit.planSessionStart([project('api', fx)])
    const outcome = await sessionGit.applySessionStart(plan, opts({ api: 'carry' }))
    expect(outcome.status).toBe('started')
    if (outcome.status !== 'started') return
    expect(outcome.results[0]?.dirtyHandling).toBe('carried')
    expect(branchOf(fx.path)).toBe('arc/fix-order-sync')
    expect(readFileSync(join(fx.path, trackedFile), 'utf8')).toBe('hello\nchanged\n')
    expect(existsSync(join(fx.path, untrackedFile))).toBe(true)
  })

  it('carry failure: reports CarryFailed for the repo and rolls back the others', async () => {
    const ok = fixture('clean')
    const bad = fixture('dirty')
    // Base is `main`-like branch whose README differs from the dirty tree, so carrying conflicts.
    git(bad.path, 'stash', '-u')
    git(bad.path, 'checkout', '-b', 'feature')
    writeFileSync(join(bad.path, trackedFile), 'feature version\n')
    git(bad.path, 'commit', '-am', 'feature change')
    git(bad.path, 'checkout', 'dev')
    git(bad.path, 'stash', 'pop')
    git(bad.path, 'branch', '-m', 'dev', 'old-dev')
    git(bad.path, 'branch', 'main', 'feature')
    const plan = await sessionGit.planSessionStart([project('ok', ok), project('bad', bad)])
    const outcome = await sessionGit.applySessionStart(plan, opts({ bad: 'carry' }))
    expect(outcome.status).toBe('aborted')
    if (outcome.status !== 'aborted') return
    expect(outcome.reason).toBe('carry-failed')
    expect(outcome.carryFailed.map((c) => c.projectId)).toEqual(['bad'])
    expect(outcome.rolledBack).toEqual(['ok'])
    expect(branchOf(ok.path)).toBe('dev')
    expect(branchOf(bad.path)).toBe('old-dev')
    expect(readFileSync(join(bad.path, trackedFile), 'utf8')).toBe('hello\nchanged\n')
  })

  it('cancel: rolls back repos already switched, changes intact, no stray branch', async () => {
    const clean = fixture('clean')
    const carried = fixture('dirty')
    const cancelled = fixture('dirty')
    const plan = await sessionGit.planSessionStart([
      project('clean', clean),
      project('carried', carried),
      project('cancelled', cancelled)
    ])
    const outcome = await sessionGit.applySessionStart(
      plan,
      opts({ carried: 'carry', cancelled: 'cancel' })
    )
    expect(outcome.status).toBe('aborted')
    if (outcome.status !== 'aborted') return
    expect(outcome.reason).toBe('cancelled')
    expect(outcome.rolledBack.sort()).toEqual(['carried', 'clean'])
    for (const fx of [clean, carried, cancelled]) {
      expect(branchOf(fx.path)).toBe('dev')
      expect(git(fx.path, 'branch', '--list', 'arc/*').trim()).toBe('')
    }
    for (const fx of [carried, cancelled]) {
      expect(readFileSync(join(fx.path, trackedFile), 'utf8')).toBe('hello\nchanged\n')
      expect(existsSync(join(fx.path, untrackedFile))).toBe(true)
    }
    expect(git(cancelled.path, 'stash', 'list').trim()).toBe('')
  })

  it('a dirty repo with no choice is treated as cancel', async () => {
    const fx = fixture('dirty')
    const plan = await sessionGit.planSessionStart([project('api', fx)])
    const outcome = await sessionGit.applySessionStart(plan, opts())
    expect(outcome.status === 'aborted' && outcome.reason).toBe('cancelled')
    expect(branchOf(fx.path)).toBe('dev')
  })

  it('suffixes the branch when any repo already has arc/<slug>', async () => {
    const a = fixture('clean')
    const b = fixture('clean')
    git(b.path, 'branch', 'arc/fix-order-sync')
    const plan = await sessionGit.planSessionStart([project('a', a), project('b', b)])
    const outcome = await sessionGit.applySessionStart(plan, opts())
    expect(outcome.status === 'started' && outcome.branchName).toBe('arc/fix-order-sync-2')
    expect(branchOf(a.path)).toBe('arc/fix-order-sync-2')
  })
})

describe('checkoutSessionBranch', () => {
  it('returns the dirty files first, then switches once a choice is given', async () => {
    const fx = fixture('dirty')
    git(fx.path, 'branch', 'arc/reopen')
    const first = await sessionGit.checkoutSessionBranch(fx.path, 'arc/reopen')
    expect(first.status).toBe('dirty')
    expect(branchOf(fx.path)).toBe('dev')

    const cancelled = await sessionGit.checkoutSessionBranch(fx.path, 'arc/reopen', 'cancel')
    expect(cancelled.status).toBe('cancelled')
    expect(branchOf(fx.path)).toBe('dev')

    const done = await sessionGit.checkoutSessionBranch(fx.path, 'arc/reopen', 'stash')
    expect(done.status).toBe('switched')
    expect(branchOf(fx.path)).toBe('arc/reopen')
    expect(git(fx.path, 'stash', 'list')).toContain('arc:reopen')
  })

  it('switches a clean repo directly', async () => {
    const fx = fixture('clean')
    git(fx.path, 'branch', 'arc/reopen')
    const out = await sessionGit.checkoutSessionBranch(fx.path, 'arc/reopen')
    expect(out).toMatchObject({ status: 'switched', previousBranch: 'dev', dirtyHandling: 'none' })
  })
})

// Guard: the fixture helper's env really isolates from the user's git config.
describe('fixture isolation', () => {
  it('ignores global git config', () => {
    const fx = fixture('clean')
    const out = execFileSync('git', ['-C', fx.path, 'config', '--global', '--list'], {
      env: gitFixtureEnv,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
    expect(out).toBe('')
  })
})
