import type { CommitsRepo } from '../db/repositories/commits-repo'
import type { MergesRepo } from '../db/repositories/merges-repo'
import type { WorkersRepo } from '../db/repositories/workers-repo'
import type { GitRunner } from '../git/git'
import { isResolverRow } from '../sessions/worker-label'

/** Label of the user's own changes (their commits and Arc's Undo commits). */
export const USER_LABEL = 'You'

/** Sort key of a label: "W<n>" by worker number, "You" after every worker. */
function labelRank(label: string): number {
  return label === USER_LABEL ? Number.POSITIVE_INFINITY : Number(label.slice(1))
}

/** Orders labels by worker number with "You" last, without duplicates. */
export function sortLabels(labels: Iterable<string>): string[] {
  return [...new Set(labels)].sort((a, b) => labelRank(a) - labelRank(b))
}

/** For each path touched in the range, the labels (worker order, "You" last) that changed it. */
export type PathAttribution = ReadonlyMap<string, readonly string[]>

/**
 * A file's workers (tech spec 2.3, rule 5): the union over its new path and, for a rename, its old path.
 * A path no commit touched (a hand-made merge change) is the user's.
 */
export function workersOfFile(
  attribution: PathAttribution,
  path: string,
  oldPath?: string
): string[] {
  const labels = [
    ...(attribution.get(path) ?? []),
    ...(oldPath ? (attribution.get(oldPath) ?? []) : [])
  ]
  return labels.length === 0 ? [USER_LABEL] : sortLabels(labels)
}

export interface AttributionRange {
  sessionId: string
  repo: string
  base: string
  tip: string
}

export interface Attribution {
  /** Who changed each path in `base..tip` of one repository. Read-only git (`log`, `rev-list`). */
  attribute(range: AttributionRange): Promise<PathAttribution>
  /**
   * Changes whenever the rows attribution reads change. A worker's commit or merge is recorded around the
   * time the branch tip moves, so callers include this in a cache key next to the tip.
   */
  version(sessionId: string): string
}

export interface AttributionDeps {
  git: GitRunner
  workersRepo: Pick<WorkersRepo, 'listAllBySession'>
  commitsRepo: Pick<CommitsRepo, 'listBySession'>
  mergesRepo: Pick<MergesRepo, 'listBySession'>
}

interface LoggedCommit {
  sha: string
  paths: string[]
}

/** Parses `log --name-only -z --format=%x01%H`: `\x01<sha>\0\n<path>\0<path>\0\x01<sha>\0...`. */
export function parseCommitPaths(output: string): LoggedCommit[] {
  const commits: LoggedCommit[] = []
  for (const chunk of output.split('\x01')) {
    if (chunk === '') continue
    const parts = chunk.split('\0')
    const sha = (parts[0] ?? '').trim()
    if (sha === '') continue
    const paths = parts
      .slice(1)
      .map((p, i) => (i === 0 ? p.replace(/^\n/, '') : p))
      .filter((p) => p !== '')
    commits.push({ sha, paths })
  }
  return commits
}

interface LoggedMerge {
  sha: string
  parents: string[]
}

function parseMerges(output: string): LoggedMerge[] {
  const merges: LoggedMerge[] = []
  for (const line of output.split('\n')) {
    const [sha, ...parents] = line.trim().split(/\s+/)
    if (sha) merges.push({ sha, parents })
  }
  return merges
}

function parseStringArray(json: string | null): string[] {
  if (json === null) return []
  try {
    const parsed: unknown = JSON.parse(json)
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string') : []
  } catch {
    return []
  }
}

export function createAttribution(deps: AttributionDeps): Attribution {
  return {
    version(sessionId) {
      const commits = deps.commitsRepo.listBySession(sessionId).length
      const merges = deps.mergesRepo.listBySession(sessionId).length
      return `${commits}:${merges}`
    },

    async attribute({ sessionId, repo, base, tip }) {
      const range = `${base}..${tip}`
      // Resolver rows are not authors: their commits and merges are treated as unclaimed.
      const labelOfWorker = new Map<string, string>()
      for (const w of deps.workersRepo.listAllBySession(sessionId)) {
        if (!isResolverRow(w)) labelOfWorker.set(w.id, `W${w.number}`)
      }

      // Rule 1: a commit a worker made, recorded when it committed.
      const labelOfCommit = new Map<string, string>()
      for (const c of deps.commitsRepo.listBySession(sessionId)) {
        const label = labelOfWorker.get(c.workerId)
        if (label !== undefined && !labelOfCommit.has(c.sha)) labelOfCommit.set(c.sha, label)
      }

      const commits = parseCommitPaths(
        await deps.git(repo, [
          'log',
          '--no-merges',
          '--no-renames',
          '--name-only',
          '-z',
          '--format=%x01%H',
          range
        ])
      )

      // Rules 2 and 3: the merge commits Arc made, found by the sha recorded when the merge was published.
      const mergeRows = new Map<string, { label: string; conflictFiles: string[] }>()
      for (const m of deps.mergesRepo.listBySession(sessionId)) {
        const label = m.workerId === null ? undefined : labelOfWorker.get(m.workerId)
        if (m.mergeSha !== null && label !== undefined) {
          mergeRows.set(m.mergeSha, { label, conflictFiles: parseStringArray(m.conflictFilesJson) })
        }
      }
      const needsMerges = commits.some((c) => !labelOfCommit.has(c.sha)) || mergeRows.size > 0
      const merges = needsMerges
        ? parseMerges(await deps.git(repo, ['log', '--merges', '--format=%H %P', range]))
        : []

      const labelOfRewritten = new Map<string, string>()
      const result = new Map<string, Set<string>>()
      const add = (path: string, label: string): void => {
        const set = result.get(path) ?? new Set<string>()
        set.add(label)
        result.set(path, set)
      }

      for (const merge of merges) {
        const row = mergeRows.get(merge.sha)
        if (row === undefined) continue
        for (const path of row.conflictFiles) add(path, row.label)
        const [first, ...others] = merge.parents
        if (first === undefined || others.length === 0) continue
        const brought = await deps.git(repo, ['rev-list', ...others, `^${first}`])
        for (const sha of brought.split('\n')) {
          const trimmed = sha.trim()
          if (trimmed !== '' && !labelOfRewritten.has(trimmed))
            labelOfRewritten.set(trimmed, row.label)
        }
      }

      // Rule 4: whatever neither a worker record nor a merge claims is the user's.
      for (const commit of commits) {
        const label =
          labelOfCommit.get(commit.sha) ?? labelOfRewritten.get(commit.sha) ?? USER_LABEL
        for (const path of commit.paths) add(path, label)
      }

      return new Map([...result].map(([path, labels]) => [path, sortLabels(labels)]))
    }
  }
}
