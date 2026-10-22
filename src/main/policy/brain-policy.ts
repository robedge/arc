import { homedir } from 'node:os'
import { basename } from 'node:path'
import {
  NPM_LIKE,
  PolicyCategory,
  classifyBashCommand,
  commandWords,
  gitSubcommand,
  hasAny,
  none,
  parseArgs,
  pick
} from './classify'
import type { Classification, ClassifyContext } from './classify'
import type { NormalizedAction } from './normalized-action'
import { parseShell } from './shell-words'
import type { ShellWord } from './shell-words'

/**
 * The brain's shell policy (functional spec 2.8). The brain reads freely and asks before changing
 * anything: a command that only reads is allowed without a row, and every other command goes to the
 * user. The worker rules (`classify`) still run first, so a push, a deletion or a global install
 * keep their own categories; what is left and is not on the read-only list is `changes_checkout`.
 * The brain has no writable folder except the system temp folder.
 */

/** Commands that only read, whatever their arguments (output redirects are checked separately). */
const READ_ONLY_COMMANDS = new Set([
  'ls',
  'cat',
  'head',
  'tail',
  'wc',
  'grep',
  'egrep',
  'fgrep',
  'jq',
  'cut',
  'tr',
  'nl',
  'diff',
  'cmp',
  'stat',
  'file',
  'du',
  'df',
  'tree',
  'pwd',
  'echo',
  'printf',
  'which',
  'whereis',
  'type',
  'basename',
  'dirname',
  'realpath',
  'readlink',
  'date',
  'uname',
  'whoami',
  'id',
  'hostname',
  'sha256sum',
  'shasum',
  'md5',
  'md5sum',
  'xxd',
  'hexdump',
  'strings',
  'column',
  'seq',
  'sleep',
  'true',
  'false',
  'test',
  '[',
  '[[',
  ':',
  'cd',
  'pushd',
  'popd'
])

/**
 * Commands that change files, allowed only when the worker rules found nothing wrong: with no
 * working copies, that means every target sits inside the system temp folder.
 */
const TEMP_CHECKED_COMMANDS = new Set(['mkdir', 'touch', 'tee', 'cp', 'mv', 'ln', 'rm', 'rmdir'])

const GIT_READ_ONLY = new Set([
  'diff',
  'log',
  'status',
  'show',
  'blame',
  'annotate',
  'rev-parse',
  'ls-files',
  'ls-tree',
  'cat-file',
  'rev-list',
  'describe',
  'shortlog',
  'grep',
  'merge-base',
  'name-rev',
  'for-each-ref',
  'show-ref',
  'diff-tree',
  'diff-index',
  'diff-files',
  'whatchanged',
  'count-objects',
  'check-ignore',
  'range-diff',
  'cherry',
  'show-branch',
  'version',
  'help'
])

const GIT_BRANCH_CHANGES = ['d', 'D', 'm', 'M', 'c', 'C', 'u', 'f']
const GIT_BRANCH_CHANGE_LONGS = [
  '--delete',
  '--move',
  '--copy',
  '--force',
  '--set-upstream-to',
  '--unset-upstream',
  '--edit-description',
  '--track',
  '--no-track'
]
const GIT_LIST_LONGS = [
  '--list',
  '--show-current',
  '--contains',
  '--no-contains',
  '--merged',
  '--no-merged',
  '--points-at'
]
const GIT_CONFIG_READ_LONGS = [
  '--get',
  '--get-all',
  '--get-regexp',
  '--get-urlmatch',
  '--list',
  '--get-color',
  '--get-colorbool'
]
const GIT_CONFIG_WRITE_LONGS = ['--unset', '--unset-all', '--add', '--replace-all', '--edit']

const NPM_READ_ONLY = new Set([
  'ls',
  'list',
  'll',
  'la',
  'view',
  'info',
  'show',
  'v',
  'outdated',
  'why',
  'explain',
  'root',
  'prefix',
  'bin'
])

/** A `git` command that only reads. A `-c` setting can run programs, and `--output` writes a file. */
function isReadOnlyGit(args: readonly ShellWord[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const text = args[i]?.text ?? ''
    if (text === '-c' || text.startsWith('-c')) return false
    if (text === '-C' || text === '--git-dir' || text === '--work-tree' || text === '--namespace') {
      i += 1
    } else if (!text.startsWith('-')) break
  }
  const { sub, rest } = gitSubcommand(args)
  if (sub === null) return true
  const a = parseArgs(rest)
  const first = a.positional[0]?.text
  if (GIT_READ_ONLY.has(sub)) {
    if (a.flags.some((f) => f === '--output' || f.startsWith('--output='))) return false
    if (
      sub === 'grep' &&
      (a.shorts.has('O') || a.flags.some((f) => f.startsWith('--open-files')))
    ) {
      return false
    }
    return true
  }
  switch (sub) {
    case 'branch': {
      if (hasAny(a, GIT_BRANCH_CHANGES.join(''), GIT_BRANCH_CHANGE_LONGS)) return false
      if (a.positional.length === 0) return true
      return hasAny(a, 'l', GIT_LIST_LONGS)
    }
    case 'tag': {
      if (hasAny(a, 'dasufmFv', ['--delete', '--annotate', '--sign', '--force', '--verify'])) {
        return false
      }
      if (a.positional.length === 0) return true
      return hasAny(a, 'l', ['--list', '--contains', '--points-at', '--merged', '--no-merged'])
    }
    case 'remote':
      return first === undefined || first === 'show' || first === 'get-url'
    case 'stash':
      return first === 'list' || first === 'show'
    case 'worktree':
      return first === 'list'
    case 'reflog':
      return first === undefined || first === 'show' || first === 'exists'
    case 'submodule':
      return first === undefined || first === 'status' || first === 'summary'
    case 'config':
      return hasAny(a, 'l', GIT_CONFIG_READ_LONGS) && !hasAny(a, 'e', GIT_CONFIG_WRITE_LONGS)
    default:
      return false
  }
}

