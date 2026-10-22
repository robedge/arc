import { realpathSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { normalizeClaudeCall } from './normalized-action'
import type { NormalizedAction } from './normalized-action'
import { parseShell } from './shell-words'
import type { ShellSegment, ShellWord } from './shell-words'

/**
 * The policy classifier (tech spec 2.6). It reads the structured tool name and input of a worker's
 * permission request, never model text, and decides whether the request is one of the four kinds
 * that only the user may approve. Anything it cannot read counts as destructive.
 */

export const PolicyCategory = {
  OutsideWorktree: 'outside_worktree',
  LeavesMachine: 'leaves_machine',
  Destructive: 'destructive',
  GlobalInstall: 'global_install',
  /** Codex asks for more access than its sandbox gives (extra folders, the network). Only the user may grant it. */
  ExtraPermissions: 'extra_permissions',
  /** An MCP tool that changes something, or that Arc cannot tell is read-only. The brain may approve it. */
  McpWrite: 'mcp_write',
  /** The brain only: a command that may change files or git state in the user's checkouts. */
  ChangesCheckout: 'changes_checkout'
} as const
export type PolicyCategory = (typeof PolicyCategory)[keyof typeof PolicyCategory]

export interface Classification {
  category: PolicyCategory | null
  /** True for every category but `mcp_write`: the request goes straight to the user and the brain cannot approve it. */
  mustEscalate: boolean
  /** One short sentence for the user; empty when nothing matched. */
  reason: string
  /** Real paths outside the working copy that the request changes (outside_worktree only). */
  paths: string[]
}

export interface ClassifyContext {
  /** The worker's own working copies. Writes inside them are fine. */
  worktreeRoots: readonly string[]
  /** Directories the worker can see but must not change (the knowledge folder, other checkouts). */
  readOnlyDirs: readonly string[]
  /** The worker's working directory; defaults to the first working copy. */
  cwd?: string | undefined
  /** `~` and `$HOME`; defaults to the current user's home. */
  home?: string | undefined
  /**
   * Folders any worker may write in without asking; defaults to the system temp folder (its real
   * path too, `/private/var/folders/...` on macOS) and `/tmp`.
   */
  tempDirs?: readonly string[] | undefined
}

interface Finding {
  category: PolicyCategory
  reason: string
  /** The real path a changing command touches, for outside-worktree findings. */
  path?: string
}

const SEVERITY: readonly PolicyCategory[] = [
  PolicyCategory.Destructive,
  PolicyCategory.LeavesMachine,
  PolicyCategory.GlobalInstall,
  PolicyCategory.OutsideWorktree,
  PolicyCategory.ExtraPermissions,
  PolicyCategory.McpWrite,
  PolicyCategory.ChangesCheckout
]

export function none(): Classification {
  return { category: null, mustEscalate: false, reason: '', paths: [] }
}

export function pick(findings: readonly Finding[]): Classification {
  for (const category of SEVERITY) {
    const found = findings.find((f) => f.category === category)
    if (found) {
      const paths = findings.flatMap((f) =>
        f.category === category && f.path !== undefined ? [f.path] : []
      )
      return {
        category,
        mustEscalate: category !== PolicyCategory.McpWrite,
        reason: found.reason,
        paths: [...new Set(paths)]
      }
    }
  }
  return none()
}

// ---- paths ----

/** `realpath` that also works for a path that does not exist yet: the existing ancestor is resolved. */
export function realpathLoose(path: string): string {
  let current = resolve(path)
  const tail: string[] = []
  for (;;) {
    try {
      return join(realpathSync.native(current), ...tail)
    } catch {
      const parent = dirname(current)
      if (parent === current) return join(current, ...tail)
      tail.unshift(basename(current))
      current = parent
    }
  }
}

function isInside(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)
}

const DEVICE_PATHS = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/stdin', '/dev/tty'])

interface Scope {
  roots: string[]
  readOnly: string[]
  /** Folders that are always fine to write in (the system temp folder). */
  temp: string[]
  cwd: string
  home: string
  /** A virtual environment was activated earlier in this command. */
  venv: boolean
}

/** The system temp folder under every spelling it can have (`/tmp` and `/private/tmp`, `$TMPDIR` and its real path). */
function tempRoots(ctx: ClassifyContext): string[] {
  const given = ctx.tempDirs ?? [tmpdir(), '/tmp']
  const all = given.flatMap((dir) => [resolve(dir), realpathLoose(dir)])
  return [...new Set(all)]
}

function makeScope(ctx: ClassifyContext): Scope {
  const roots = ctx.worktreeRoots.map(realpathLoose)
  const start = ctx.cwd ?? ctx.worktreeRoots[0] ?? process.cwd()
  return {
    roots,
    readOnly: ctx.readOnlyDirs.map(realpathLoose),
    temp: tempRoots(ctx),
    cwd: realpathLoose(start),
    home: ctx.home ?? homedir(),
    venv: false
  }
}

