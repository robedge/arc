import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { createGitFixture, git, type GitFixture } from '../helpers/git-fixtures'

const made: GitFixture[] = []
function make(kind: Parameters<typeof createGitFixture>[0]): GitFixture {
  const f = createGitFixture(kind)
  made.push(f)
  return f
}
afterEach(() => {
  for (const f of made.splice(0)) f.cleanup()
})

describe('git fixtures', () => {
  it('clean repo is on dev with one fixed commit and nothing to commit', () => {
    const f = make({ kind: 'clean' })
    expect(f.path.startsWith(tmpdir())).toBe(true)
    expect(git(f.path, 'branch', '--show-current').trim()).toBe('dev')
    expect(git(f.path, 'status', '--porcelain')).toBe('')
    expect(git(f.path, 'rev-list', '--count', 'HEAD').trim()).toBe('1')
    expect(git(f.path, 'log', '-1', '--format=%an <%ae> %cn <%ce> %aI').trim()).toBe(
      'Arc Test <arc-test@example.com> Arc Test <arc-test@example.com> 2026-01-01T00:00:00Z'
    )
  })

  it('defaults to the clean variant', () => {
    expect(git(make({}).path, 'branch', '--show-current').trim()).toBe('dev')
  })

  it('dirty repo has a modified tracked file and an untracked file', () => {
    const f = make({ kind: 'dirty' })
    expect(git(f.path, 'branch', '--show-current').trim()).toBe('dev')
    expect(git(f.path, 'status', '--porcelain').split('\n').filter(Boolean).sort()).toEqual([
      ' M README.md',
      '?? untracked.txt'
    ])
  })

  it('no-dev repo is on main and has no dev branch', () => {
    const f = make({ kind: 'no-dev' })
    expect(git(f.path, 'branch', '--show-current').trim()).toBe('main')
    expect(git(f.path, 'branch', '--list', 'dev').trim()).toBe('')
  })

  it('plain folder exists but is not a git repo', () => {
    const f = make({ kind: 'plain' })
    expect(existsSync(f.path)).toBe(true)
    expect(() => git(f.path, 'rev-parse', '--git-dir')).toThrow()
  })

  it('cleanup removes the directory and may be called twice', () => {
    const f = createGitFixture()
    f.cleanup()
    expect(existsSync(f.path)).toBe(false)
    expect(() => f.cleanup()).not.toThrow()
  })
})
