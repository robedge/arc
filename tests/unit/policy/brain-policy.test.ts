import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { classifyBrainBash } from '../../../src/main/policy/brain-policy'
import { allowRuleMatches, deriveAllowRule } from '../../../src/main/policy/allow-rules'
import type { ClassifyContext } from '../../../src/main/policy/classify'

/** The brain works in the group's knowledge folder, which is not the temp folder. */
const ctx: ClassifyContext = {
  worktreeRoots: [],
  readOnlyDirs: [],
  cwd: '/srv/arc-knowledge',
  home: '/home/arc-test'
}

const category = (command: string): string | null => classifyBrainBash(command, ctx).category

describe('the brain reads freely', () => {
  it.each([
    'git diff',
    'git -C /Users/me/api diff CLAUDE.md package-lock.json',
    'git diff --stat HEAD~1',
    'git log --oneline -20',
    'git status --porcelain',
    'git show HEAD:package.json',
    'git blame src/index.ts',
    'git branch --list',
    'git branch',
    'git branch -a',
    'git branch --show-current',
    'git rev-parse HEAD',
    'git ls-files',
    'git stash list',
    'git stash show -p',
    'git tag --list',
    'git remote -v',
    'git config --get user.name',
    'git worktree list',
    'git --no-pager log -5',
    'grep -rn TODO src',
    'rg "foo" -n',
    'ls -la',
    'cat package.json',
    'head -20 README.md',
    'tail -n 5 log.txt',
    'wc -l file',
    'find . -name "*.ts" -not -path "./node_modules/*"',
    'jq .name package.json',
    'npm ls --depth=0',
    'npm view left-pad version',
    'pnpm ls',
    'git diff | head -50',
    'cd /Users/me/api && git diff',
    'git log --format=%H | wc -l',
    'git diff > /tmp/arc-brain-out.diff'
  ])('allows %s with no row', (command) => {
    expect(category(command)).toBeNull()
  })
})

describe('the brain asks before changing a checkout', () => {
  it.each([
    'git commit -am x',
    'git commit -m "x"',
    'git checkout main',
    'git switch -c feature',
    'git merge origin/main',
    'git cherry-pick abc123',
    'git stash',
    'git stash pop',
    'git add .',
    'git rm file',
    'git mv a b',
    'git branch feature',
    'git branch -m old new',
    'git tag v1',
    'git worktree add ../wt',
    'git pull',
    'git fetch',
    'git restore file',
    'git restore --staged file',
    'git reset --soft HEAD~1',
    'git -c core.editor=vim log',
    'git diff --output=out.patch',
    'npm install',
    'pnpm install left-pad',
    'npm test',
    'pnpm test:unit',
    "node -e \"require('fs').writeFileSync('x','1')\"",
    "python3 -c \"open('x','w').write('1')\"",
    'echo hi > notes.txt',
    'sed -i s/a/b/ file',
    'mkdir build',
    'touch file',
    'find . -name "*.log" -exec rm {} ;',
    'curl -o out https://example.com'
  ])('%s needs the user (changes_checkout)', (command) => {
    const verdict = classifyBrainBash(command, ctx)
    expect(verdict.category).toBe('changes_checkout')
    expect(verdict.mustEscalate).toBe(true)
    expect(verdict.reason).not.toBe('')
  })

  it('names the command that changes things in the reason', () => {
    expect(classifyBrainBash('git status && git commit -am x', ctx).reason).toContain('git commit')
    expect(classifyBrainBash('npm install left-pad', ctx).reason).toContain('npm install')
  })

  it('writes in the temp folder are fine, writes elsewhere are not', () => {
    expect(category(`mkdir ${join(tmpdir(), 'arc-brain-scratch')}`)).toBeNull()
    expect(category('echo hi > /etc/hosts')).toBe('changes_checkout')
  })
})

describe('the worker categories keep their meaning for the brain', () => {
  it.each([
    ['rm -rf node_modules', 'destructive'],
    ['git reset --hard HEAD~1', 'destructive'],
    ['git rebase main', 'destructive'],
    ['git clean -fd', 'destructive'],
    ['git branch -D feature', 'destructive'],
    ['bash -c "git diff"', 'destructive'],
    ['git push', 'leaves_machine'],
    ['git push origin main', 'leaves_machine'],
    ['gh pr create', 'leaves_machine'],
    ['npm install -g typescript', 'global_install'],
    ['brew install jq', 'global_install']
  ])('%s is %s', (command, expected) => {
    expect(category(command)).toBe(expected)
  })
})

describe('always allow for changes_checkout', () => {
  it('derives a prefix rule that covers the same command kind and nothing else', () => {
    const first = classifyBrainBash('git commit -am x', ctx)
    const rule = deriveAllowRule('Bash', { command: 'git commit -am x' }, first)
    expect(rule).toEqual({
      category: 'changes_checkout',
      tool: 'Bash',
      prefix: 'git commit',
      folder: null
    })
    const same = { command: 'git commit -m other' }
    const other = { command: 'git checkout main' }
    expect(
      allowRuleMatches(rule as never, 'Bash', same, classifyBrainBash(same.command, ctx))
    ).toBe(true)
    expect(
      allowRuleMatches(rule as never, 'Bash', other, classifyBrainBash(other.command, ctx))
    ).toBe(false)
  })
})
