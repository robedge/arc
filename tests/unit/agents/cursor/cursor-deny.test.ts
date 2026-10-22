import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  CURSOR_DENY_RELATIVE_PATH,
  CURSOR_EXCLUDE_ENTRY,
  cursorBrainDenyText,
  cursorDenyText,
  shellDenyEntries,
  writeCursorBrainDeny,
  writeCursorDeny,
  writeDenyEntries
} from '../../../../src/main/agents/cursor/cursor-deny'
import {
  CURSOR_SANDBOX_ENABLED,
  cursorGlobalArgs
} from '../../../../src/main/agents/cursor/cursor-config'
import { createGitFixture, git } from '../../../helpers/git-fixtures'
import type { GitFixture } from '../../../helpers/git-fixtures'

function denyOf(text: string): string[] {
  return (JSON.parse(text) as { permissions: { deny: string[] } }).permissions.deny
}

describe('shellDenyEntries', () => {
  const shell = shellDenyEntries()

  it('denies publishing, merge requests, network tools, global installs and disk tools', () => {
    for (const expected of [
      'Shell(git push)',
      'Shell(gh)',
      'Shell(glab)',
      'Shell(npm publish)',
      'Shell(docker push)',
      'Shell(ssh)',
      'Shell(scp)',
      'Shell(rsync)',
      'Shell(curl)',
      'Shell(wget)',
      'Shell(sudo)',
      'Shell(npm install -g)',
      'Shell(pnpm add --global)',
      'Shell(brew install)',
      'Shell(pip install)',
      'Shell(git clean)',
      'Shell(git filter-branch)',
      'Shell(dd)',
      'Shell(shutdown)'
    ]) {
      expect(shell, expected).toContain(expected)
    }
  })

  it('leaves the argument-dependent commands to the approvals, so a worker can still delete and branch in its own copy', () => {
    for (const command of ['rm', 'git checkout', 'git branch', 'git stash', 'git reset', 'chmod']) {
      expect(shell, command).not.toContain(`Shell(${command})`)
    }
  })

  it('does not repeat a command that a shorter entry already covers', () => {
    expect(shell).toContain('Shell(gh)')
    expect(shell).not.toContain('Shell(gh pr create)')
    expect(new Set(shell).size).toBe(shell.length)
  })
})

describe('writeDenyEntries', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'arc-deny-dirs-')))
  const own = join(root, 'wt', 'w1')
  const other = join(root, 'wt', 'w2')
  const checkout = join(root, 'projects', 'api')
  const knowledge = join(root, 'knowledge')
  for (const dir of [own, other, checkout, knowledge]) mkdirSync(dir, { recursive: true })
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it("lists checkouts, the knowledge folder and other working copies, and never the worker's own", () => {
    const entries = writeDenyEntries([checkout, knowledge, other, own], [own])
    expect(entries).toEqual([
      `Write(${checkout}/**)`,
      `Write(${knowledge}/**)`,
      `Write(${other}/**)`
    ])
  })

  it("leaves out a folder that holds the worker's own working copy", () => {
    expect(writeDenyEntries([join(root, 'wt'), checkout], [own])).toEqual([`Write(${checkout}/**)`])
  })

  it('lists both spellings of a folder that has a symlinked path', () => {
    // macOS: /var/folders/... and /private/var/folders/...
    const entries = writeDenyEntries([tmpdir()], [own])
    expect(entries.length).toBeGreaterThanOrEqual(1)
    expect(entries.every((e) => e.startsWith('Write(') && e.endsWith('/**)'))).toBe(true)
  })
})

describe('cursorDenyText', () => {
  it('holds only `permissions` (Cursor exits on any other key of a project cli.json, spike N6)', () => {
    const parsed = JSON.parse(
      cursorDenyText({ worktree: '/wt/w1', denyDirs: ['/p/api'] })
    ) as Record<string, unknown>
    expect(Object.keys(parsed)).toEqual(['permissions'])
    expect(parsed['permissions']).toMatchObject({ allow: [] })
  })

  it('is stable, so a relaunch rewrites the same file', () => {
    const options = { worktree: '/wt/w1', denyDirs: ['/p/api', '/k'] }
    expect(cursorDenyText(options)).toBe(cursorDenyText(options))
  })

  it("has Cursor's sandbox off by default, behind one switch that adds the flag before `acp`", () => {
    expect(CURSOR_SANDBOX_ENABLED).toBe(false)
    expect(cursorGlobalArgs()).toEqual([])
    expect(cursorGlobalArgs(true)).toEqual(['--sandbox', 'enabled'])
  })
})

