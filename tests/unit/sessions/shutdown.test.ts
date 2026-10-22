import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildAgentEnv, ProcessSupervisor } from '../../../src/main/agents/process-supervisor'
import { runShutdown, SHUTDOWN_TIMINGS } from '../../../src/main/sessions/shutdown'
import type { ShutdownDeps } from '../../../src/main/sessions/shutdown'

const stub = resolve('tests/unit/agents/helpers/stub-child.mjs')
const log = { warn: () => undefined }

function rig(overrides: Partial<ShutdownDeps> = {}): { deps: ShutdownDeps; calls: string[] } {
  const calls: string[] = []
  let live = 1
  const deps: ShutdownDeps = {
    writeStopped: () => void calls.push('db'),
    settleBridgeCalls: () => void calls.push('settle'),
    stopAgents: () => {
      calls.push('stop')
      return new Promise<void>(() => undefined)
    },
    liveCount: () => live,
    signalAll: (signal) => {
      calls.push(signal)
      if (signal === 'SIGTERM') live = 0
    },
    closeBridge: () => {
      calls.push('bridge')
      return Promise.resolve()
    },
    cleanup: () => void calls.push('cleanup'),
    log,
    timings: { graceMs: 20, killAfterMs: 200, ceilingMs: 600, pollMs: 5 },
    ...overrides
  }
  return { deps, calls }
}

describe('runShutdown', () => {
  it('cancels a running plugin change as part of the sequence', async () => {
    const { deps, calls } = rig({
      liveCount: () => 0,
      stopAgents: () => Promise.resolve(),
      cancelPluginOps: () => {
        calls.push('plugins')
        return Promise.resolve()
      }
    })
    await runShutdown(deps)
    expect(calls).toEqual(['db', 'settle', 'plugins', 'bridge', 'cleanup'])
  })

  it('goes on when cancelling the plugin change fails', async () => {
    const { deps, calls } = rig({
      liveCount: () => 0,
      stopAgents: () => Promise.resolve(),
      cancelPluginOps: () => Promise.reject(new Error('boom'))
    })
    await runShutdown(deps)
    expect(calls).toEqual(['db', 'settle', 'bridge', 'cleanup'])
  })

  it('writes Stopped to the database before any process is signalled', async () => {
    const { deps, calls } = rig()
    await runShutdown(deps)
    expect(calls).toEqual(['db', 'settle', 'stop', 'SIGTERM', 'bridge', 'cleanup'])
    expect(calls.indexOf('db')).toBeLessThan(calls.indexOf('SIGTERM'))
  })

  it('does not wait or signal anything when no agent is running', async () => {
    const { deps, calls } = rig({ liveCount: () => 0, stopAgents: () => Promise.resolve() })
    const started = Date.now()
    await runShutdown(deps)
    expect(calls).toEqual(['db', 'settle', 'bridge', 'cleanup'])
    expect(Date.now() - started).toBeLessThan(100)
  })

  it('keeps going when a step throws', async () => {
    const { deps, calls } = rig({
      writeStopped: () => {
        throw new Error('db is gone')
      },
      settleBridgeCalls: () => {
        throw new Error('nope')
      },
      closeBridge: () => Promise.reject(new Error('close failed')),
      stopAgents: () => Promise.resolve(),
      liveCount: () => 0
    })
    await runShutdown(deps)
    expect(calls).toEqual(['cleanup'])
  })

  it('uses the spec timings by default', () => {
    expect(SHUTDOWN_TIMINGS).toMatchObject({ killAfterMs: 5000, ceilingMs: 8000 })
  })

  it('kills a stubborn child within the ceiling', async () => {
    const supervisor = new ProcessSupervisor()
    const proc = supervisor.spawn({
      command: process.execPath,
      args: [stub, 'ignore-all'],
      cwd: process.cwd(),
      env: { ...buildAgentEnv(process.env, process.env['PATH'] ?? ''), ELECTRON_RUN_AS_NODE: '1' }
    })
    await new Promise((r) => setTimeout(r, 300)) // let the stub install its signal handlers
    const calls: string[] = []
    const started = Date.now()
    await runShutdown({
      ...rig().deps,
      // The agent layer finishes only once the process is gone, which it will not do by itself.
      stopAgents: () => proc.exited.then(() => undefined),
      liveCount: () => supervisor.liveCount,
      signalAll: (signal) => {
        calls.push(signal)
        supervisor.killAllSync(signal)
      },
      timings: { graceMs: 100, killAfterMs: 400, ceilingMs: 1500, pollMs: 10 }
    })
    const info = await proc.exited
    expect(Date.now() - started).toBeLessThan(1500)
    expect(calls).toEqual(['SIGTERM', 'SIGKILL'])
    expect(info.signal).toBe('SIGKILL')
    expect(supervisor.liveCount).toBe(0)
  })

  it('falls back to SIGKILL at the ceiling when the ladder is stuck', async () => {
    const calls: string[] = []
    const { deps } = rig({
      liveCount: () => 1,
      signalAll: (signal) => void calls.push(signal),
      timings: { graceMs: 10, killAfterMs: 5000, ceilingMs: 150, pollMs: 5 }
    })
    const started = Date.now()
    await runShutdown(deps)
    expect(Date.now() - started).toBeLessThan(600)
    expect(calls).toEqual(['SIGTERM', 'SIGKILL'])
  })
})
