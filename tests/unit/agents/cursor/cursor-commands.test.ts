import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { CommandCatalogue } from '../../../../src/main/agents/command-probe'
import { CursorCommands } from '../../../../src/main/agents/cursor/cursor-commands'
import {
  availableCommandsSchema,
  type CursorCommand
} from '../../../../src/main/agents/cursor/cursor-types'
import type {
  ProviderState,
  ProviderStatus,
  ProviderStatusMap
} from '../../../../src/shared/types/provider'
import { useTempDir } from '../../helpers/temp-dir'
import { readFixture } from './fixtures'

const dir = useTempDir('arc-cursor-commands-')

function write(path: string, text: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}

interface Rig {
  commands: CursorCommands
  home: string
  repo: string
  probe: { list: CursorCommand[] }
  state: { value: ProviderState | undefined }
  clock: { now: number }
}

function rig(list: CursorCommand[] = []): Rig {
  const home = join(dir(), 'home')
  const repo = join(dir(), 'repo')
  mkdirSync(repo, { recursive: true })
  const probe = { list }
  const state: Rig['state'] = { value: 'ok' }
  const clock = { now: 1000 }
  const status = (): ProviderStatusMap =>
    state.value === undefined
      ? {}
      : {
          cursor: {
            provider: 'cursor',
            state: state.value,
            message: '',
            checkedAt: 1
          } as ProviderStatus
        }
  const commands = new CursorCommands({
    probe: { lastCommands: () => probe.list },
    status,
    home: () => home,
    now: () => clock.now
  })
  return { commands, home, repo, probe, state, clock }
}