function outside(reason: string, path?: string): Finding {
  return {
    category: PolicyCategory.OutsideWorktree,
    reason,
    ...(path === undefined ? {} : { path })
  }
}

/**
 * Checks that a path a command changes is inside the worker's working copies or the temp folder.
 * Reading a path outside is never checked: only changing files outside the working copy needs the user.
 */
function checkWrite(
  word: ShellWord | string,
  scope: Scope,
  what: string,
  findings: Finding[]
): string | null {
  const text = typeof word === 'string' ? word : word.text
  const dynamic = typeof word === 'string' ? false : word.dynamic
  if (dynamic) {
    findings.push(outside(`Arc can't tell where ${what} goes, so this needs you.`))
    return null
  }
  const abs = resolve(scope.cwd, text)
  if (DEVICE_PATHS.has(abs)) return abs
  const real = realpathLoose(abs)
  if (scope.roots.some((root) => isInside(real, root))) return real
  const own = scope.readOnly.some((dir) => isInside(real, dir))
  // The temp folder itself is not a place to write into; anything strictly inside it is.
  if (!own && scope.temp.some((dir) => real !== dir && isInside(real, dir))) return real
  findings.push(
    outside(
      own
        ? `${what} changes ${real}, which is outside the worker's working copy, so this needs you.`
        : `${what} changes ${real}, outside the worker's working copy, so this needs you.`,
      real
    )
  )
  return real
}

// ---- argument helpers ----

export interface Args {
  words: ShellWord[]
  /** Arguments up to a bare `--`. */
  flags: string[]
  /** Single-letter flags from clusters such as `-rf`. */
  shorts: Set<string>
  /** Long flag names without the value (`--force=1` gives `--force`). */
  longs: Set<string>
  positional: ShellWord[]
}

export function parseArgs(words: readonly ShellWord[]): Args {
  const flags: string[] = []
  const shorts = new Set<string>()
  const longs = new Set<string>()
  const positional: ShellWord[] = []
  let literal = false
  for (const word of words) {
    const text = word.text
    if (!literal && text === '--') {
      literal = true
      continue
    }
    if (!literal && text.startsWith('--') && text.length > 2) {
      flags.push(text)
      longs.add(text.split('=')[0] ?? text)
    } else if (!literal && /^-[A-Za-z]/.test(text)) {
      flags.push(text)
      for (const ch of text.slice(1)) shorts.add(ch)
    } else {
      positional.push(word)
    }
  }
  return { words: [...words], flags, shorts, longs, positional }
}

export const hasAny = (args: Args, shorts: string, longs: readonly string[] = []): boolean =>
  [...shorts].some((c) => args.shorts.has(c)) || longs.some((l) => args.longs.has(l))

// ---- the command table ----

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh'])

const KEYWORDS = new Set([
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'do',
  'done',
  'while',
  'until',
  'for',
  'case',
  'esac',
  'select',
  '!',
  '{',
  '}',
  'time',
  'coproc',
  'function'
])

const SYSTEM_PACKAGE_MANAGERS = new Set([
  'apt',
  'apt-get',
  'aptitude',
  'dpkg',
  'dnf',
  'yum',
  'zypper',
  'pacman',
  'apk',
  'snap',
  'port',
  'nix-env',
  'choco',
  'winget',
  'scoop'
])

const REMOTE_COMMANDS = new Set([
  'scp',
  'sftp',
  'ssh',
  'ssh-copy-id',
  'nc',
  'ncat',
  'telnet',
  'ftp',
  'gh',
  'glab'
])

export const NPM_LIKE = new Set(['npm', 'pnpm', 'yarn', 'bun'])
const NPM_INSTALL_SUBS = new Set([
  'install',
  'i',
  'add',
  'update',
  'up',
  'upgrade',
  'uninstall',
  'remove',
  'rm',
  'link',
  'ln',
  'unlink'
])
const NPM_PUBLISH_SUBS = new Set(['publish', 'unpublish', 'deprecate'])
/** Flags of npm-like tools that take a value, so the value is not mistaken for the subcommand. */
const NPM_VALUE_FLAGS = new Set([
  '--filter',
  '-F',
  '-C',
  '--dir',
  '--prefix',
  '--cwd',
  '--workspace',
  '--registry',
  '--userconfig',
  '--location'
])

const PIP_NAME = /^pip(\d+(\.\d+)?)?$/
const PYTHON_NAME = /^python(\d+(\.\d+)?)?$/

function destructive(reason: string): Finding {
  return { category: PolicyCategory.Destructive, reason }
}
function leaves(reason: string): Finding {
  return { category: PolicyCategory.LeavesMachine, reason }
}
function globalInstall(reason: string): Finding {
  return { category: PolicyCategory.GlobalInstall, reason }
}

