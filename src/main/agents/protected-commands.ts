/**
 * The commands Arc's classifier protects, as command prefixes: publishing and remote access,
 * network tools, destructive commands and machine-wide installs. Codex gets them as `prompt` rules
 * (`codex/codex-rules.ts`), Cursor as deny entries (`cursor/cursor-deny.ts`).
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

/** Every protected prefix. */
export const PROTECTED_PREFIXES: readonly Prefix[] = [
  ...LEAVES_MACHINE,
  ...NETWORK_TOOLS,
  ...DESTRUCTIVE,
  ...GLOBAL_INSTALLS
]
