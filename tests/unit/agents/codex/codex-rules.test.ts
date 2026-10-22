import { execFileSync, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ARC_RULES_RELATIVE_PATH,
  EXCLUDE_LINE,
  PROTECTED_PREFIXES,
  arcRulesText,
  writeArcRules
} from '../../../../src/main/agents/codex/codex-rules'
import { createGitFixture, git, trackedFile } from '../../../helpers/git-fixtures'
import type { GitFixture } from '../../../helpers/git-fixtures'

describe('arcRulesText', () => {
  const text = arcRulesText()
  const rules = text.split('\n').filter((l) => l.startsWith('prefix_rule('))

  it('is one prompt rule per protected prefix and nothing that allows or forbids', () => {
    expect(rules).toHaveLength(PROTECTED_PREFIXES.length)
    expect(rules.every((r) => r.endsWith('decision="prompt")'))).toBe(true)
    expect(text).not.toMatch(/decision="(allow|forbidden)"/)
  })

  it('covers publishing, merge requests, destructive commands, global installs and network tools', () => {
    for (const expected of [
      '["git","push"]',
      '["gh","pr","create"]',
      '["gh","pr","merge"]',
      '["glab","mr"]',
      '["rm"]',
      '["git","reset"]',
      '["git","clean"]',
      '["git","checkout"]',
      '["git","restore"]',
      '[["npm","pnpm","yarn","bun"],["install","i"',
      '["brew",["install"',
      '[["pip","pip3"],"install"]',
      '"ssh"',
      '"scp"',
      '"rsync"',
      '"curl"',
      '"wget"'
    ]) {
      expect(text, expected).toContain(expected)
    }
  })

  it('is stable, so a relaunch rewrites the same file', () => {
    expect(arcRulesText()).toBe(text)
  })
})

describe('writeArcRules', () => {
  let repo: GitFixture
  let worktree: string
  let scratch: string

  beforeAll(() => {
    repo = createGitFixture({ kind: 'clean' })
    scratch = realpathSync(mkdtempSync(join(tmpdir(), 'arc-rules-wt-')))
    worktree = join(scratch, 'w1')
    git(repo.path, 'worktree', 'add', '-b', 'arc/w1', worktree)
  })
  afterAll(() => {
    repo.cleanup()
    rmSync(scratch, { recursive: true, force: true })
  })

  const commonExclude = (): string => join(repo.path, '.git', 'info', 'exclude')

  it('writes the rules file into the working copy', () => {
    writeArcRules(worktree)
    expect(readFileSync(join(worktree, ARC_RULES_RELATIVE_PATH), 'utf8')).toBe(arcRulesText())
  })

  it('keeps the rules out of git status, out of commits and out of the main checkout', () => {
    writeArcRules(worktree)
    // the exclude file git actually reads for a linked worktree is the repository's common one
    expect(git(worktree, 'rev-parse', '--git-path', 'info/exclude').trim()).toBe(
      realpathSync(commonExclude())
    )
    expect(readFileSync(commonExclude(), 'utf8').split('\n')).toContain(EXCLUDE_LINE)
    expect(git(worktree, 'status', '--short')).toBe('')
    expect(git(worktree, 'check-ignore', '-v', ARC_RULES_RELATIVE_PATH)).toContain('info/exclude')

    // a worker that commits everything does not commit the rules
    writeFileSync(join(worktree, 'feature.ts'), 'export {}\n')
    git(worktree, 'add', '-A')
    git(worktree, 'commit', '-m', 'work')
    expect(git(worktree, 'show', '--name-only', '--format=', 'HEAD').trim()).toBe('feature.ts')
    // nothing was added to the user's main checkout, tracked or not
    expect(git(repo.path, 'status', '--short')).toBe('')
    expect(existsSync(join(repo.path, '.codex'))).toBe(false)
    expect(git(repo.path, 'ls-files').split('\n')).not.toContain('.codex/rules/arc.rules')
    expect(git(repo.path, 'ls-files')).toContain(trackedFile)
  })

  it('is idempotent: a relaunch changes nothing and does not repeat the exclude line', () => {
    writeArcRules(worktree)
    writeArcRules(worktree)
    const lines = readFileSync(commonExclude(), 'utf8')
      .split('\n')
      .filter((l) => l === EXCLUDE_LINE)
    expect(lines).toHaveLength(1)
  })

  it('puts the rules back after they were deleted or edited', () => {
    const file = join(worktree, ARC_RULES_RELATIVE_PATH)
    writeFileSync(file, 'prefix_rule(pattern=["git","push"], decision="allow")\n')
    writeArcRules(worktree)
    expect(readFileSync(file, 'utf8')).toBe(arcRulesText())
    rmSync(file)
    writeArcRules(worktree)
    expect(existsSync(file)).toBe(true)
  })

  it('keeps an exclude file the user already has, adding its line on a fresh one', () => {
    const other = createGitFixture({ kind: 'clean' })
    try {
      const exclude = join(other.path, '.git', 'info', 'exclude')
      mkdirSync(join(other.path, '.git', 'info'), { recursive: true })
      writeFileSync(exclude, '*.log')
      writeArcRules(other.path)
      expect(readFileSync(exclude, 'utf8')).toBe(`*.log\n${EXCLUDE_LINE}\n`)
    } finally {
      other.cleanup()
    }
  })

  it('writes the rules in a folder that is not a git working copy and leaves git alone', () => {
    const plain = createGitFixture({ kind: 'plain' })
    try {
      writeArcRules(plain.path)
      expect(existsSync(join(plain.path, ARC_RULES_RELATIVE_PATH))).toBe(true)
    } finally {
      plain.cleanup()
    }
  })
})