function unreadable(what: string): Finding {
  return destructive(`This command runs ${what}, which Arc can't check, so it needs you.`)
}

function cannotRead(problem: string): Finding {
  return destructive(`Arc can't read this command safely (${problem}), so it needs you.`)
}

const isAssignment = (text: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(text)

/** Skips the flags (and their values) that wrappers such as `env` or `xargs` take before the real command. */
function skipWrapperFlags(
  words: readonly ShellWord[],
  withValue: ReadonlySet<string>
): ShellWord[] {
  let i = 0
  while (i < words.length) {
    const text = words[i]?.text ?? ''
    if (text === '--') {
      i += 1
      break
    }
    if (!text.startsWith('-') || text === '-') break
    i += withValue.has(text) ? 2 : 1
  }
  return words.slice(i)
}

const NO_VALUES: ReadonlySet<string> = new Set()

/** The words of the command a wrapper (`env`, `nohup`, `xargs`, `timeout`, ...) runs, or null if it is not one. */
function unwrap(name: string, args: readonly ShellWord[]): ShellWord[] | null {
  switch (name) {
    case 'env': {
      const rest = skipWrapperFlags(args, new Set(['-u', '-C', '-S', '--unset', '--chdir']))
      let i = 0
      while (i < rest.length && isAssignment(rest[i]?.text ?? '')) i += 1
      return rest.slice(i)
    }
    case 'command':
    case 'builtin':
    case 'exec':
    case 'nohup':
    case 'setsid':
    case 'caffeinate':
    case 'time':
      return skipWrapperFlags(args, NO_VALUES)
    case 'nice':
    case 'ionice':
      return skipWrapperFlags(args, new Set(['-n', '-c']))
    case 'stdbuf':
      return skipWrapperFlags(args, NO_VALUES)
    case 'timeout': {
      const rest = skipWrapperFlags(args, new Set(['-s', '-k', '--signal', '--kill-after']))
      return rest.slice(1)
    }
    case 'xargs':
      return skipWrapperFlags(
        args,
        new Set(['-I', '-n', '-P', '-L', '-s', '-d', '-E', '-a', '--max-args', '--max-procs'])
      )
    case 'sudo':
    case 'doas':
      return skipWrapperFlags(
        args,
        new Set(['-u', '-g', '-h', '-p', '-C', '-D', '-R', '-T', '-U', '--user', '--group'])
      )
    default:
      return null
  }
}

const GIT_VALUE_FLAGS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace'])

export function gitSubcommand(args: readonly ShellWord[]): {
  sub: string | null
  rest: ShellWord[]
} {
  let i = 0
  while (i < args.length) {
    const text = args[i]?.text ?? ''
    if (GIT_VALUE_FLAGS.has(text)) i += 2
    else if (text.startsWith('-')) i += 1
    else break
  }
  const sub = args[i]?.text ?? null
  return { sub, rest: args.slice(i + 1) }
}

function classifyGit(args: readonly ShellWord[], findings: Finding[]): void {
  const { sub, rest } = gitSubcommand(args)
  if (sub === null) return
  const a = parseArgs(rest)
  const first = a.positional[0]?.text
  switch (sub) {
    case 'push': {
      const force =
        hasAny(a, 'fd', ['--force', '--force-with-lease', '--force-if-includes', '--delete']) ||
        hasAny(a, '', ['--mirror', '--prune']) ||
        a.positional.some((p) => p.text.startsWith('+') || p.text.startsWith(':'))
      findings.push(
        force
          ? destructive('A force push or a remote delete can overwrite history, so this needs you.')
          : leaves('Pushing leaves your machine, so this needs you.')
      )
      return
    }
    case 'send-email':
      findings.push(leaves('Sending mail leaves your machine, so this needs you.'))
      return
    case 'remote':
      if (first === 'add' || first === 'set-url') {
        findings.push(leaves('Adding a remote lets work leave your machine, so this needs you.'))
      }
      return
    case 'reset':
      if (a.longs.has('--hard')) {
        findings.push(destructive('A hard reset throws away work, so this needs you.'))
      }
      return
    case 'clean':
      if (!hasAny(a, 'n', ['--dry-run'])) {
        findings.push(destructive('git clean deletes untracked files, so this needs you.'))
      }
      return
    case 'branch':
      if (hasAny(a, 'dD', ['--delete'])) {
        findings.push(destructive('Deleting a branch can lose work, so this needs you.'))
      }
      return
    case 'tag':
      if (hasAny(a, 'd', ['--delete'])) {
        findings.push(destructive('Deleting a tag can lose work, so this needs you.'))
      }
      return
    case 'checkout': {
      const discardsAll = a.positional.some((p) => p.text === '.' || p.text === '*')
      if (hasAny(a, 'f', ['--force']) || discardsAll) {
        findings.push(
          destructive('Checking out over your changes throws them away, so this needs you.')
        )
      }
      return
    }
    case 'restore':
      if (
        a.positional.some((p) => p.text === '.' || p.text === ':/') &&
        !(a.longs.has('--staged') && !a.longs.has('--worktree'))
      ) {
        findings.push(destructive('Restoring every file throws away changes, so this needs you.'))
      }
      return
    case 'stash':
      if (first === 'drop' || first === 'clear') {
        findings.push(destructive('Dropping a stash can lose work, so this needs you.'))
      }
      return
    case 'rebase':
      if (!hasAny(a, '', ['--abort', '--continue', '--skip', '--quit'])) {
        findings.push(destructive('Rebasing rewrites history, so this needs you.'))
      }
      return
    case 'worktree':
      if (first === 'remove') {
        findings.push(destructive('Removing a working copy can lose work, so this needs you.'))
      }
      return
    case 'filter-branch':
    case 'filter-repo':
      findings.push(destructive('Rewriting history can lose work, so this needs you.'))
      return
    case 'reflog':
      if (first === 'expire' || first === 'delete') {
        findings.push(destructive('Expiring the reflog can lose work, so this needs you.'))
      }
      return
    case 'gc':
      if (a.flags.some((f) => f.startsWith('--prune'))) {
        findings.push(destructive('Pruning objects can lose work, so this needs you.'))
      }
      return
    case 'update-ref':
      if (hasAny(a, 'd')) {
        findings.push(destructive('Deleting a ref can lose work, so this needs you.'))
      }
      return
    case 'config': {
      const machineWide = hasAny(a, '', ['--global', '--system'])
      const writes =
        a.positional.length >= 2 ||
        hasAny(a, 'e', [
          '--unset',
          '--unset-all',
          '--add',
          '--replace-all',
          '--edit',
          '--remove-section',
          '--rename-section'
        ])
      if (machineWide && writes) {
        findings.push(
          outside(
            "Changing the machine-wide git settings is outside the worker's working copy, so this needs you."
          )
        )
      }
      return
    }
    default:
  }
}

function remoteLooking(word: ShellWord): boolean {
  const text = word.text
  if (text.startsWith('rsync://') || text.startsWith('ssh://')) return true
  if (text.startsWith('/') || text.startsWith('./') || text.startsWith('../')) return false
  return /^[^/\s]+:/.test(text) || /^[^/\s]+@[^/\s]+:/.test(text)
}

const CURL_ARG_FLAGS = new Set('oHeAuUwmxYycbBrKzECDtQPV'.split(''))

function curlUploads(args: readonly ShellWord[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const text = args[i]?.text ?? ''
    if (text.startsWith('--')) {
      const name = text.split('=')[0] ?? text
      if (
        name === '--data' ||
        name.startsWith('--data-') ||
        name === '--form' ||
        name === '--form-string' ||
        name === '--upload-file' ||
        name === '--json'
      ) {
        return true
      }
      if (name === '--request') {
        const method = (text.includes('=') ? text.split('=')[1] : args[i + 1]?.text) ?? ''
        if (/^(POST|PUT|DELETE|PATCH)$/i.test(method)) return true
      }
      continue
    }
    if (!/^-[A-Za-z]/.test(text)) continue
    const cluster = text.slice(1)
    for (let c = 0; c < cluster.length; c++) {
      const ch = cluster.charAt(c)
      if (ch === 'd' || ch === 'F' || ch === 'T') return true
      if (ch === 'X') {
        const attached = cluster.slice(c + 1)
        const method = attached !== '' ? attached : (args[i + 1]?.text ?? '')
        if (/^(POST|PUT|DELETE|PATCH)$/i.test(method)) return true
        break
      }
      if (CURL_ARG_FLAGS.has(ch)) break
    }
  }
  return false
}

function wgetUploads(args: readonly ShellWord[]): boolean {
  return args.some((w) => {
    const text = w.text
    return (
      text.startsWith('--post-data') ||
      text.startsWith('--post-file') ||
      text.startsWith('--body-data') ||
      text.startsWith('--body-file') ||
      /^--method=(POST|PUT|DELETE|PATCH)$/i.test(text)
    )
  })
}

function classifyNpmLike(name: string, args: readonly ShellWord[], findings: Finding[]): void {
  let sub: string | null = null
  let i = 0
  while (i < args.length) {
    const text = args[i]?.text ?? ''
    if (NPM_VALUE_FLAGS.has(text)) i += 2
    else if (text.startsWith('-')) i += 1
    else {
      sub = text
      break
    }
  }
  if (sub === null) return
  const rest = args.slice(i + 1)
  const a = parseArgs(args)
  const second = rest.find((w) => !w.text.startsWith('-'))?.text
  if (NPM_PUBLISH_SUBS.has(sub) || (sub === 'npm' && second === 'publish')) {
    findings.push(leaves('Publishing leaves your machine, so this needs you.'))
    return
  }
  const isGlobal =
    a.shorts.has('g') ||
    a.longs.has('--global') ||
    args.some((w) => w.text === '--location=global') ||
    args.some((w, idx) => w.text === '--location' && args[idx + 1]?.text === 'global')
  if ((NPM_INSTALL_SUBS.has(sub) && isGlobal) || (name === 'yarn' && sub === 'global')) {
    findings.push(globalInstall('A global install changes the whole machine, so this needs you.'))
  }
}

function classifyPip(
  command: ShellWord,
  args: readonly ShellWord[],
  scope: Scope,
  findings: Finding[]
): void {
  const a = parseArgs(args)
  if (a.positional[0]?.text !== 'install') return
  const systemWide = hasAny(a, '', ['--user', '--break-system-packages', '--system'])
  const inVenv = scope.venv || (command.text.includes('/') && isUnderRoots(command.text, scope))
  const target = valueAfter(args, ['-t', '--target', '--prefix'])
  const targetInside = target !== null && isUnderRoots(target, scope)
  if (systemWide || !(inVenv || targetInside)) {
    findings.push(
      globalInstall(
        'Installing outside a virtual environment changes the whole machine, so this needs you.'
      )
    )
  }
}

function valueAfter(args: readonly ShellWord[], names: readonly string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const text = args[i]?.text ?? ''
    for (const name of names) {
      if (text === name) return args[i + 1]?.text ?? null
      if (name.startsWith('--') && text.startsWith(name + '=')) return text.slice(name.length + 1)
    }
  }
  return null
}

