import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import {
  DESTRUCTIVE,
  GLOBAL_INSTALLS,
  LEAVES_MACHINE,
  NETWORK_TOOLS,
  excludeFromGit,
  type Prefix
} from '../codex/codex-rules'

/**
 * `<worktree>/.cursor/cli.json`: Arc's deny file for a Cursor worker (tech spec 2.4). Cursor runs an
 * action silently when the user's `permissions.allow` or `approvalMode` says so, and in agent mode it
 * never asks before edits or reads at all (spike M1). A project `deny` blocks without asking (spike
 * M1: `Shell(git push)` stopped a push with no permission request), so the file carries
 * - `Shell(...)` entries for the protected commands, from the same prefixes the Codex rules use, and
 * - `Write(<abs>/**)` entries for the group's project checkouts, the knowledge folder and the other
 *   workers' working copies (never the worker's own).
 * The file is hidden through the repository's shared `info/exclude`, and left alone when the
 * repository commits its own `.cursor/cli.json`.
 *
 * Spike N6: a project `cli.json` accepts only `permissions`. Any other top-level key (`sandbox`,
 * `approvalMode`, `version`) makes `agent acp` print "Invalid project config" and exit 1, so this file
 * never carries one. Cursor's sandbox is switched on with `agent --sandbox enabled acp` instead
 * (`CURSOR_SANDBOX_ENABLED` in cursor-config.ts).
 */

/** Where the deny file lives inside a working copy. */
export const CURSOR_DENY_RELATIVE_PATH = join('.cursor', 'cli.json')

/** The git-exclude entry that keeps the file out of commits and out of Review changes. */
export const CURSOR_EXCLUDE_ENTRY = '.cursor/cli.json'

/**
 * Prefixes that stay under Arc's approvals instead of being denied. A deny cannot look at arguments,
 * and a worker deletes, checks out, branches and stashes inside its own working copy all the time.
 * Cursor asks about those commands (they are not on any allow list Arc cannot also see in the bypass
 * report), and Arc's classifier then decides.
 */
const ARGUMENT_DEPENDENT: ReadonlySet<string> = new Set([
  'rm',
  'git reset',
  'git checkout',
  'git restore',
  'git branch',
  'git tag',
  'git stash',
  'git rebase',
  'git worktree',
  'git config',
  'chmod',
  'chown',
  'chgrp',
  'truncate'
])

/** Every spelling of a prefix whose words may be lists of alternatives. */
function expand(prefix: Prefix): string[][] {
  let out: string[][] = [[]]
  for (const word of prefix) {
    const options: readonly string[] = typeof word === 'string' ? [word] : word
    out = out.flatMap((head) => options.map((option) => [...head, option]))
  }
  return out
}

function denies(groups: readonly (readonly Prefix[])[]): string[] {
  const commands = groups.flatMap((group) => group.flatMap(expand)).map((words) => words.join(' '))
  const kept = commands.filter((command) => !ARGUMENT_DEPENDENT.has(command))
  // `Shell(gh)` already covers `gh pr create`: a shorter entry makes the longer ones redundant.
  const unique = [...new Set(kept)]
  return unique.filter(
    (command) => !unique.some((other) => other !== command && command.startsWith(`${other} `))
  )
}

/** The `Shell(...)` entries: publishing, network tools, destructive commands and global installs. */
export function shellDenyEntries(): string[] {
  const commands = denies([LEAVES_MACHINE, NETWORK_TOOLS, DESTRUCTIVE, GLOBAL_INSTALLS])
  return [...new Set(commands)].map((command) => `Shell(${command})`)
}

