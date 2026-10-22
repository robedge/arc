import { randomBytes } from 'node:crypto'
import { GitError, LONG_GIT_TIMEOUT_MS } from './git'
import type { GitRunner } from './git'

/**
 * Session-branch git workflow (tech spec 2.7, functional spec 2.2).
 *
 * How the dirty-tree flow is surfaced to the session service (tech spec 2.9):
 *  1. Once the brain has named the session, the service calls `slugify(name)` then
 *     `sessionGit.planSessionStart(projects)`. The plan lists the dirty repos and the git/non-git split.
 *  2. If `plan.dirtyRepos` is non-empty and the caller has no choices yet, the service stores the plan
 *     under a token and returns `{needsDirtyChoice: {token, repos}}`. `sessions:resolve-dirty` fetches the
 *     plan by token and continues with step 3.
 *  3. `sessionGit.applySessionStart(plan, {sessionName, slug, choices})` creates the branches, or aborts
 *     and rolls back. On a `carry-failed` abort, the service re-plans (`planSessionStart` again, since
 *     rollback may have stashed or committed other repos) and offers the other choices for that repo.
 * Reopen uses `checkoutSessionBranch(repo, branch, choice?)`, which returns `{status: 'dirty'}` first.
 */

export type DirtyChoice = 'stash' | 'commit' | 'carry' | 'cancel'
export type DirtyHandling = 'none' | 'stashed' | 'committed' | 'carried'

export interface SessionGitProject {
  projectId: string
  name: string
  path: string
  isGit: boolean
}

export interface DirtyStatus {
  dirty: boolean
  /** Paths from `status --porcelain=v1 -z`, untracked included. */
  files: string[]
}

export interface DirtyRepoInfo {
  projectId: string
  name: string
  path: string
  files: string[]
}

export interface SessionStartPlan {
  projects: SessionGitProject[]
  dirtyRepos: DirtyRepoInfo[]
}

export interface SessionBranchResult {
  projectId: string
  /** `arc/<slug>`, or null for a read-only (non-git) project. */
  branchName: string | null
  baseBranch: string | null
  previousBranch: string | null
  /** The commit the session branch started at (review's fixed base); null for a read-only project. */
  baseSha: string | null
  readOnly: boolean
  dirtyHandling: DirtyHandling
  /** Commit sha of the stash entry (`stash@{0}` right after the push), when the user chose Set aside. */
  stashRef: string | null
}

export interface ApplySessionStartOptions {
  sessionName: string
  /** Output of `slugify`. The final branch is `uniqueBranch(repos, slug)`, computed inside. */
  slug: string
  /** Use exactly this branch (a project joining an open session); it must not exist in the repos yet. */
  branchName?: string
  /** Missing entry for a dirty repo counts as 'cancel'. Clean repos need no entry. */
  choices: Readonly<Record<string, DirtyChoice | undefined>>
}

export interface CarryFailure {
  projectId: string
  message: string
}

export type SessionStartOutcome =
  | { status: 'started'; branchName: string; results: SessionBranchResult[] }
  | {
      status: 'aborted'
      reason: 'cancelled' | 'carry-failed' | 'git-failed'
      message: string
      /** Set when `reason` is 'carry-failed': repos whose carry did not work (CarryFailed). */
      carryFailed: CarryFailure[]
      /** Repos switched to `arc/<slug>` and then returned to their previous branch. */
      rolledBack: string[]
      rollbackFailures: CarryFailure[]
      /** Stashes made before the abort. They are NOT dropped; the user's changes live there. */
      keptStashes: { projectId: string; stashRef: string }[]
      /** WIP commits made on a previous branch before the abort (kept). */
      keptCommits: string[]
    }

export type CheckoutOutcome =
  | { status: 'dirty'; files: string[] }
  | {
      status: 'switched'
      previousBranch: string
      dirtyHandling: DirtyHandling
      stashRef: string | null
    }
  | { status: 'cancelled' }
  | { status: 'carry-failed'; message: string }

const MAX_SLUG_LENGTH = 40
export const SESSION_BRANCH_PREFIX = 'arc/'

function randomShortId(): string {
  return randomBytes(3).toString('hex')
}

/** Kebab-case ASCII, at most 40 characters. Falls back to `session-<shortid>`. */
export function slugify(name: string, shortId: string = randomShortId()): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/, '')
  return slug.length > 0 ? slug : `session-${shortId}`
}

/** Parses `status --porcelain=v1 -z` output into the changed paths (rename sources are skipped). */
export function parsePorcelainZ(output: string): string[] {
  const entries = output.split('\0').filter((e) => e.length > 0)
  const files: string[] = []
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] as string
    files.push(entry.slice(3))
    const x = entry[0]
    const y = entry[1]
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') i++
  }
  return files
}