function isUnderRoots(path: string, scope: Scope): boolean {
  const real = realpathLoose(resolve(scope.cwd, path))
  return scope.roots.some((root) => isInside(real, root))
}

/** The sub-commands of `find -exec ... ;`. */
function findExecs(args: readonly ShellWord[]): ShellWord[][] {
  const runs: ShellWord[][] = []
  for (let i = 0; i < args.length; i++) {
    const text = args[i]?.text ?? ''
    if (text !== '-exec' && text !== '-execdir' && text !== '-ok' && text !== '-okdir') continue
    const run: ShellWord[] = []
    for (i += 1; i < args.length; i++) {
      const w = args[i]
      if (!w || w.text === ';' || w.text === '+') break
      run.push(w)
    }
    runs.push(run)
  }
  return runs
}

function classifyWords(
  words: readonly ShellWord[],
  segment: ShellSegment | null,
  scope: Scope,
  findings: Finding[],
  depth: number
): void {
  if (depth > 6) {
    findings.push(unreadable('commands nested too deeply'))
    return
  }
  let i = 0
  while (i < words.length) {
    const text = words[i]?.text ?? ''
    if (isAssignment(text) || KEYWORDS.has(text)) i += 1
    else break
  }
  const commandWord = words[i]
  if (!commandWord) return
  if (commandWord.dynamic) {
    findings.push(unreadable('a command taken from a variable or substitution'))
    return
  }
  const name = basename(commandWord.text)
  const args = words.slice(i + 1)

  if (name === 'sudo' || name === 'doas') {
    findings.push(globalInstall('sudo runs with machine-wide rights, so this needs you.'))
  }
  const inner = unwrap(name, args)
  if (inner !== null) {
    classifyWords(inner, null, scope, findings, depth + 1)
    return
  }

  const a = parseArgs(args)

  if (name === 'eval') {
    findings.push(unreadable('eval'))
    return
  }
  if (SHELLS.has(name)) {
    if (a.shorts.has('c') || a.longs.has('--command')) {
      findings.push(unreadable('a shell command string'))
    } else if (
      !a.longs.has('--version') &&
      !a.longs.has('--help') &&
      (a.positional.length === 0 || a.shorts.has('s') || segment?.heredoc === true)
    ) {
      findings.push(unreadable('a script from stdin'))
    }
    return
  }
  if (name === 'su') {
    if (a.shorts.has('c')) findings.push(unreadable('a shell command string'))
    return
  }
  if (name === 'source' || name === '.') {
    const target = a.positional[0]
    if (target?.dynamic) findings.push(unreadable('a script from a substitution'))
    else if (target && /(^|\/)activate$/.test(target.text)) scope.venv = true
    return
  }

  if (REMOTE_COMMANDS.has(name)) {
    findings.push(
      name === 'gh' || name === 'glab'
        ? leaves(`${name} talks to a remote service, so this needs you.`)
        : leaves(`${name} leaves your machine, so this needs you.`)
    )
    return
  }
  if (name === 'rsync') {
    if (a.positional.some(remoteLooking)) {
      findings.push(
        leaves('rsync to or from a remote host leaves your machine, so this needs you.')
      )
    } else {
      const dest = a.positional[a.positional.length - 1]
      if (dest) checkWrite(dest, scope, 'rsync', findings)
    }
    return
  }
  if (name === 'curl') {
    if (curlUploads(args)) {
      findings.push(leaves('Sending data with curl leaves your machine, so this needs you.'))
    }
    return
  }
  if (name === 'wget') {
    if (wgetUploads(args)) {
      findings.push(leaves('Sending data with wget leaves your machine, so this needs you.'))
    }
    return
  }
  if (name === 'docker' || name === 'podman') {
    const sub = a.positional[0]?.text
    const subSub = a.positional[1]?.text
    if (
      sub === 'push' ||
      (sub === 'image' && subSub === 'push') ||
      ((sub === 'buildx' || sub === 'build') && a.longs.has('--push'))
    ) {
      findings.push(leaves('Pushing an image leaves your machine, so this needs you.'))
    }
    return
  }
  if (name === 'cargo' || name === 'gem' || name === 'twine') {
    const sub = a.positional[0]?.text
    if (sub === 'publish' || sub === 'push' || (name === 'twine' && sub === 'upload')) {
      findings.push(leaves('Publishing leaves your machine, so this needs you.'))
    } else if (sub === 'install' && name !== 'twine') {
      findings.push(globalInstall(`${name} install changes the whole machine, so this needs you.`))
    }
    return
  }
  if (name === 'go') {
    if (a.positional[0]?.text === 'install') {
      findings.push(globalInstall('go install changes the whole machine, so this needs you.'))
    }
    return
  }
  if (name === 'rustup') {
    const sub = a.positional[0]?.text
    if (sub === 'install' || sub === 'update' || sub === 'toolchain' || sub === 'component') {
      findings.push(globalInstall('rustup changes the whole machine, so this needs you.'))
    }
    return
  }
  if (name === 'brew') {
    const sub = a.positional[0]?.text
    if (
      sub !== undefined &&
      ['install', 'reinstall', 'upgrade', 'tap', 'untap', 'uninstall', 'remove', 'cask'].includes(
        sub
      )
    ) {
      findings.push(
        globalInstall('Homebrew installs software for the whole machine, so this needs you.')
      )
    }
    return
  }
  if (SYSTEM_PACKAGE_MANAGERS.has(name)) {
    findings.push(
      globalInstall(`${name} installs software for the whole machine, so this needs you.`)
    )
    return
  }
  if (NPM_LIKE.has(name)) {
    classifyNpmLike(name, args, findings)
    return
  }
  if (PIP_NAME.test(name)) {
    classifyPip(commandWord, args, scope, findings)
    return
  }
  if (name === 'pipx' || (name === 'uv' && a.positional[0]?.text === 'tool')) {
    if (a.positional[name === 'pipx' ? 0 : 1]?.text === 'install') {
      findings.push(globalInstall('This installs a tool for the whole machine, so this needs you.'))
    }
    return
  }
  if (name === 'uv' && a.positional[0]?.text === 'pip') {
    if (
      a.positional[1]?.text === 'install' &&
      hasAny(a, '', ['--system', '--break-system-packages'])
    ) {
      findings.push(
        globalInstall('Installing system-wide changes the whole machine, so this needs you.')
      )
    }
    return
  }
  if (PYTHON_NAME.test(name)) {
    const m = args.findIndex((w) => w.text === '-m')
    if (m >= 0 && args[m + 1]?.text === 'pip') {
      classifyPip(commandWord, args.slice(m + 2), scope, findings)
    }
    return
  }

  switch (name) {
    case 'git':
      classifyGit(args, findings)
      return
    case 'rm': {
      if (hasAny(a, 'rRf', ['--recursive', '--force'])) {
        findings.push(destructive('rm -r or rm -f deletes files for good, so this needs you.'))
        return
      }
      for (const p of a.positional) checkWrite(p, scope, 'rm', findings)
      return
    }
    case 'rmdir':
    case 'unlink':
    case 'mkdir':
    case 'touch':
    case 'mkfifo':
    case 'tee':
      for (const p of a.positional) checkWrite(p, scope, name, findings)
      return
    case 'cp':
    case 'install':
    case 'ln': {
      const dir = valueAfter(args, ['-t', '--target-directory'])
      if (dir !== null) checkWrite(dir, scope, name, findings)
      else {
        const dest = a.positional[a.positional.length - 1]
        if (dest) checkWrite(dest, scope, name, findings)
      }
      return
    }
    case 'mv': {
      const dir = valueAfter(args, ['-t', '--target-directory'])
      if (dir !== null) checkWrite(dir, scope, name, findings)
      for (const p of a.positional) checkWrite(p, scope, name, findings)
      return
    }
    case 'chmod':
    case 'chown':
    case 'chgrp': {
      if (hasAny(a, 'R', ['--recursive'])) {
        findings.push(destructive(`${name} -R changes many files at once, so this needs you.`))
        return
      }
      for (const p of a.positional.slice(1)) checkWrite(p, scope, name, findings)
      return
    }
    case 'sed': {
      if (!hasAny(a, 'i', ['--in-place'])) return
      // Without -e/-f the first non-empty positional is the script, not a file.
      const hasScriptFlag = hasAny(a, 'ef', ['--expression', '--file'])
      const files = a.positional.filter((p) => p.text !== '')
      for (const p of hasScriptFlag ? files : files.slice(1))
        checkWrite(p, scope, 'sed -i', findings)
      return
    }
    case 'truncate':
      findings.push(destructive('truncate cuts files down, so this needs you.'))
      return
    case 'dd':
    case 'shred':
    case 'fdisk':
    case 'parted':
    case 'diskutil':
    case 'shutdown':
    case 'reboot':
    case 'halt':
    case 'poweroff':
      findings.push(destructive(`${name} can destroy data or stop the machine, so this needs you.`))
      return
    case 'find': {
      if (a.flags.includes('-delete') || args.some((w) => w.text === '-delete')) {
        findings.push(destructive('find -delete removes files, so this needs you.'))
      }
      for (const run of findExecs(args)) classifyWords(run, null, scope, findings, depth + 1)
      return
    }
    case 'cd':
    case 'pushd': {
      const target = a.positional[0]
      const dest: ShellWord | string = target ?? scope.home
      if (target?.text === '-') {
        findings.push(outside("cd - goes to a directory Arc can't check, so this needs you."))
        return
      }
      // Changing directory only reads; what a later command writes is checked against the new cwd.
      const destText = typeof dest === 'string' ? dest : dest.text
      if (typeof dest !== 'string' && dest.dynamic) {
        findings.push(outside("Arc can't tell where cd goes, so this needs you."))
        return
      }
      scope.cwd = realpathLoose(resolve(scope.cwd, destText))
      return
    }
    default:
      if (name.startsWith('mkfs')) {
        findings.push(destructive('mkfs formats a disk, so this needs you.'))
      }
  }
}