// The real Codex parser and matcher, when this machine has it (`codex execpolicy check` makes no model call).
const hasCodex = spawnSync('codex', ['--version']).status === 0
describe.skipIf(!hasCodex)('arc.rules in the real Codex execpolicy', () => {
  let scratch: string
  beforeAll(() => {
    scratch = realpathSync(mkdtempSync(join(tmpdir(), 'arc-rules-codex-')))
    writeFileSync(join(scratch, 'arc.rules'), arcRulesText())
    // what the user's own rules might allow
    writeFileSync(
      join(scratch, 'user.rules'),
      [
        'git push',
        'git commit',
        'gh pr create',
        'ssh',
        'curl -L',
        'rm',
        'npm install',
        'rsync',
        'git status'
      ]
        .map((p) => `prefix_rule(pattern=${JSON.stringify(p.split(' '))}, decision="allow")`)
        .join('\n')
    )
  })
  afterAll(() => rmSync(scratch, { recursive: true, force: true }))

  const decision = (...command: string[]): string | undefined => {
    const out = execFileSync(
      'codex',
      [
        'execpolicy',
        'check',
        '--rules',
        join(scratch, 'user.rules'),
        '--rules',
        join(scratch, 'arc.rules'),
        '--',
        ...command
      ],
      { encoding: 'utf8' }
    )
    return (JSON.parse(out) as { decision?: string }).decision
  }

  it.each([
    ['git', 'push', 'origin', 'HEAD'],
    ['gh', 'pr', 'create', '--fill'],
    ['gh', 'pr', 'merge', '12'],
    ['glab', 'mr', 'create'],
    ['rm', '-rf', 'dist'],
    ['git', 'reset', '--hard'],
    ['git', 'clean', '-fd'],
    ['npm', 'install', '-g', 'left-pad'],
    ['npm', 'i', '--global', 'left-pad'],
    ['brew', 'install', 'jq'],
    ['pip', 'install', '--user', 'x'],
    ['ssh', 'host'],
    ['scp', 'a', 'h:b'],
    ['rsync', '-av', 'a', 'h:b'],
    ['curl', '-L', 'https://example.com'],
    ['wget', 'https://example.com']
  ])('prompts for %s even where the user allows it', (...command) => {
    expect(decision(...command)).toBe('prompt')
  })

  it('leaves the rest to the user and Codex: nothing in Arc rules matches git commit or git status', () => {
    expect(decision('git', 'commit', '-m', 'x')).toBe('allow')
    expect(decision('git', 'status')).toBe('allow')
    expect(decision('ls', '-la')).toBeUndefined()
  })
})
