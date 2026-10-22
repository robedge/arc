import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { RateLimitWindow } from '../../../src/main/agents/agent-events'
import type { SpawnRequest, SupervisedProcess } from '../../../src/main/agents/process-supervisor'
import {
  ClaudePlanProbe,
  buildPlanProbeArgs,
  planProbeTarget,
  type ClaudePlanProbeDeps
} from '../../../src/main/usage/claude-plan-probe'
import type { PlanCheckUsage } from '../../../src/main/usage/usage-recorder'
import { useTempDir } from '../helpers/temp-dir'

const dir = useTempDir('arc-plan-probe-')
const FIXTURE = readFileSync(resolve('tests/fixtures/claude/2.1.302/plan-check.jsonl'), 'utf8')
  .split('\n')
  .filter((l) => l.trim() !== '')

interface FakeProc extends SupervisedProcess {
  killed: NodeJS.Signals[]
  stdinEnded: boolean
}

/** A fake CLI process that plays `lines` (one per `stepMs`) and then exits, or never does (`hang`). */
function fakeProcess(lines: string[], options: { hang?: boolean; code?: number } = {}): FakeProc {
  let onLine: (line: string) => void = () => undefined
  let exited = false
  let resolveExit: (info: never) => void = () => undefined
  const exitedPromise = new Promise<never>((resolve) => {
    resolveExit = resolve
  })
  const finish = (): void => {
    if (exited) return
    exited = true
    resolveExit({
      code: options.code ?? 0,
      signal: null,
      expected: true,
      stderrTail: ''
    } as never)
  }
  const proc = {
    killed: [] as NodeJS.Signals[],
    stdinEnded: false,
    pid: 1,
    exited: exitedPromise,
    onLine(listener: (line: string) => void) {
      onLine = listener
      queueMicrotask(() => {
        for (const line of lines) onLine(line)
        if (!options.hang) finish()
      })
    },
    onOverflow: () => undefined,
    onStderr: () => undefined,
    writeLine: () => true,
    endStdin() {
      proc.stdinEnded = true
    },
    kill(signal: NodeJS.Signals) {
      proc.killed.push(signal)
      finish()
      return true
    },
    expectExit: () => undefined,
    killLadder(steps: readonly { signal: NodeJS.Signals }[]) {
      for (const step of steps) {
        proc.kill(step.signal)
        break
      }
      return exitedPromise
    },
    stderrTail: () => '',
    hasExited: () => exited
  }
  return proc as unknown as FakeProc
}

interface Rig {
  probe: ClaudePlanProbe
  spawns: SpawnRequest[]
  procs: FakeProc[]
  ingested: { provider: string; windows: readonly RateLimitWindow[]; source: string }[]
  recorded: PlanCheckUsage[]
  warns: string[]
  order: string[]
}

function rig(
  over: Partial<ClaudePlanProbeDeps> = {},
  options: { lines?: string[]; hang?: boolean } = {}
): Rig {
  const r: Rig = {
    spawns: [],
    procs: [],
    ingested: [],
    recorded: [],
    warns: [],
    order: [],
    probe: undefined as never
  }
  r.probe = new ClaudePlanProbe({
    supervisor: {
      spawn: (request) => {
        r.spawns.push(request)
        const proc = fakeProcess(options.lines ?? FIXTURE, { hang: options.hang === true })
        r.procs.push(proc)
        return proc
      }
    },
    binary: 'claude',
    resolvePath: () => Promise.resolve('/usr/bin'),
    cwd: join(dir(), 'plan-probe'),
    settingsPath: join(dir(), 'plan-probe-settings.json'),
    models: { cheapestFor: () => ({ provider: 'claude', model: 'haiku' }) },
    plans: {
      ingest: (provider, windows, source) => {
        r.order.push('ingest')
        r.ingested.push({ provider, windows, source })
      }
    },
    recorder: {
      recordPlanCheck: (usage) => {
        r.order.push('record')
        r.recorded.push(usage)
        return true
      }
    },
    isEnabled: () => true,
    isClaudeReady: () => true,
    isRateLimitPaused: () => false,
    log: { warn: (message) => r.warns.push(message) },
    env: { PATH: '/usr/bin' },
    stopGraceMs: 10,
    ...over
  })
  return r
}

describe('buildPlanProbeArgs', () => {
  it('is exactly the flag set of tech spec 2.5', () => {
    expect(buildPlanProbeArgs('haiku', '/u/settings.json')).toEqual([
      '-p',
      '.',
      '--model',
      'haiku',
      '--output-format',
      'stream-json',
      '--verbose',
      '--tools',
      '',
      '--strict-mcp-config',
      '--disable-slash-commands',
      '--setting-sources',
      'project',
      '--settings',
      '/u/settings.json',
      '--system-prompt',
      '.',
      '--no-session-persistence'
    ])
  })
})

describe('planProbeTarget (composition-root guard)', () => {
  it('is on outside tests with the resolved claude', () => {
    expect(planProbeTarget({}, 'claude', true)).toEqual({ binary: 'claude', binaryArgs: [] })
  })

  it('never spawns under HARNESS_E2E=1 without the override', () => {
    expect(planProbeTarget({ HARNESS_E2E: '1' }, 'claude', false)).toBeUndefined()
  })

  it('never spawns under Vitest without the override', () => {
    expect(planProbeTarget({ VITEST: 'true' }, 'claude', false)).toBeUndefined()
  })

  it('uses HARNESS_PLAN_PROBE_BIN instead of claude when set', () => {
    expect(
      planProbeTarget(
        { HARNESS_E2E: '1', HARNESS_PLAN_PROBE_BIN: '/x/fake-claude.mjs' },
        'claude',
        false
      )
    ).toEqual({ binary: '/x/fake-claude.mjs', binaryArgs: [] })
  })

  it('ignores the override in a packaged app', () => {
    expect(
      planProbeTarget({ HARNESS_E2E: '1', HARNESS_PLAN_PROBE_BIN: '/x/fake' }, 'claude', true)
    ).toBeUndefined()
  })
})