function classifySegment(segment: ShellSegment, scope: Scope, findings: Finding[]): void {
  for (const redirect of segment.redirects) {
    const writes = ['>', '>>', '>|', '&>', '&>>', '<>', '>&'].includes(redirect.op)
    if (!writes || !redirect.target) continue
    if (redirect.op === '>&' && /^(\d+|-)$/.test(redirect.target.text)) continue
    checkWrite(redirect.target, scope, 'the redirect', findings)
  }
  classifyWords(segment.words, segment, scope, findings, 0)
}

export function classifyBashCommand(command: string, ctx: ClassifyContext): Classification {
  const scope = makeScope(ctx)
  const parsed = parseShell(command, { home: scope.home })
  const findings: Finding[] = []
  for (const problem of parsed.problems) findings.push(cannotRead(problem))
  for (const segment of parsed.segments) classifySegment(segment, scope, findings)
  return pick(findings)
}

function classifyFiles(
  action: Extract<NormalizedAction, { kind: 'edit' }>,
  ctx: ClassifyContext
): Classification {
  const scope = makeScope(ctx)
  const findings: Finding[] = []
  if (action.unknownPaths === true) {
    findings.push(outside(`Arc can't tell which file ${action.tool} changes, so this needs you.`))
  }
  for (const path of action.paths) checkWrite(path, scope, action.tool, findings)
  return pick(findings)
}