function isReadOnlyFind(args: readonly ShellWord[]): boolean {
  const writers = new Set([
    '-delete',
    '-exec',
    '-execdir',
    '-ok',
    '-okdir',
    '-fprint',
    '-fprint0',
    '-fprintf',
    '-fls'
  ])
  return !args.some((w) => writers.has(w.text))
}

function isReadOnlyNpm(args: readonly ShellWord[]): boolean {
  const a = parseArgs(args)
  if (a.longs.has('--version') || a.shorts.has('v')) return a.positional.length === 0
  const sub = a.positional[0]?.text
  return sub !== undefined && NPM_READ_ONLY.has(sub)
}

/** Whether the words of one command only read. `null` means not read-only. */
function isReadOnlyCommand(words: readonly ShellWord[]): boolean {
  const head = words[0]
  if (!head) return true
  if (head.dynamic) return false
  const name = basename(head.text)
  const args = words.slice(1)
  if (name === 'git') return isReadOnlyGit(args)
  if (name === 'find') return isReadOnlyFind(args)
  if (NPM_LIKE.has(name)) return isReadOnlyNpm(args)
  if (name === 'rg') {
    return !args.some(
      (w) => w.text === '--pre' || w.text.startsWith('--pre=') || w.text === '--hostname-bin'
    )
  }
  if (name === 'sort') {
    return !args.some((w) => w.text === '-o' || w.text.startsWith('--output'))
  }
  if (name === 'uniq') return parseArgs(args).positional.length <= 1
  if (name === 'env') return args.length === 0
  if (TEMP_CHECKED_COMMANDS.has(name)) return true
  return READ_ONLY_COMMANDS.has(name)
}

/** What a command is called in the sentence the user reads: `git commit`, `node`. */
function describeCommand(words: readonly ShellWord[]): string {
  const head = words[0]
  if (!head) return 'This command'
  const name = basename(head.text)
  if (name === 'git') {
    const { sub } = gitSubcommand(words.slice(1))
    return sub === null ? 'git' : `git ${sub}`
  }
  if (NPM_LIKE.has(name)) {
    const sub = parseArgs(words.slice(1)).positional[0]?.text
    return sub === undefined ? name : `${name} ${sub}`
  }
  return name
}

function changesCheckout(reason: string): Classification {
  return pick([{ category: PolicyCategory.ChangesCheckout, reason }])
}

/**
 * Classifies a Bash command the brain wants to run. `ctx.cwd` is the brain's working directory;
 * there are no working copies, so the only folder it may write in is the system temp folder.
 */
export function classifyBrainBash(command: string, ctx: ClassifyContext): Classification {
  const base = classifyBashCommand(command, { ...ctx, worktreeRoots: [], readOnlyDirs: [] })
  if (base.category === PolicyCategory.OutsideWorktree) {
    const where = base.paths.length > 0 ? ` (${base.paths.join(', ')})` : ''
    return changesCheckout(
      `This writes files outside the temp folder${where}, which the brain may not do without you.`
    )
  }
  if (base.category !== null) return base
  const parsed = parseShell(command, { home: ctx.home ?? homedir() })
  for (const segment of parsed.segments) {
    const words = commandWords(segment.words)
    if (!isReadOnlyCommand(words)) {
      return changesCheckout(
        `\`${describeCommand(words)}\` may change files or git state in your checkouts, so this needs you.`
      )
    }
  }
  return none()
}

/** What the brain may do with an action: refuse it outright, or let the usual escalation decide. */
export type BrainActionVerdict =
  { refuse: string } | { refuse?: undefined; classification: Classification }

/**
 * The brain's policy over a provider-neutral action. A shell command keeps the brain's own rules
 * (`classifyBrainBash`). Edits and extra permissions are always refused: the brain never changes
 * files, and a worker does the changing. An MCP tool that is not known to be read-only goes to
 * the user; so does anything else the brain has no rule for being allowed.
 */
export function classifyBrainAction(
  action: NormalizedAction,
  ctx: ClassifyContext
): BrainActionVerdict {
  switch (action.kind) {
    case 'bash':
      if (action.command === null) return { refuse: 'The command could not be read.' }
      return { classification: classifyBrainBash(action.command, ctx) }
    case 'edit':
      return {
        refuse: `The brain cannot use ${action.tool}. It can read files and run read-only shell commands; start a worker for changes.`
      }
    case 'permission':
      return { refuse: 'The brain cannot ask for more access. Start a worker for that.' }
    case 'mcp':
      return {
        classification:
          action.readOnly === 'yes'
            ? none()
            : pick([
                {
                  category: PolicyCategory.McpWrite,
                  reason: `${action.server} ${action.tool} may change something, so this needs you.`
                }
              ])
      }
    case 'other':
      return {
        refuse: `The brain cannot use ${action.tool}. It can read files and run read-only shell commands; start a worker for changes.`
      }
  }
}
