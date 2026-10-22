import { afterEach, describe, expect, it, vi } from 'vitest'
import { useTempDir } from '../helpers/temp-dir'
import { makeEngineRig, until } from './engine-rig'
import type { EngineRig } from './engine-rig'

const dir = useTempDir('arc-pv-launch-')
let e: EngineRig | undefined

afterEach(async () => {
  await e?.close()
  e = undefined
})

async function spawnWorker(rig: EngineRig): Promise<void> {
  const result = await rig.call(rig.brain(), 'spawn_worker', {
    name: 'one',
    task: 'Do one',
    repos: ['api'],
    model: 'sonnet'
  })
  expect(result.isError).toBe(false)
  await until(() => rig.rig.adapter.starts.some((s) => s.role === 'worker'))
}

describe('plugin view on agent launches', () => {
  it('passes the view to the brain and the worker, with the repositories of the group', async () => {
    const getPluginViewDir = vi.fn<
      (repos: readonly string[], role: 'brain' | 'workers') => Promise<string | undefined>
    >(() => Promise.resolve('/ud/view'))
    e = await makeEngineRig(dir(), { getPluginViewDir })
    const sessionId = await e.startSession('autonomous')
    expect(sessionId).toBeTruthy()
    await spawnWorker(e)
    const starts = e.rig.adapter.starts
    expect(starts.find((s) => s.role === 'brain')?.claude.pluginViewDir).toBe('/ud/view')
    expect(starts.find((s) => s.role === 'worker')?.claude.pluginViewDir).toBe('/ud/view')
    const workerRepos = getPluginViewDir.mock.calls.at(-1)?.[0]
    expect(workerRepos).toEqual(expect.arrayContaining([e.api.path]))
    expect(getPluginViewDir.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining([e.api.path, e.web.path])
    )
    // Each role gets the view of its own selection (spec 009).
    expect(getPluginViewDir.mock.calls[0]?.[1]).toBe('brain')
    expect(getPluginViewDir.mock.calls.at(-1)?.[1]).toBe('workers')
  })

  it.each([
    ['resolves undefined', () => Promise.resolve(undefined)],
    ['throws', () => Promise.reject(new Error('boom'))]
  ])('omits the view when the build failed (%s) and still starts the agents', async (_n, fn) => {
    e = await makeEngineRig(dir(), { getPluginViewDir: fn })
    await e.startSession('autonomous')
    await spawnWorker(e)
    for (const start of e.rig.adapter.starts) expect(start.claude.pluginViewDir).toBeUndefined()
  })
})