/**
 * Classifies one action (tech spec 2.2). Bash and the file changes are checked against the
 * worker's working copies; a Codex permission request is `extra_permissions`; an MCP tool that is
 * not known to be read-only is `mcp_write`. Anything else is not one of the policy categories and
 * goes to the brain.
 */
export function classifyAction(action: NormalizedAction, ctx: ClassifyContext): Classification {
  switch (action.kind) {
    case 'bash':
      if (action.command === null) return pick([unreadable('a command Arc could not read')])
      return classifyBashCommand(
        action.command,
        action.cwd === undefined ? ctx : { ...ctx, cwd: action.cwd }
      )
    case 'edit':
      return classifyFiles(action, ctx)
    case 'mcp':
      if (action.readOnly === 'yes') return none()
      return pick([
        {
          category: PolicyCategory.McpWrite,
          reason:
            action.readOnly === 'no'
              ? `${action.server} ${action.tool} changes something, so Arc checks it first.`
              : `Arc can't tell whether ${action.server} ${action.tool} only reads, so it checks it first.`
        }
      ])
    case 'permission':
      return pick([
        {
          category: PolicyCategory.ExtraPermissions,
          reason: 'The agent asks for access beyond its working copy, so this needs you.'
        }
      ])
    case 'other':
      return none()
  }
}