describe('ClaudePlanProbe', () => {
  it('spawns the exact argv from the stable empty cwd, with stdin closed', async () => {
    const r = rig()
    expect(await r.probe.runOnce()).toBe(true)
    const spawn = r.spawns[0]
    expect(spawn?.command).toBe('claude')
    expect(spawn?.args).toEqual(
      buildPlanProbeArgs('haiku', join(dir(), 'plan-probe-settings.json'))
    )
    expect(spawn?.cwd).toBe(join(dir(), 'plan-probe'))
    expect(spawn?.agentId).toBe('plan-check')
    expect(r.procs[0]?.stdinEnded).toBe(true)
    expect(JSON.parse(readFileSync(join(dir(), 'plan-probe-settings.json'), 'utf8'))).toEqual({
      disableAllHooks: true
    })
  })

  it('ingests the windows with source probe', async () => {
    const r = rig()
    await r.probe.runOnce()
    expect(r.ingested).toHaveLength(1)
    expect(r.ingested[0]?.provider).toBe('claude')
    expect(r.ingested[0]?.source).toBe('probe')
    expect(r.ingested[0]?.windows.map((w) => [w.windowId, w.usedPercent])).toEqual([
      ['five_hour', 5],
      ['seven_day', 28]
    ])
    expect(r.warns).toEqual([])
  })

  it('waits for result: the usage row is written even though the rate-limit event came first', async () => {
    const r = rig()
    await r.probe.runOnce()
    expect(FIXTURE.findIndex((l) => l.includes('rate_limit_event'))).toBeLessThan(
      FIXTURE.findIndex((l) => l.includes('"type":"result"'))
    )
    expect(r.recorded).toHaveLength(1)
    expect(r.recorded[0]).toMatchObject({
      provider: 'claude',
      model: 'claude-haiku-5-5',
      input: 2,
      cacheWrite: 582,
      cacheRead: 0,
      output: 159
    })
    expect(r.procs[0]?.killed).toEqual([])
  })

  it('does not stop at the rate-limit event when no result follows it', async () => {
    const lines = FIXTURE.filter(
      (l) => !l.includes('"type":"result"') && !l.includes('duration_api_ms')
    )
    const r = rig({}, { lines })
    await r.probe.runOnce()
    // The process ended on its own after its last line; windows still count, nothing was invented.
    expect(r.ingested).toHaveLength(1)
    expect(r.recorded).toHaveLength(0)
  })

  it('skips when the setting is off', async () => {
    const r = rig({ isEnabled: () => false })
    expect(await r.probe.runOnce()).toBe(false)
    expect(r.spawns).toHaveLength(0)
  })

  it('skips when Claude is not ok', async () => {
    const r = rig({ isClaudeReady: () => false })
    expect(await r.probe.runOnce()).toBe(false)
    expect(r.spawns).toHaveLength(0)
  })

  it('skips while the rate-limit gate is paused', async () => {
    const r = rig({ isRateLimitPaused: () => true })
    expect(await r.probe.runOnce()).toBe(false)
    expect(r.spawns).toHaveLength(0)
  })

  it('runs once per launch', async () => {
    const r = rig()
    expect(await r.probe.runOnce()).toBe(true)
    expect(await r.probe.runOnce()).toBe(false)
    expect(r.spawns).toHaveLength(1)
  })

  it('can still run after a skip, once the conditions hold', async () => {
    let ready = false
    const r = rig({ isClaudeReady: () => ready })
    expect(await r.probe.runOnce()).toBe(false)
    ready = true
    expect(await r.probe.runOnce()).toBe(true)
  })

  it('on timeout stops the CLI, warns once and leaves the meter alone', async () => {
    const r = rig({ timeoutMs: 20 }, { lines: [], hang: true })
    await r.probe.runOnce()
    expect(r.procs[0]?.killed).toEqual(['SIGTERM'])
    expect(r.warns).toHaveLength(1)
    expect(r.warns[0]).toContain('timed out')
    expect(r.ingested).toEqual([])
    expect(r.recorded).toEqual([])
  })

  it('warns once and changes nothing when no rate-limit event arrives', async () => {
    const lines = FIXTURE.filter((l) => !l.includes('rate_limit_event'))
    const r = rig({}, { lines })
    await r.probe.runOnce()
    expect(r.ingested).toEqual([])
    expect(r.warns).toHaveLength(1)
  })

  it('warns once when the CLI cannot be started', async () => {
    const r = rig({
      supervisor: {
        spawn: () => {
          throw new Error('spawn failed')
        }
      }
    })
    expect(await r.probe.runOnce()).toBe(true)
    expect(r.warns).toHaveLength(1)
    expect(r.ingested).toEqual([])
  })

  it('warns and does not spawn when no lightest model is listed', async () => {
    const r = rig({ models: { cheapestFor: () => undefined } })
    await r.probe.runOnce()
    expect(r.spawns).toHaveLength(0)
    expect(r.warns).toHaveLength(1)
  })
})
