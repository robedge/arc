import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CommandCatalogue } from '../../../src/main/agents/command-probe'
import { useTempDir } from '../helpers/temp-dir'
import { makeRig } from './helpers'
import type { Rig } from './helpers'

const dir = useTempDir('arc-sessions-')
let rig: Rig

afterEach(() => rig.close())

describe('SessionService commands', () => {
  it('fails with SESSION_NOT_FOUND for an unknown session', async () => {
    rig = await makeRig(dir(), { commands: { list: vi.fn() } })
    await expect(rig.service.listCommands('nope', false)).rejects.toMatchObject({
      code: 'SESSION_NOT_FOUND'
    })
    await expect(rig.service.listCommands('nope', true)).rejects.toMatchObject({
      code: 'SESSION_NOT_FOUND'
    })
  })

  it('asks the catalogue with the active repositories of the session', async () => {
    const list = vi.fn<CommandCatalogue['list']>(() =>
      Promise.resolve([
        {
          id: 'claude:' + 'user:x',
          provider: 'claude',
          kind: 'command',
          name: 'user:x',
          description: 'X',
          source: 'user'
        }
      ])
    )
    rig = await makeRig(dir(), { commands: { list } })
    const created = await rig.service.create(rig.groupId, 'Plan it', 'plan_first', 3)
    if (!('sessionId' in created)) throw new Error('expected a session id')
    expect(await rig.service.listCommands(created.sessionId, true)).toEqual([
      {
        id: 'claude:' + 'user:x',
        provider: 'claude',
        kind: 'command',
        name: 'user:x',
        description: 'X',
        source: 'user'
      }
    ])
    expect(list).toHaveBeenCalledWith({
      repos: [{ name: 'repo-a', path: `${dir()}/repo-a` }],
      fallbackCwd: `${dir()}/userData/groups/${rig.groupId}/knowledge`,
      refresh: true
    })
  })

  it('warms the list on open without waiting for it', async () => {
    let release: (v: []) => void = () => undefined
    const list = vi.fn<CommandCatalogue['list']>(
      () => new Promise((resolve) => (release = resolve))
    )
    rig = await makeRig(dir(), { commands: { list } })
    const created = await rig.service.create(rig.groupId, 'Plan it', 'plan_first', 3)
    if (!('sessionId' in created)) throw new Error('expected a session id')
    list.mockClear()
    const opened = await rig.service.open(created.sessionId)
    expect(opened).toHaveProperty('header')
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ refresh: false }))
    release([])
  })

  it('returns an empty list without a catalogue', async () => {
    rig = await makeRig(dir())
    const created = await rig.service.create(rig.groupId, 'Plan it', 'plan_first', 3)
    if (!('sessionId' in created)) throw new Error('expected a session id')
    expect(await rig.service.listCommands(created.sessionId, false)).toEqual([])
  })
})