/**
 * Classifies one Claude permission request. `input` is the tool input exactly as the CLI sent it.
 * Only Bash and the file-changing tools are looked at; a read-only tool or an unknown tool is not
 * one of the policy categories and goes to the brain.
 */
export function classify(
  toolName: string,
  input: Record<string, unknown>,
  ctx: ClassifyContext
): Classification {
  return classifyAction(normalizeClaudeCall(toolName, input), ctx)
}

// ---- command prefixes and publish actions (allow rules, auto-approve) ----

/** Tools whose first word is followed by a subcommand that says what the command does. */
const SUBCOMMAND_TOOLS = new Set([
  'git',
  'gh',
  'glab',
  'npm',
  'pnpm',
  'yarn',
  'bun',
  'docker',
  'podman',
  'cargo',
  'brew',
  'uv',
  'go',
  'gem',
  'rustup',
  'twine',
  'apt',
  'apt-get'
])

const OPAQUE_COMMANDS = new Set([...SHELLS, 'eval', 'su', 'source', '.', 'xargs'])

/** The words of the command a segment runs, after assignments, keywords and wrappers such as `env` or `sudo`. */
export function commandWords(words: readonly ShellWord[]): ShellWord[] {
  let current = [...words]
  for (let depth = 0; depth < 6; depth++) {
    let i = 0
    while (i < current.length) {
      const text = current[i]?.text ?? ''
      if (isAssignment(text) || KEYWORDS.has(text)) i += 1
      else break
    }
    current = current.slice(i)
    const first = current[0]
    if (!first) return []
    const inner = unwrap(basename(first.text), current.slice(1))
    if (inner === null) return current
    current = inner
  }
  return current
}

