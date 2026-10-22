import { describe, expect, it } from 'vitest'
import { GitError, assertGitAllowed } from '../../../src/main/git/git'

const SHA = 'a'.repeat(40)

describe('git allowlist: restoring paths from a commit (Undo changes)', () => {
  it('accepts checkout <40-hex sha> -- <path>...', () => {
    for (const args of [
      ['checkout', SHA, '--', 'src/a.ts'],
      ['checkout', '0123456789abcdef0123456789abcdef01234567', '--', 'a.txt', 'dir/b.txt'],
      ['checkout', SHA, '--', ':(literal)src/[id].ts']
    ]) {
      expect(() => assertGitAllowed(args)).not.toThrow()
    }
  })

  it('still refuses every other checkout and switch form that discards changes', () => {
    for (const args of [
      ['checkout', 'abc1234', '--', 'a.txt'], // short sha
      ['checkout', 'A'.repeat(40), '--', 'a.txt'], // upper case
      ['checkout', 'main', '--', 'a.txt'], // branch name
      ['checkout', 'HEAD', '--', 'a.txt'],
      ['checkout', SHA, '--'], // no path
      ['checkout', '--', 'a.txt'],
      ['checkout', '-f', SHA, '--', 'a.txt'],
      ['checkout', SHA, '-f', '--', 'a.txt'],
      ['checkout', '--force', SHA, '--', 'a.txt'],
      ['checkout', '--discard-changes', SHA, '--', 'a.txt'],
      ['checkout', '--ours', SHA, '--', 'a.txt'], // extra flag
      ['checkout', '-b', 'x', SHA, '--', 'a.txt'],
      ['checkout', SHA, '--', 'a.txt', '--', 'b.txt'],
      ['checkout', SHA, '--', ''],
      ['checkout', '-f', 'main'],
      ['switch', '-f', 'main'],
      ['switch', '--discard-changes', 'main'],
      ['switch', SHA, '--', 'a.txt'],
      ['switch', '--', 'a.txt']
    ]) {
      expect(() => assertGitAllowed(args), args.join(' ')).toThrow(GitError)
    }
  })
})