describe('CursorCommands.list', () => {
  it('lists command and skill files of the user and the project, marked cursor', async () => {
    const r = rig()
    write(join(r.home, '.cursor', 'commands', 'review.md'), 'Review the diff.\n\nMore.')
    write(
      join(r.repo, '.cursor', 'commands', 'shout.md'),
      '---\ndescription: Shout it\nargument-hint: <word>\n---\nbody'
    )
    write(join(r.home, '.cursor', 'skills', 'deploy', 'SKILL.md'), '---\nname: other\n---\nDeploy.')
    write(join(r.repo, '.cursor', 'skills', 'lint', 'SKILL.md'), '# Lint\nRun the linter.')
    write(join(r.repo, '.cursor', 'commands', 'notes.txt'), 'not a command')

    const list = await r.commands.list([r.repo])

    expect(list.map((c) => [c.id, c.kind, c.description])).toEqual([
      ['cursor:deploy', 'skill', 'Deploy.'],
      ['cursor:lint', 'skill', 'Lint'],
      ['cursor:review', 'command', 'Review the diff.'],
      ['cursor:shout', 'command', 'Shout it']
    ])
    expect(list.every((c) => c.source === 'cursor' && c.provider === 'cursor')).toBe(true)
    expect(list.find((c) => c.name === 'shout')?.argumentHint).toBe('<word>')
  })

  it('lets the description from available_commands_update win, without its (user)/(project) suffix', async () => {
    const r = rig([
      { name: 'review', description: 'Review a branch (global)' },
      { name: 'shout', description: 'Shout it (project)' }
    ])
    write(join(r.home, '.cursor', 'commands', 'review.md'), 'from the file')
    write(join(r.repo, '.cursor', 'commands', 'shout.md'), 'from the file too')
    const list = await r.commands.list([r.repo])
    expect(list.map((c) => c.description)).toEqual(['Review a branch', 'Shout it'])
  })

  it('drops probe entries that have no Cursor-owned file: the Claude and Codex skills Cursor also loads', async () => {
    const r = rig([
      { name: 'shout', description: 'Shout it (project)' },
      { name: 'user-claude-skill', description: 'A Claude skill (user)' },
      { name: 'codex-skill', description: 'A Codex skill (global)' },
      { name: 'copy-request-id', description: 'Copy the last request ID' }
    ])
    write(join(r.repo, '.cursor', 'commands', 'shout.md'), 'x')
    const list = await r.commands.list([r.repo])
    expect(list.map((c) => c.name)).toEqual(['shout'])
  })

  it('lets a project file win over the user file of the same name, and follows a symlinked skill', async () => {
    const r = rig()
    write(join(r.home, '.cursor', 'commands', 'dup.md'), 'user one')
    write(join(r.repo, '.cursor', 'commands', 'dup.md'), 'project one')
    write(join(dir(), 'shared', 'xirp', 'SKILL.md'), 'Manage sessions.')
    mkdirSync(join(r.home, '.cursor', 'skills'), { recursive: true })
    symlinkSync(join(dir(), 'shared', 'xirp'), join(r.home, '.cursor', 'skills', 'xirp'))
    const list = await r.commands.list([r.repo])
    expect(list.map((c) => [c.name, c.description])).toEqual([
      ['dup', 'project one'],
      ['xirp', 'Manage sessions.']
    ])
  })

  it.each<[ProviderState | undefined]>([['signed_out'], ['missing'], ['error'], [undefined]])(
    'lists nothing while Cursor is %s',
    async (state) => {
      const r = rig()
      write(join(r.repo, '.cursor', 'commands', 'shout.md'), 'x')
      r.state.value = state
      expect(await r.commands.list([r.repo])).toEqual([])
    }
  )

  it('reads the files again only after the ttl, on refresh or after invalidate (Check again)', async () => {
    const r = rig()
    write(join(r.repo, '.cursor', 'commands', 'one.md'), 'x')
    expect((await r.commands.list([r.repo])).map((c) => c.name)).toEqual(['one'])
    write(join(r.repo, '.cursor', 'commands', 'two.md'), 'x')
    expect((await r.commands.list([r.repo])).map((c) => c.name)).toEqual(['one'])
    r.commands.invalidate()
    expect((await r.commands.list([r.repo])).map((c) => c.name)).toEqual(['one', 'two'])
    write(join(r.repo, '.cursor', 'commands', 'three.md'), 'x')
    expect(await r.commands.list([r.repo], true)).toHaveLength(3)
    write(join(r.repo, '.cursor', 'commands', 'four.md'), 'x')
    r.clock.now += 61_000
    expect(await r.commands.list([r.repo])).toHaveLength(4)
  })

  it('picks up new probe descriptions at once (they are read on every list)', async () => {
    const r = rig()
    write(join(r.repo, '.cursor', 'commands', 'shout.md'), 'file text')
    expect((await r.commands.list([r.repo]))[0]?.description).toBe('file text')
    r.probe.list = [{ name: 'shout', description: 'probe text (project)' }]
    expect((await r.commands.list([r.repo]))[0]?.description).toBe('probe text')
  })

  it('reads the recorded M5 available_commands_update: only the file-backed shout survives', async () => {
    const update = readFixture('m5-command-turn.jsonl')
      .map((l) => l.msg?.['params'] as { update?: Record<string, unknown> } | undefined)
      .find((p) => p?.update?.['sessionUpdate'] === 'available_commands_update')?.update
    const parsed = availableCommandsSchema.parse(update)
    const names = parsed.availableCommands.map((c) => c.name)
    expect(names).toContain('shout')
    const r = rig(
      parsed.availableCommands.map((c) => ({ name: c.name, description: c.description ?? '' }))
    )
    write(join(r.repo, '.cursor', 'commands', 'shout.md'), 'Reply with something.')
    const list = await r.commands.list([r.repo])
    expect(list.map((c) => c.name)).toEqual(['shout'])
    expect(list[0]?.description).toBe(
      'Reply with the word given as the argument in upper case, prefixed with "SHOUT: " and nothing else.'
    )
  })
})

