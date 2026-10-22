import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CodexProbe, type CodexProbeDeps } from '../../../../src/main/agents/codex/codex-probe'
import {
  ProcessSupervisor,
  type SupervisedProcess
} from '../../../../src/main/agents/process-supervisor'

const fake = resolve('tests/e2e/fixtures/fake-codex.mjs')
const nodeEnv = { ELECTRON_RUN_AS_NODE: '1' }

let dir: string
beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'arc-codex-probe-')))
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** A supervisor that remembers every process it started. */
class RecordingSupervisor extends ProcessSupervisor {
  readonly started: SupervisedProcess[] = []
  override spawn(request: Parameters<ProcessSupervisor['spawn']>[0]): SupervisedProcess {
    const proc = super.spawn(request)
    this.started.push(proc)
    return proc
  }
}

let counter = 0
function probeFor(
  extraEnv: Record<string, string> = {},
  over: Partial<CodexProbeDeps> = {}
): { probe: CodexProbe; supervisor: RecordingSupervisor; log: string } {
  const supervisor = new RecordingSupervisor()
  const log = join(dir, `log-${++counter}.jsonl`)
  const probe = new CodexProbe({
    supervisor,
    binary: process.execPath,
    binaryArgs: [fake],
    resolvePath: () => Promise.resolve(process.env['PATH'] ?? ''),
    extraEnv: { ...nodeEnv, FAKE_CODEX_LOG: log, ...extraEnv },
    clientVersion: '9.9.9',
    stopGraceMs: 300,
    ...over
  })
  return { probe, supervisor, log }
}

