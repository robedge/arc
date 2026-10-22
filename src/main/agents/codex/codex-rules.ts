import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { gitDirsOf } from './codex-config'

/**
 * `<worktree>/.codex/rules/arc.rules`: `prompt` rules for the commands Arc's classifier protects
 * (tech spec section 5, spike S2). Codex skips both its approval and its sandbox for a command that
 * a rule in the user's own `~/.codex/rules` allows, and the app-server cannot be told to ignore
 * rules. A `prompt` rule beats an `allow` rule and loads without the project being trusted, so a
 * Codex worker still asks Arc before it pushes, deletes, installs globally or reaches the network,
 * whatever the user's own rules say. Arc then decides, with its classifier, whether anyone is asked.
 *
 * A pattern element is a word or a list of alternative words. Prefix rules cannot express every
 * case (a `cp` to a path outside the working copy has no prefix of its own); those rely on the
 * sandbox and on the classifier.
 */
export type Word = string | readonly string[]
export type Prefix = readonly Word[]

const NPM_LIKE = ['npm', 'pnpm', 'yarn', 'bun']
const GLOBAL_FLAGS = ['-g', '--global']
const PACKAGE_SUBCOMMANDS = [
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
]

/** Publishing and anything that talks to a remote machine or service. */
export const LEAVES_MACHINE: readonly Prefix[] = [
  ['git', 'push'],
  ['git', 'send-email'],
  ['git', 'remote', ['add', 'set-url']],
  ['gh'],
  ['gh', 'pr'],
  ['gh', 'pr', 'create'],
  ['gh', 'pr', 'merge'],
  ['glab'],
  ['glab', 'mr'],
  [['docker', 'podman'], 'push'],
  [['docker', 'podman'], 'image', 'push'],
  [NPM_LIKE, ['publish', 'unpublish', 'deprecate']],
  ['cargo', 'publish'],
  ['gem', 'push'],
  ['twine']
]

/** Network tools. Arc's classifier lets the ones that only download run; the rest ask. */
export const NETWORK_TOOLS: readonly Prefix[] = [
  [['ssh', 'scp', 'sftp', 'ssh-copy-id', 'rsync', 'curl', 'wget', 'nc', 'ncat', 'telnet', 'ftp']]
]

/** Commands that delete or overwrite work, or stop the machine. */
export const DESTRUCTIVE: readonly Prefix[] = [
  ['rm'],
  ['git', 'reset'],
  ['git', 'clean'],
  ['git', 'checkout'],
  ['git', 'restore'],
  ['git', 'branch'],
  ['git', 'tag'],
  ['git', 'stash'],
  ['git', 'rebase'],
  ['git', 'worktree'],
  ['git', ['filter-branch', 'filter-repo', 'reflog', 'gc', 'update-ref']],
  ['git', 'config'],
  [['chmod', 'chown', 'chgrp', 'truncate', 'dd', 'shred', 'mkfs']],
  [['fdisk', 'parted', 'diskutil', 'shutdown', 'reboot', 'halt', 'poweroff']]
]

/** Installs that change the whole machine. */
export const GLOBAL_INSTALLS: readonly Prefix[] = [
  [['sudo', 'doas']],
  [NPM_LIKE, PACKAGE_SUBCOMMANDS, GLOBAL_FLAGS],
  [NPM_LIKE, GLOBAL_FLAGS],
  ['yarn', 'global'],
  ['brew', ['install', 'reinstall', 'upgrade', 'tap', 'untap', 'uninstall', 'remove', 'cask']],
  [['pip', 'pip3'], 'install'],
  [['python', 'python3'], '-m', 'pip'],
  ['pipx', 'install'],
  ['uv', 'tool', 'install'],
  ['uv', 'pip', 'install'],
  [['go', 'cargo', 'gem'], 'install'],
  ['rustup'],
  [
    [
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
    ]
  ]
]

/** Every prefix Arc makes Codex ask about. */
export const PROTECTED_PREFIXES: readonly Prefix[] = [
  ...LEAVES_MACHINE,
  ...NETWORK_TOOLS,
  ...DESTRUCTIVE,
  ...GLOBAL_INSTALLS
]

/** The rules file, one `prompt` rule per protected prefix. */
export function arcRulesText(): string {
  const lines = [
    '# Written by Arc each time it starts this working copy. Edits are overwritten.',
    '# These rules make Codex ask Arc before a protected command, even where your own rules allow it.',
    ...PROTECTED_PREFIXES.map(
      (prefix) => `prefix_rule(pattern=${JSON.stringify(prefix)}, decision="prompt")`
    )
  ]
  return lines.join('\n') + '\n'
}

/** Where the rules live inside a working copy. */
export const ARC_RULES_RELATIVE_PATH = join('.codex', 'rules', 'arc.rules')

/** The line that keeps the rules file out of commits and out of Review changes. */
export const EXCLUDE_LINE = '.codex/'

/**
 * Git reads `info/exclude` from the repository's common directory only: the file under
 * `worktrees/<id>/info/` that one might expect is ignored. So the line goes into the common file,
 * which also covers every other working copy of that repository. It never touches a tracked file.
 */
export function excludeFromGit(worktree: string, entry: string): void {
  const dirs = gitDirsOf(worktree)
  if (!dirs) return
  const file = join(dirs.common, 'info', 'exclude')
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : ''
  const bare = entry.replace(/\/$/, '')
  const covered = existing
    .split('\n')
    .some((line) => [bare, `${bare}/`, `/${bare}`, `/${bare}/`].includes(line.trim()))
  if (covered) return
  mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, `${existing === '' || existing.endsWith('\n') ? '' : '\n'}${entry}\n`)
}

/**
 * Writes `arc.rules` into a working copy and excludes it from git. Idempotent: a launch and a
 * relaunch both call it. It throws when the file cannot be written, so a worker never starts
 * without Arc's rules.
 */
export function writeArcRules(worktree: string): void {
  const file = join(worktree, ARC_RULES_RELATIVE_PATH)
  const text = arcRulesText()
  mkdirSync(dirname(file), { recursive: true })
  if (!existsSync(file) || readFileSync(file, 'utf8') !== text) writeFileSync(file, text)
  excludeFromGit(worktree, EXCLUDE_LINE)
}