describe('CommandCatalogue with Cursor', () => {
  const noProbe = { run: vi.fn(() => Promise.resolve([])) }

  it('appends the Cursor entries after the Codex ones and passes refresh through', async () => {
    const r = rig()
    write(join(r.repo, '.cursor', 'commands', 'shout.md'), 'x')
    const cursor = {
      list: vi.fn((cwds: readonly string[], refresh: boolean) => r.commands.list(cwds, refresh))
    }
    const codexEntry = {
      id: 'codex:zzz',
      name: 'zzz',
      description: '',
      source: 'codex' as const,
      provider: 'codex' as const,
      kind: 'skill' as const
    }
    const catalogue = new CommandCatalogue({
      probe: noProbe,
      getViewDir: () => Promise.resolve(undefined),
      codex: { list: () => Promise.resolve([codexEntry]) },
      cursor
    })
    const request = { repos: [{ name: 'repo', path: r.repo }], fallbackCwd: dir() }
    const list = await catalogue.list(request)
    expect(list.map((c) => c.id)).toEqual(['codex:zzz', 'cursor:shout'])
    await catalogue.list({ ...request, refresh: true })
    expect(cursor.list).toHaveBeenLastCalledWith([r.repo], true)
  })

  it('leaves Cursor out when its list fails, and still fails when nothing at all can be listed', async () => {
    const warn = vi.fn()
    const failing = { list: () => Promise.reject(new Error('boom')) }
    const base = {
      probe: { run: () => Promise.reject(new Error('no claude')) },
      getViewDir: () => Promise.resolve(undefined),
      log: { warn }
    }
    const request = { repos: [], fallbackCwd: dir() }
    await expect(new CommandCatalogue({ ...base, cursor: failing }).list(request)).rejects.toThrow()
    const codex = {
      list: () =>
        Promise.resolve([
          {
            id: 'codex:a',
            name: 'a',
            description: '',
            source: 'codex',
            provider: 'codex',
            kind: 'skill'
          } as const
        ])
    }
    const list = await new CommandCatalogue({ ...base, codex, cursor: failing }).list(request)
    expect(list.map((c) => c.id)).toEqual(['codex:a'])
    expect(warn).toHaveBeenCalledWith('could not list the Cursor commands', expect.any(Error))
  })
})

describe('CursorCommands.resolve', () => {
  it('expands a command file: front matter stripped, $ARGUMENTS applied, under a line naming the command', async () => {
    const r = rig()
    write(
      join(r.home, '.cursor', 'commands', 'review.md'),
      '---\ndescription: Review a change\n---\nReview this change carefully: $ARGUMENTS\n'
    )
    const run = await r.commands.resolve('review', 'the retry change', [r.repo])
    expect(run).toEqual({
      ok: true,
      text: 'Running the Cursor command /review.\n\nReview this change carefully: the retry change\n'
    })
  })

  it('appends the arguments when the body has no placeholder, and adds nothing when there are none', async () => {
    const r = rig()
    write(join(r.repo, '.cursor', 'commands', 'shout.md'), 'Reply in upper case.\n')
    expect(await r.commands.resolve('shout', 'banana', [r.repo])).toEqual({
      ok: true,
      text: 'Running the Cursor command /shout.\n\nReply in upper case.\n\nArguments: banana'
    })
    expect(await r.commands.resolve('shout', '', [r.repo])).toEqual({
      ok: true,
      text: 'Running the Cursor command /shout.\n\nReply in upper case.\n'
    })
  })

  it('expands a skill from its SKILL.md and fills positional placeholders', async () => {
    const r = rig()
    write(
      join(r.repo, '.cursor', 'skills', 'deploy', 'SKILL.md'),
      '---\nname: x\n---\nDeploy $1 to $2.'
    )
    const run = await r.commands.resolve('deploy', 'api prod', [r.repo])
    expect(run).toEqual({
      ok: true,
      text: 'Running the Cursor command /deploy.\n\nDeploy api to prod.'
    })
  })

  it('fails with a reason when the file is gone at run time, or the name is unknown, or a KEY is missing', async () => {
    const r = rig()
    const file = join(r.repo, '.cursor', 'commands', 'gone.md')
    write(file, 'body')
    write(join(r.repo, '.cursor', 'commands', 'keyed.md'), 'Branch $BRANCH')
    await r.commands.list([r.repo])
    rmSync(file)
    expect(await r.commands.resolve('gone', '', [r.repo])).toMatchObject({
      ok: false,
      code: 'command_unreadable'
    })
    expect(await r.commands.resolve('nope', '', [r.repo])).toMatchObject({
      ok: false,
      code: 'unknown_command'
    })
    expect(await r.commands.resolve('keyed', '', [r.repo])).toMatchObject({
      ok: false,
      code: 'command_args_invalid'
    })
  })
})