describe('writeCursorDeny', () => {
  let repo: GitFixture
  let scratch: string
  let worktree: string
  let sibling: string
  const checkout = (): string => repo.path

  beforeAll(() => {
    repo = createGitFixture({ kind: 'clean' })
    scratch = realpathSync(mkdtempSync(join(tmpdir(), 'arc-deny-wt-')))
    worktree = join(scratch, 'w1')
    sibling = join(scratch, 'w2')
    git(repo.path, 'worktree', 'add', '-b', 'arc/w1', worktree)
    git(repo.path, 'worktree', 'add', '-b', 'arc/w2', sibling)
  })
  afterAll(() => {
    repo.cleanup()
    rmSync(scratch, { recursive: true, force: true })
  })

  const commonExclude = (): string => join(repo.path, '.git', 'info', 'exclude')
  const knowledge = (): string => join(scratch, 'knowledge')

  it('writes the protected commands and a Write deny for the checkout, the knowledge folder and the other working copy', () => {
    const result = writeCursorDeny({
      worktree,
      denyDirs: [checkout(), knowledge(), sibling, worktree]
    })
    expect(result).toEqual({ written: true })
    const deny = denyOf(readFileSync(join(worktree, CURSOR_DENY_RELATIVE_PATH), 'utf8'))
    expect(deny).toContain('Shell(git push)')
    expect(deny).toContain('Shell(gh)')
    expect(deny).toContain('Shell(curl)')
    expect(deny).toContain(`Write(${realpathSync(checkout())}/**)`)
    expect(deny).toContain(`Write(${knowledge()}/**)`)
    expect(deny).toContain(`Write(${sibling}/**)`)
    // the worker's own working copy is never denied
    expect(deny.filter((d) => d.includes(worktree))).toEqual([])
  })

  it("keeps the file out of git status and commits, via the repository's shared info/exclude", () => {
    writeCursorDeny({ worktree, denyDirs: [checkout()] })
    expect(readFileSync(commonExclude(), 'utf8').split('\n')).toContain(CURSOR_EXCLUDE_ENTRY)
    expect(git(worktree, 'status', '--short')).toBe('')
    expect(git(worktree, 'check-ignore', '-v', CURSOR_DENY_RELATIVE_PATH)).toContain('info/exclude')
    writeFileSync(join(worktree, 'feature.ts'), 'export {}\n')
    git(worktree, 'add', '-A')
    git(worktree, 'commit', '-m', 'work')
    expect(git(worktree, 'show', '--name-only', '--format=', 'HEAD').trim()).toBe('feature.ts')
    expect(git(repo.path, 'status', '--short')).toBe('')
  })

  it("does not hide other .cursor files, so a worker's new rules still show up as changes", () => {
    writeCursorDeny({ worktree, denyDirs: [checkout()] })
    mkdirSync(join(worktree, '.cursor', 'rules'), { recursive: true })
    writeFileSync(join(worktree, '.cursor', 'rules', 'style.mdc'), 'be tidy\n')
    expect(git(worktree, 'status', '--short', '-uall')).toContain('.cursor/rules/style.mdc')
  })

  it('is idempotent and refreshes the file when the set of folders changes', () => {
    writeCursorDeny({ worktree, denyDirs: [checkout()] })
    writeCursorDeny({ worktree, denyDirs: [checkout()] })
    const lines = readFileSync(commonExclude(), 'utf8')
      .split('\n')
      .filter((l) => l === CURSOR_EXCLUDE_ENTRY)
    expect(lines).toHaveLength(1)
    writeCursorDeny({ worktree, denyDirs: [checkout(), sibling] })
    const deny = denyOf(readFileSync(join(worktree, CURSOR_DENY_RELATIVE_PATH), 'utf8'))
    expect(deny).toContain(`Write(${sibling}/**)`)
  })

  it("leaves a repository's own committed .cursor/cli.json alone and says so", () => {
    const committed = join(scratch, 'w3')
    git(repo.path, 'worktree', 'add', '-b', 'arc/w3', committed)
    mkdirSync(join(committed, '.cursor'), { recursive: true })
    const own = '{"permissions":{"allow":["Shell(ls)"],"deny":[]}}\n'
    writeFileSync(join(committed, CURSOR_DENY_RELATIVE_PATH), own)
    // the shared exclude covers this name from the earlier tests, so the repository's own file is forced in
    git(committed, 'add', '-f', CURSOR_DENY_RELATIVE_PATH)
    git(committed, 'commit', '-m', 'project cursor config')

    const result = writeCursorDeny({ worktree: committed, denyDirs: [checkout()] })

    expect(result).toEqual({ written: false, reason: 'committed' })
    expect(readFileSync(join(committed, CURSOR_DENY_RELATIVE_PATH), 'utf8')).toBe(own)
    expect(git(committed, 'status', '--short')).toBe('')
  })
})

describe('the Cursor brain deny file', () => {
  it('denies every write, carries only `permissions`, and is rewritten idempotently', () => {
    const folder = mkdtempSync(join(tmpdir(), 'arc-brain-deny-'))
    try {
      writeCursorBrainDeny(folder)
      writeCursorBrainDeny(folder)
      const text = readFileSync(join(folder, CURSOR_DENY_RELATIVE_PATH), 'utf8')
      expect(text).toBe(cursorBrainDenyText())
      expect(JSON.parse(text)).toEqual({ permissions: { allow: [], deny: ['Write(**)'] } })
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })

  it('throws when the file cannot be written, so the brain does not start', () => {
    const folder = mkdtempSync(join(tmpdir(), 'arc-brain-deny-'))
    try {
      writeFileSync(join(folder, '.cursor'), 'in the way')
      expect(() => writeCursorBrainDeny(folder)).toThrow()
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })
})
