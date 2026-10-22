import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionService } from '../../../src/main/sessions/session-service'
import { useTempDir } from '../helpers/temp-dir'
import { makeEngineRig, until } from './engine-rig'
import type { EngineRig } from './engine-rig'
import { fakeAdapter, records } from './fake-cli'
import { claudeRegistry } from './helpers'

vi.setConfig({ testTimeout: 60000 })

const dir = useTempDir('arc-continue-int-')
let e: EngineRig | undefined
let restarted: SessionService | undefined

afterEach(async () => {
  await restarted?.shutdown()
  restarted = undefined
  await e?.close()
  e = undefined
})

describe('Continue through the real adapter and the fake CLI', () => {
  it('quits, reopens and continues: the worker runs with --resume <id> in its working copy', async () => {
    const firstLog = join(dir(), 'first.log')
    const secondLog = join(dir(), 'second.log')
    e = await makeEngineRig(dir(), { adapter: fakeAdapter('continue', firstLog) })
    const created = await e.rig.service.create(e.rig.groupId, 'Keep a worker', 'autonomous', 3)
    if (!('sessionId' in created)) throw new Error('expected a session id')
    const { sessionId } = created
    const workers = e.rig.deps.workersRepo
    await until(() => workers.listBySession(sessionId)[0]?.status === 'working', 30000)
    // The worker's pwd and progress line are in the log once it has run its script.
    await until(() => records(firstLog).some((r) => r.mcpResult?.tool === 'report_progress'), 30000)
    const row = workers.listBySession(sessionId)[0]
    const claudeId = row?.providerSessionId ?? ''
    expect(claudeId).not.toBe('')
    const treePath = e.rig.deps.worktreesRepo.listByWorker(row?.id ?? '')[0]?.path ?? ''

    // Quit: the worker is Stopped (quit) and keeps its working copy.
    await e.rig.service.shutdown()
    expect(workers.get(row?.id ?? '')).toMatchObject({ status: 'stopped', stoppedBy: 'quit' })

    // Reopen: the prompt is there, then Continue.
    restarted = new SessionService({
      ...e.rig.deps,
      registry: claudeRegistry(fakeAdapter('continue', secondLog))
    })
    const opened = await restarted.open(sessionId)
    if (!('messages' in opened)) throw new Error('expected a snapshot')
    expect(opened.messages.at(-1)).toMatchObject({
      role: 'system',
      content: '1 worker was stopped when Arc closed. Continue it?',
      prompt: { kind: 'continue-workers', status: 'open' }
    })
    await restarted.continueAllWorkers(sessionId)
    await until(() => workers.get(row?.id ?? '')?.status === 'working', 30000)
    await until(() => records(secondLog).some((r) => r.shell !== undefined), 30000)

    const argv = records(secondLog).find((r) => r.argv)?.argv ?? []
    expect(argv[argv.indexOf('--resume') + 1]).toBe(claudeId)
    const pwd = records(secondLog).find((r) => r.shell)?.shell
    expect(pwd?.cmd).toBe('pwd')
    expect(realpathSync(pwd?.out.trim() ?? '')).toBe(realpathSync(treePath))
    const stdin = records(secondLog).find((r) => r.stdin !== undefined)?.stdin as {
      message?: { content?: unknown }
    }
    expect(JSON.stringify(stdin)).toContain('You were interrupted. Continue the task.')
  })
})