export interface SessionGit {
  detectBaseBranch(repo: string): Promise<string>
  /** Returns the full branch name (`arc/<slug>`, with `-2`, `-3` if taken in any of the repos). */
  uniqueBranch(repos: readonly string[], slug: string): Promise<string>
  checkDirty(repo: string): Promise<DirtyStatus>
  /** Current branch name, or the commit sha when HEAD is detached. */
  currentBranch(repo: string): Promise<string>
  planSessionStart(projects: readonly SessionGitProject[]): Promise<SessionStartPlan>
  applySessionStart(
    plan: SessionStartPlan,
    options: ApplySessionStartOptions
  ): Promise<SessionStartOutcome>
  checkoutSessionBranch(
    repo: string,
    branch: string,
    choice?: DirtyChoice
  ): Promise<CheckoutOutcome>
}

export function createSessionGit(git: GitRunner): SessionGit {
  async function tryGit(repo: string, args: string[]): Promise<string | null> {
    try {
      return (await git(repo, args)).trim()
    } catch (error: unknown) {
      if (error instanceof GitError && error.kind === 'failed') return null
      throw error
    }
  }

  async function branchExists(repo: string, branch: string): Promise<boolean> {
    return (
      (await tryGit(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])) !== null
    )
  }

  async function detectBaseBranch(repo: string): Promise<string> {
    if (await branchExists(repo, 'dev')) return 'dev'

    const originHead = await tryGit(repo, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
    if (originHead) {
      const stripped = originHead.replace(/^origin\//, '')
      if (stripped && (await branchExists(repo, stripped))) return stripped
    }

    const configured = await tryGit(repo, ['config', '--get', 'init.defaultBranch'])
    if (configured && (await branchExists(repo, configured))) return configured

    for (const candidate of ['main', 'master']) {
      if (await branchExists(repo, candidate)) return candidate
    }
    return currentRef(repo)
  }

  /** Current branch name, or the commit sha when HEAD is detached. */
  async function currentRef(repo: string): Promise<string> {
    const branch = await tryGit(repo, ['symbolic-ref', '--short', 'HEAD'])
    if (branch) return branch
    return (await git(repo, ['rev-parse', 'HEAD'])).trim()
  }

  async function uniqueBranch(repos: readonly string[], slug: string): Promise<string> {
    for (let n = 1; ; n++) {
      const candidate = `${SESSION_BRANCH_PREFIX}${n === 1 ? slug : `${slug}-${n}`}`
      let taken = false
      for (const repo of repos) {
        if (await branchExists(repo, candidate)) {
          taken = true
          break
        }
      }
      if (!taken) return candidate
    }
  }

  async function checkDirty(repo: string): Promise<DirtyStatus> {
    const out = await git(repo, ['status', '--porcelain=v1', '-z'])
    const files = parsePorcelainZ(out)
    return { dirty: files.length > 0, files }
  }

  async function planSessionStart(
    projects: readonly SessionGitProject[]
  ): Promise<SessionStartPlan> {
    const dirtyRepos: DirtyRepoInfo[] = []
    for (const project of projects) {
      if (!project.isGit) continue
      const status = await checkDirty(project.path)
      if (status.dirty) {
        dirtyRepos.push({
          projectId: project.projectId,
          name: project.name,
          path: project.path,
          files: status.files
        })
      }
    }
    return { projects: [...projects], dirtyRepos }
  }

  /** Stash or WIP-commit the dirty tree on the current branch. */
  async function setAside(
    repo: string,
    choice: 'stash' | 'commit',
    sessionName: string
  ): Promise<{ dirtyHandling: DirtyHandling; stashRef: string | null }> {
    if (choice === 'stash') {
      await git(repo, ['stash', 'push', '--include-untracked', '-m', `arc:${sessionName}`], {
        timeoutMs: LONG_GIT_TIMEOUT_MS
      })
      const stashRef = (await git(repo, ['rev-parse', 'stash@{0}'])).trim()
      return { dirtyHandling: 'stashed', stashRef }
    }
    await git(repo, ['add', '-A'], { timeoutMs: LONG_GIT_TIMEOUT_MS })
    await git(repo, ['commit', '--no-verify', '-m', `WIP before Arc session ${sessionName}`], {
      timeoutMs: LONG_GIT_TIMEOUT_MS
    })
    return { dirtyHandling: 'committed', stashRef: null }
  }

  async function applySessionStart(
    plan: SessionStartPlan,
    options: ApplySessionStartOptions
  ): Promise<SessionStartOutcome> {
    const gitProjects = plan.projects.filter((p) => p.isGit)
    const dirtyIds = new Set(plan.dirtyRepos.map((d) => d.projectId))
    const branchName =
      options.branchName ??
      (await uniqueBranch(
        gitProjects.map((p) => p.path),
        options.slug
      ))

    const choiceFor = (p: SessionGitProject): DirtyChoice | null =>
      dirtyIds.has(p.projectId) ? (options.choices[p.projectId] ?? 'cancel') : null
    // Carry and clean repos go first: they are the ones that can fail without side effects, and a
    // Cancel then only has to undo plain branch switches. Set-aside repos (stash, commit) go last.
    const rank = (p: SessionGitProject): number => {
      const c = choiceFor(p)
      return c === 'stash' || c === 'commit' ? 2 : c === 'cancel' ? 1 : 0
    }
    const ordered = gitProjects
      .map((project, index) => ({ project, index }))
      .sort((a, b) => rank(a.project) - rank(b.project) || a.index - b.index)
      .map((entry) => entry.project)

    const results = new Map<string, SessionBranchResult>()
    const switched: { project: SessionGitProject; previousBranch: string; createdSha: string }[] =
      []
    const keptStashes: { projectId: string; stashRef: string }[] = []
    const keptCommits: string[] = []

    const abort = async (
      reason: 'cancelled' | 'carry-failed' | 'git-failed',
      message: string,
      carryFailed: CarryFailure[]
    ): Promise<SessionStartOutcome> => {
      const rolledBack: string[] = []
      const rollbackFailures: CarryFailure[] = []
      for (const entry of [...switched].reverse()) {
        try {
          await git(entry.project.path, ['checkout', entry.previousBranch])
          // update-ref with the expected old sha only removes the branch if nothing was committed to it.
          await git(entry.project.path, [
            'update-ref',
            '-d',
            `refs/heads/${branchName}`,
            entry.createdSha
          ])
          rolledBack.push(entry.project.projectId)
        } catch (error: unknown) {
          rollbackFailures.push({
            projectId: entry.project.projectId,
            message: errorMessage(error)
          })
        }
      }
      return {
        status: 'aborted',
        reason,
        message,
        carryFailed,
        rolledBack,
        rollbackFailures,
        keptStashes,
        keptCommits
      }
    }

    for (const project of ordered) {
      const choice = choiceFor(project)
      if (choice === 'cancel') {
        return abort('cancelled', 'Session start was cancelled', [])
      }
      try {
        const previousBranch = await currentRef(project.path)
        const baseBranch = await detectBaseBranch(project.path)
        let dirtyHandling: DirtyHandling = 'none'
        let stashRef: string | null = null

        if (choice === 'stash' || choice === 'commit') {
          const aside = await setAside(project.path, choice, options.sessionName)
          dirtyHandling = aside.dirtyHandling
          stashRef = aside.stashRef
          if (stashRef) keptStashes.push({ projectId: project.projectId, stashRef })
          else keptCommits.push(project.projectId)
        } else if (choice === 'carry') {
          dirtyHandling = 'carried'
        }

        try {
          await git(project.path, ['checkout', '-b', branchName, baseBranch])
        } catch (error: unknown) {
          if (choice === 'carry' && error instanceof GitError && error.kind === 'failed') {
            const failure = { projectId: project.projectId, message: errorMessage(error) }
            return abort('carry-failed', `Could not bring changes along in ${project.name}`, [
              failure
            ])
          }
          throw error
        }
        const createdSha = (
          await git(project.path, ['rev-parse', `refs/heads/${branchName}`])
        ).trim()
        switched.push({ project, previousBranch, createdSha })
        results.set(project.projectId, {
          projectId: project.projectId,
          branchName,
          baseBranch,
          previousBranch,
          baseSha: createdSha,
          readOnly: false,
          dirtyHandling,
          stashRef
        })
      } catch (error: unknown) {
        return abort('git-failed', errorMessage(error), [])
      }
    }

    return {
      status: 'started',
      branchName,
      results: plan.projects.map(
        (p) =>
          results.get(p.projectId) ?? {
            projectId: p.projectId,
            branchName: null,
            baseBranch: null,
            previousBranch: null,
            baseSha: null,
            readOnly: true,
            dirtyHandling: 'none',
            stashRef: null
          }
      )
    }
  }

  async function checkoutSessionBranch(
    repo: string,
    branch: string,
    choice?: DirtyChoice
  ): Promise<CheckoutOutcome> {
    const previousBranch = await currentRef(repo)
    const status = await checkDirty(repo)
    let dirtyHandling: DirtyHandling = 'none'
    let stashRef: string | null = null
    if (status.dirty && previousBranch !== branch) {
      if (choice === undefined) return { status: 'dirty', files: status.files }
      if (choice === 'cancel') return { status: 'cancelled' }
      if (choice === 'carry') dirtyHandling = 'carried'
      else {
        const name = branch.startsWith(SESSION_BRANCH_PREFIX)
          ? branch.slice(SESSION_BRANCH_PREFIX.length)
          : branch
        const aside = await setAside(repo, choice, name)
        dirtyHandling = aside.dirtyHandling
        stashRef = aside.stashRef
      }
    }
    if (previousBranch !== branch) {
      try {
        await git(repo, ['checkout', branch])
      } catch (error: unknown) {
        if (dirtyHandling === 'carried' && error instanceof GitError && error.kind === 'failed') {
          return { status: 'carry-failed', message: errorMessage(error) }
        }
        throw error
      }
    }
    return { status: 'switched', previousBranch, dirtyHandling, stashRef }
  }

  return {
    detectBaseBranch,
    uniqueBranch,
    checkDirty,
    currentBranch: currentRef,
    planSessionStart,
    applySessionStart,
    checkoutSessionBranch
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