function readLog(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

function methodsReceived(path: string): string[] {
  return readLog(path)
    .map((r) => r['recv'] as { method?: string } | undefined)
    .flatMap((r) => (r?.method ? [r.method] : []))
}

function isGone(pid: number | undefined): boolean {
  if (pid === undefined) return true
  try {
    process.kill(pid, 0)
    return false
  } catch {
    return true
  }
}

describe('CodexProbe', () => {
  it('lists the visible models, and starts no thread or turn', async () => {
    const { probe, log } = probeFor()
    const models = await probe.listModels()
    expect(models).toEqual([
      { model: 'fake-deep', displayName: 'Fake Deep', isDefault: true },
      { model: 'fake-fast', displayName: 'Fake Fast', isDefault: false }
    ])
    // initialize, the initialized notification, then model/list: no thread/start, no turn/start.
    expect(methodsReceived(log)).toEqual(['initialize', 'initialized', 'model/list'])
    const listCall = readLog(log)
      .map((r) => r['recv'] as { method?: string; params?: Record<string, unknown> } | undefined)
      .find((r) => r?.method === 'model/list')
    expect(listCall?.params).toMatchObject({ includeHidden: false })
  })

  it('lists the enabled skills with skills/list and makes no model call', async () => {
    const skills = [
      'publish-release',
      { name: 'old-skill', enabled: false },
      { name: 'repo-skill', description: 'From the repo', path: '/r/SKILL.md', scope: 'repo' }
    ]
    const { probe, log } = probeFor({ FAKE_CODEX_SKILLS: JSON.stringify(skills) })
    expect(await probe.listSkills(['/repo-a', '/repo-b'])).toEqual([
      {
        name: 'publish-release',
        description: 'The publish-release skill',
        path: '/fake-codex/skills/publish-release/SKILL.md',
        scope: 'user'
      },
      { name: 'repo-skill', description: 'From the repo', path: '/r/SKILL.md', scope: 'repo' }
    ])
    expect(methodsReceived(log)).toEqual(['initialize', 'initialized', 'skills/list'])
    const call = readLog(log)
      .map((r) => r['recv'] as { method?: string; params?: Record<string, unknown> } | undefined)
      .find((r) => r?.method === 'skills/list')
    expect(call?.params).toEqual({ cwds: ['/repo-a', '/repo-b'] })
  })

  it('rejects when skills/list fails', async () => {
    const { probe } = probeFor({ FAKE_CODEX_SKILLS_FAIL: '1' })
    await expect(probe.listSkills(['/r'])).rejects.toThrow('skills/list failed')
  })

  it('reads only the MCP server names and tool names with config/read, and nothing of their env or tokens leaves the probe', async () => {
    const servers = {
      figma: {
        command: 'npx',
        args: ['figma-mcp'],
        env: { FIGMA_TOKEN: 'tok-secret-1' },
        tools: { get_file: { approval_mode: 'approve' }, other: { enabled: false } }
      },
      github: { url: 'https://example.test/mcp', http_headers: { Authorization: 'Bearer tok-2' } }
    }
    const { probe, log } = probeFor({ FAKE_CODEX_MCP_SERVERS: JSON.stringify(servers) })
    const found = await probe.listMcpServers('/some/repo')
    expect(found).toEqual([
      { name: 'figma', approvalTools: ['get_file'] },
      { name: 'github', approvalTools: [] }
    ])
    expect(JSON.stringify(found)).not.toContain('tok-')
    const methods = methodsReceived(log)
    expect(methods).toContain('config/read')
    expect(methods).not.toContain('thread/start')
    expect(methods).not.toContain('turn/start')
    const read = readLog(log).find(
      (r) => (r['recv'] as { method?: string } | undefined)?.method === 'config/read'
    )
    expect((read?.['recv'] as { params: unknown }).params).toEqual({
      includeLayers: false,
      cwd: '/some/repo'
    })
  })

  it('gives no servers for a config without any, and rejects when config/read fails', async () => {
    expect(await probeFor().probe.listMcpServers('/r')).toEqual([])
    await expect(
      probeFor({ FAKE_CODEX_CONFIG_FAIL: '1' }).probe.listMcpServers('/r')
    ).rejects.toThrow(/config\/read failed/)
  })

  it('reads the plan limits with account/rateLimits/read and makes no model call', async () => {
    const { probe, log } = probeFor()
    const limits = await probe.readRateLimits()
    expect(limits.planType).toBe('pro')
    expect(limits.windows.map((w) => [w.windowId, w.label, w.usedPercent])).toEqual([
      ['codex:300', '5h', 12],
      ['codex:10080', 'Weekly', 30]
    ])
    const methods = methodsReceived(log)
    expect(methods).toContain('account/rateLimits/read')
    expect(methods.filter((m) => m.startsWith('thread/') || m.startsWith('turn/'))).toEqual([])
  })

  it('reports no windows when both are null, takes a configured answer, and rejects on error', async () => {
    const none = probeFor({ FAKE_CODEX_RATE_LIMITS: 'none' })
    expect((await none.probe.readRateLimits()).windows).toEqual([])
    const custom = probeFor({
      FAKE_CODEX_RATE_LIMITS: JSON.stringify({
        primary: { usedPercent: 81, windowDurationMins: 10080, resetsAt: 9 },
        secondary: null,
        planType: 'plus'
      })
    })
    expect(await custom.probe.readRateLimits()).toEqual({
      windows: [{ windowId: 'codex:10080', label: 'Weekly', usedPercent: 81, resetsAt: 9 }],
      planType: 'plus'
    })
    const failing = probeFor({ FAKE_CODEX_RATE_LIMITS_FAIL: '1' })
    await expect(failing.probe.readRateLimits()).rejects.toThrow(/rateLimits\/read failed/)
  })

  it('runs `app-server` and ends the process by its pid afterwards', async () => {
    const { probe, supervisor, log } = probeFor()
    await probe.listModels()
    const argv = readLog(log)[0]?.['argv']
    expect(argv).toEqual(['app-server'])
    expect(supervisor.started).toHaveLength(1)
    const proc = supervisor.started[0] as SupervisedProcess
    expect(proc.pid).toBeTypeOf('number')
    await proc.exited
    expect(isGone(proc.pid)).toBe(true)
  })

  it('passes the user CODEX_HOME through so the account decides the list', async () => {
    const { probe, log } = probeFor(
      {},
      { env: { ...process.env, CODEX_HOME: join(dir, 'codex-home') } }
    )
    await probe.listModels()
    const env = readLog(log).find((r) => r['env'] !== undefined)?.['env'] as {
      CODEX_HOME?: string
    }
    expect(env.CODEX_HOME).toBe(join(dir, 'codex-home'))
  })

  it('follows nextCursor until the list ends', async () => {
    const { probe, log } = probeFor({
      FAKE_CODEX_MODELS: JSON.stringify(['m1', 'm2', 'm3']),
      FAKE_CODEX_MODELS_PAGE: '1'
    })
    const models = await probe.listModels()
    expect(models.map((m) => m.model)).toEqual(['m1', 'm2', 'm3'])
    expect(methodsReceived(log).filter((m) => m === 'model/list')).toHaveLength(3)
  })

  it('rejects with the server error and still ends the process', async () => {
    const { probe, supervisor } = probeFor({ FAKE_CODEX_MODELS_FAIL: '1' })
    await expect(probe.listModels()).rejects.toThrow(/model\/list failed/)
    const proc = supervisor.started[0] as SupervisedProcess
    await proc.exited
    expect(isGone(proc.pid)).toBe(true)
  })

  it('times out at the deadline and kills a process that does not answer', async () => {
    const { probe, supervisor } = probeFor(
      {},
      {
        binaryArgs: ['-e', 'setInterval(() => {}, 1000)'],
        timeoutMs: 400,
        stopGraceMs: 100
      }
    )
    const started = Date.now()
    await expect(probe.listModels()).rejects.toThrow(/did not list its models in time/)
    expect(Date.now() - started).toBeLessThan(5000)
    const proc = supervisor.started[0] as SupervisedProcess
    await proc.exited
    expect(isGone(proc.pid)).toBe(true)
  })

  it('rejects when the binary is missing', async () => {
    const { probe } = probeFor({}, { binary: join(dir, 'no-such-codex'), binaryArgs: [] })
    await expect(probe.listModels()).rejects.toThrow(/exited before answering|ENOENT/)
  })

  it('rejects when the process exits before it answers', async () => {
    const { probe } = probeFor({}, { binaryArgs: ['-e', 'process.exit(3)'] })
    await expect(probe.listModels()).rejects.toThrow(/exited before answering/)
  })
})
