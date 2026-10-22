import { afterEach, describe, expect, it } from 'vitest'
import { useTempDir } from '../helpers/temp-dir'
import { makeEngineRig, until } from './engine-rig'
import type { EngineRig } from './engine-rig'

const dir = useTempDir('arc-activity-')
let e: EngineRig | undefined

afterEach(async () => {
  await e?.close()
  e = undefined
})

const toolUse = (name: string, summary: string) =>
  ({ type: 'tool-use', toolUseId: `t-${name}`, name, summary }) as const

describe('worker activity line', () => {
  it('never shows Arc bridge tools or ToolSearch, only ordinary tools and report_progress notes', async () => {
    e = await makeEngineRig(dir())
    const sessionId = await e.startSession('autonomous')
    const spawned = await e.call(e.brain(), 'spawn_worker', {
      name: 'one',
      task: 'Do one',
      repos: ['api'],
      model: 'sonnet'
    })
    const id = String(spawned.value['workerId'])
    const handle = e.workerHandle(0)
    const activity = (): string | null | undefined => e?.rig.deps.workersRepo.get(id)?.activity
    expect(sessionId).toBeTruthy()

    handle.emit(toolUse('Bash', 'Bash: pnpm test'))
    await until(() => activity() === 'Bash: pnpm test')

    // Past the activity throttle window, so only the filter can keep the line unchanged.
    e.rig.clock.now += 2000
    handle.emit(toolUse('mcp__arc__report_progress', 'mcp__arc__report_progress'))
    handle.emit(toolUse('ToolSearch', 'ToolSearch'))
    await new Promise((r) => setTimeout(r, 100))
    expect(activity()).toBe('Bash: pnpm test')

    await e.call(handle, 'report_progress', { note: 'Reading the sync module' })
    expect(activity()).toBe('Reading the sync module')
  })
})