function realOrSame(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/** Both spellings of a folder (macOS `/var` and `/private/var`), without duplicates. */
function spellings(path: string): string[] {
  const absolute = resolve(path)
  return [...new Set([absolute, realOrSame(absolute)])]
}

/** True when `outer` is `inner` or one of its parents. */
function contains(outer: string, inner: string): boolean {
  return inner === outer || inner.startsWith(outer.endsWith(sep) ? outer : outer + sep)
}

/**
 * The `Write(<abs>/**)` entries. A folder that is, or holds, the worker's own working copy is left
 * out, so the deny can never lock the worker out of its own files.
 */
export function writeDenyEntries(
  denyDirs: readonly string[],
  ownWorktrees: readonly string[]
): string[] {
  const own = ownWorktrees.flatMap(spellings)
  const entries: string[] = []
  for (const dir of denyDirs) {
    for (const spelled of spellings(dir)) {
      if (own.some((tree) => contains(spelled, tree))) continue
      entries.push(`Write(${spelled}/**)`)
    }
  }
  return [...new Set(entries)]
}

export interface CursorDenyOptions {
  /** The working copy the file goes into (and the worker's own working copies, for the Write entries). */
  worktree: string
  /** Other working copies of the worker (a worker spans several projects); never denied. */
  ownWorktrees?: readonly string[]
  /** Folders the worker must not change: the group's project checkouts, the knowledge folder, other workers' working copies. */
  denyDirs: readonly string[]
  /** User MCP servers switched off for the worker role: each gets an `Mcp(<server>:*)` deny (tech spec 2.5, defence in depth). */
  offMcp?: readonly string[]
}

/** `Mcp(<server>:*)` for each switched-off user server. */
export function mcpDenyEntries(offMcp: readonly string[] = []): string[] {
  return [...new Set(offMcp)].map((name) => `Mcp(${name}:*)`)
}

/** The file's text. Stable, so a relaunch rewrites the same bytes. */
export function cursorDenyText(
  options: Omit<CursorDenyOptions, 'worktree'> & { worktree?: string }
): string {
  const own = [
    ...(options.ownWorktrees ?? []),
    ...(options.worktree === undefined ? [] : [options.worktree])
  ]
  // Only `permissions`: Cursor rejects any other top-level key of a project cli.json and exits (spike N6).
  const config = {
    permissions: {
      allow: [] as string[],
      deny: [
        ...shellDenyEntries(),
        ...writeDenyEntries(options.denyDirs, own),
        ...mcpDenyEntries(options.offMcp)
      ]
    }
  }
  return `${JSON.stringify(config, null, 2)}\n`
}

/** True when git tracks the file (the repository commits its own `.cursor/cli.json`). */
function isTracked(worktree: string, relative: string): boolean {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', '--', relative], {
      cwd: worktree,
      stdio: 'ignore'
    })
    return true
  } catch {
    return false
  }
}

export type CursorDenyResult = { written: true } | { written: false; reason: 'committed' }

/**
 * Writes the deny file into a working copy and excludes it from git. Idempotent: a start, a resolver
 * start and a refresh all call it. When the repository commits its own `.cursor/cli.json` it writes
 * nothing and says so (Arc then relies on the approvals and the after-the-fact notes). It throws when
 * the file cannot be written, so a Cursor worker never starts without it.
 */
export function writeCursorDeny(options: CursorDenyOptions): CursorDenyResult {
  const file = join(options.worktree, CURSOR_DENY_RELATIVE_PATH)
  if (existsSync(file) && isTracked(options.worktree, CURSOR_DENY_RELATIVE_PATH)) {
    return { written: false, reason: 'committed' }
  }
  const text = cursorDenyText(options)
  mkdirSync(dirname(file), { recursive: true })
  if (!existsSync(file) || readFileSync(file, 'utf8') !== text) writeFileSync(file, text)
  excludeFromGit(options.worktree, CURSOR_EXCLUDE_ENTRY)
  return { written: true }
}

/** The brain's deny list: it never writes a file (tech spec 2.3); a worker does the changing. */
export const CURSOR_BRAIN_DENY: readonly string[] = ['Write(**)']

/** The brain deny file's text. Only `permissions`, like the worker's (spike N6). */
export function cursorBrainDenyText(offMcp: readonly string[] = []): string {
  const deny = [...CURSOR_BRAIN_DENY, ...mcpDenyEntries(offMcp)]
  return `${JSON.stringify({ permissions: { allow: [], deny } }, null, 2)}\n`
}

/**
 * Writes `<dir>/.cursor/cli.json` for the Cursor brain in its Arc-owned folder (not a git repository,
 * so nothing is excluded). Idempotent; it throws when the file cannot be written, so a Cursor brain
 * never starts without it.
 */
export function writeCursorBrainDeny(dir: string, offMcp: readonly string[] = []): void {
  const file = join(dir, CURSOR_DENY_RELATIVE_PATH)
  const text = cursorBrainDenyText(offMcp)
  mkdirSync(dirname(file), { recursive: true })
  if (!existsSync(file) || readFileSync(file, 'utf8') !== text) writeFileSync(file, text)
}
