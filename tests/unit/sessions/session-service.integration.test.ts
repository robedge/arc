import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentAdapter } from '../../../src/main/agents/agent-adapter'
import { ClaudeAdapter } from '../../../src/main/agents/claude-adapter'
import { ProcessSupervisor } from '../../../src/main/agents/process-supervisor'
import { useTempDir } from '../helpers/temp-dir'
import { SessionService } from '../../../src/main/sessions/session-service'
import { claudeRegistry, makeRig } from './helpers'
import type { Rig } from './helpers'

const fake = resolve('tests/e2e/fixtures/fake-claude.mjs')
const scenario = resolve('tests/e2e/fixtures/claude-scenarios/text-reply.jsonl')
const dir = useTempDir('arc-sessions-int-')
let rig: Rig | undefined

afterEach(async () => {
  await rig?.service.shutdown()
  rig?.close()
  rig = undefined
})

async function until(check: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting for the condition')
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('session service with the real claude adapter and the fake CLI', () => {
  it('runs the text-reply scenario end to end through a real database', async () => {
    const logPath = join(dir(), 'fake.log')
    const real = new ClaudeAdapter({
      supervisor: new ProcessSupervisor(),
      binary: process.execPath,
      binaryArgs: [fake],
      resolvePath: () => Promise.resolve(process.env['PATH'] ?? ''),
      timings: { stopGraceMs: 1000, stopTermMs: 300 }
    })
    const adapter: AgentAdapter = {
      provider: 'claude',
      start: (o) =>
        real.start({
          ...o,
          extraEnv: {
            ELECTRON_RUN_AS_NODE: '1',
            FAKE_CLAUDE_SCRIPT: scenario,
            FAKE_CLAUDE_LOG: logPath
          }
        }),
      resume: (o) => adapter.start(o)
    }
    rig = await makeRig(dir(), { adapter })

    const created = await rig.service.create(
      rig.groupId,
      'ping the brain and answer briefly',
      'autonomous',
      2
    )
    if (!('sessionId' in created)) throw new Error('expected a session id')
    const { sessionId } = created

    await until(
      () => rig?.service.snapshot(sessionId).brainState === 'idle' && hasBrainReply(sessionId)
    )

    const snapshot = rig.service.snapshot(sessionId)
    expect(snapshot.messages.map((m) => [m.role, m.content, m.state])).toEqual([
      ['user', 'ping the brain and answer briefly', 'complete'],
      ['brain', 'pong', 'complete']
    ])
    expect(snapshot.header.name).toBe('Ping The Brain And Answer Briefly')
    expect(rig.brainThreadsRepo.get(sessionId, 'claude')).toMatch(/[0-9a-f-]{36}/)

    const argv = readFileSync(logPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { argv?: string[]; stdin?: unknown })
    const args = argv[0]?.argv ?? []
    expect(args).toContain('--add-dir')
    expect(args[args.indexOf('--model') + 1]).toBe('sonnet')
    expect(args[args.indexOf('--append-system-prompt') + 1]).toContain('[arc-role:brain]')
  })

  it('resumes the brain with --resume <id> after a simulated restart', async () => {
    const logPath = join(dir(), 'fake-resume.log')
    const real = new ClaudeAdapter({
      supervisor: new ProcessSupervisor(),
      binary: process.execPath,
      binaryArgs: [fake],
      resolvePath: () => Promise.resolve(process.env['PATH'] ?? ''),
      timings: { stopGraceMs: 1000, stopTermMs: 300 }
    })
    const adapter: AgentAdapter = {
      provider: 'claude',
      start: (o) =>
        real.start({
          ...o,
          extraEnv: {
            ELECTRON_RUN_AS_NODE: '1',
            FAKE_CLAUDE_SCRIPT: scenario,
            FAKE_CLAUDE_LOG: logPath
          }
        }),
      resume: (o) => adapter.start(o)
    }
    rig = await makeRig(dir(), { adapter })
    const created = await rig.service.create(rig.groupId, 'first question', 'autonomous', 2)
    if (!('sessionId' in created)) throw new Error('expected a session id')
    const { sessionId } = created
    await until(() => hasBrainReply(sessionId))
    const storedId = rig.brainThreadsRepo.get(sessionId, 'claude')
    expect(storedId).toBeTruthy()

    // Restart: stop the brain and build a new service over the same database.
    await rig.service.shutdown()
    const restarted = new SessionService({
      ...rig.deps,
      registry: claudeRegistry(adapter)
    })
    await restarted.sendMessage(sessionId, 'follow-up')
    await until(() => argvRecords().length >= 2)
    await restarted.shutdown()

    const second = argvRecords()[1] ?? []
    expect(second[second.indexOf('--resume') + 1]).toBe(storedId)
    expect(argvRecords()[0]).not.toContain('--resume')

    function argvRecords(): string[][] {
      return readFileSync(logPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { argv?: string[] })
        .flatMap((r) => (r.argv ? [r.argv] : []))
    }
  })

  it('respawns with --resume <id> --model opus after the brain model changes', async () => {
    const logPath = join(dir(), 'fake-model.log')
    const real = new ClaudeAdapter({
      supervisor: new ProcessSupervisor(),
      binary: process.execPath,
      binaryArgs: [fake],
      resolvePath: () => Promise.resolve(process.env['PATH'] ?? ''),
      timings: { stopGraceMs: 1000, stopTermMs: 300 }
    })
    const adapter: AgentAdapter = {
      provider: 'claude',
      start: (o) =>
        real.start({
          ...o,
          extraEnv: {
            ELECTRON_RUN_AS_NODE: '1',
            FAKE_CLAUDE_SCRIPT: scenario,
            FAKE_CLAUDE_LOG: logPath
          }
        }),
      resume: (o) => adapter.start(o)
    }
    rig = await makeRig(dir(), { adapter })
    const created = await rig.service.create(rig.groupId, 'first question', 'autonomous', 2)
    if (!('sessionId' in created)) throw new Error('expected a session id')
    const { sessionId } = created
    await until(
      () => rig?.service.snapshot(sessionId).brainState === 'idle' && hasBrainReply(sessionId)
    )
    const storedId = rig.brainThreadsRepo.get(sessionId, 'claude')
    expect(storedId).toBeTruthy()

    rig.service.setConfig(sessionId, { brainModel: { provider: 'claude', model: 'opus' } })
    await rig.service.sendMessage(sessionId, 'follow-up')
    await until(() => argvRecords().length >= 2)

    const [first = [], second = []] = argvRecords()
    expect(first[first.indexOf('--model') + 1]).toBe('sonnet')
    expect(second[second.indexOf('--resume') + 1]).toBe(storedId)
    expect(second[second.indexOf('--model') + 1]).toBe('opus')

    function argvRecords(): string[][] {
      return readFileSync(logPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { argv?: string[] })
        .flatMap((r) => (r.argv ? [r.argv] : []))
    }
  })

  function hasBrainReply(sessionId: string): boolean {
    return (rig?.messagesRepo.latest(sessionId, 10) ?? []).some(
      (m) => m.role === 'brain' && m.state === 'complete'
    )
  }
})