function prefixOf(words: readonly ShellWord[]): string | null {
  const first = words[0]
  if (!first) return null
  const name = basename(first.text)
  if (!SUBCOMMAND_TOOLS.has(name)) return name
  const args = words.slice(1)
  if (name === 'git') {
    const { sub } = gitSubcommand(args)
    return sub === null ? name : `${name} ${sub}`
  }
  const positional = parseArgs(args).positional.map((p) => p.text)
  const subs = positional.slice(0, name === 'gh' || name === 'glab' ? 2 : 1)
  return [name, ...subs].join(' ')
}

/**
 * The normalized prefix of a Bash command, the part an "always allow" rule remembers: the command
 * word plus its subcommand (`git push`, `gh pr create`, `curl`). A command made of several parts
 * gives every distinct prefix joined with ` && `, so a rule for one part never covers a command
 * that also does something else. A leading `cd` is ignored. A command Arc cannot read is its own
 * prefix, so only that exact command matches.
 */
export function commandPrefix(command: string): string {
  const parsed = parseShell(command, { home: homedir() })
  if (parsed.problems.length > 0) return command.trim()
  const prefixes: string[] = []
  for (const segment of parsed.segments) {
    const words = commandWords(segment.words)
    const head = words[0]
    // A shell string, eval or a command from a variable can be anything: only that exact command matches.
    if (head && (head.dynamic || OPAQUE_COMMANDS.has(basename(head.text)))) return command.trim()
    const prefix = prefixOf(words)
    if (prefix === null || prefix === 'cd' || prefix === 'pushd') continue
    if (!prefixes.includes(prefix)) prefixes.push(prefix)
  }
  return prefixes.length === 0 ? command.trim() : prefixes.sort().join(' && ')
}

function isPublishWords(words: readonly ShellWord[]): boolean {
  const first = words[0]
  if (!first) return false
  const name = basename(first.text)
  const args = words.slice(1)
  if (name === 'git') return gitSubcommand(args).sub === 'push'
  if (name !== 'gh' && name !== 'glab') return false
  const a = parseArgs(args)
  const positional = a.positional.map((p) => p.text)
  if (positional[0] === (name === 'gh' ? 'pr' : 'mr')) return true
  if (positional.some((p) => p === 'create' || p === 'merge')) return true
  if (positional[0] === 'api') {
    const method = valueAfter(args, ['-X', '--method'])
    return (
      (method !== null && method.toUpperCase() !== 'GET') ||
      args.some((w) => /^(-[fF]|--field|--raw-field|--input)(=|$)/.test(w.text))
    )
  }
  return false
}

/**
 * Whether a request publishes work: `git push`, anything under `gh pr` or `glab mr`, and any `gh` or
 * `glab` command that creates or merges. Auto-approve never covers these. A command Arc cannot
 * read is also checked as plain text, so `bash -c "git push"` still asks.
 */
export function isPublishAction(toolName: string, input: Record<string, unknown>): boolean {
  const command = input['command']
  if (toolName !== 'Bash' || typeof command !== 'string') return false
  if (/\bgit\b[^\n;|&]*\bpush\b|\b(gh\s+pr|glab\s+mr)\b/.test(command)) return true
  const parsed = parseShell(command, { home: homedir() })
  return parsed.segments.some((segment) => isPublishWords(commandWords(segment.words)))
}
