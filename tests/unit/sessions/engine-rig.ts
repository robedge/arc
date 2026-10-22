import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { vi } from 'vitest'
import { BridgeServer } from '../../../src/main/bridge/bridge-server'
import { ProjectsRepo } from '../../../src/main/db/repositories/projects-repo'
import type { SessionMode } from '../../../src/shared/types/session'
import { createGitFixture, git, gitFixtureEnv } from '../../helpers/git-fixtures'
import type { GitFixture } from '../../helpers/git-fixtures'
import { callTool, readMcpConfig } from '../helpers/mcp-client'
import type { McpServerConfig, ToolCallOutcome } from '../helpers/mcp-client'
import { makeRig } from './helpers'
import type { FakeHandle, Rig } from './helpers'

export async function until(check: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting for the condition')
    await new Promise((r) => setTimeout(r, 15))
  }
}

export interface EngineRig {
  rig: Rig
  bridge: BridgeServer
  api: GitFixture
  web: GitFixture
  /** Creates a session, names it (so the session branch exists) and returns its id. */
  startSession(mode?: SessionMode): Promise<string>
  /** The MCP config the Nth started agent was given, as the CLI would read it. */
  configOf(handle: FakeHandle): McpServerConfig
  /** Calls a tool as the agent that owns this handle. */
  call(handle: FakeHandle, tool: string, args: Record<string, unknown>): Promise<ToolCallOutcome>
  brain(): FakeHandle
  workerHandle(index?: number): FakeHandle
  close(): Promise<void>
}

/**
 * A session service over a real database, real git repositories (`api` and `web`, both on `dev`),
 * the real bridge, and the fake adapter: tests play the CLI by emitting events and by calling the
 * bridge with the tokens each agent was given.
 */
export async function makeEngineRig(
  work: string,
  overrides: Parameters<typeof makeRig>[1] = {}
): Promise<EngineRig> {
  const bridge = new BridgeServer({
    configDir: join(work, 'userData', 'mcp'),
    log: { warn: vi.fn(), error: vi.fn() },
    progressIntervalMs: 50
  })
  await bridge.start()
  const rig = await makeRig(work, { bridge, autoMergeDone: false, ...overrides })
  const api = createGitFixture()
  const web = createGitFixture()
  const projects = new ProjectsRepo(rig.opened.db)
  projects.insert({ id: 'p-api', path: api.path, displayName: 'api', isGit: true, createdAt: 2 })
  projects.addMembership(rig.groupId, 'p-api', 1, 2)
  projects.insert({ id: 'p-web', path: web.path, displayName: 'web', isGit: true, createdAt: 3 })
  projects.addMembership(rig.groupId, 'p-web', 2, 3)

  const configs = new Map<string, McpServerConfig>()
  const configOf = (handle: FakeHandle): McpServerConfig => {
    const known = configs.get(handle.agentId)
    if (known) return known
    const start = rig.adapter.starts.find((s) => s.agentId === handle.agentId)
    if (!start?.claude.mcpConfigPath)
      throw new Error(`${handle.agentId} was started without an MCP config`)
    const config = readMcpConfig(start.claude.mcpConfigPath)
    configs.set(handle.agentId, config)
    return config
  }

  return {
    rig,
    bridge,
    api,
    web,
    async startSession(mode = 'plan_first') {
      const created = await rig.service.create(rig.groupId, 'Retry work on the client', mode, 3)
      if (!('sessionId' in created)) throw new Error('expected a session id')
      await until(() => rig.adapter.handles.length > 0)
      const brain = rig.adapter.handles[0] as FakeHandle
      brain.emit({
        type: 'session',
        providerSessionId: 'brain-claude-1',
        model: 'claude-sonnet-5-5',
        mcpServers: [{ name: 'arc', status: 'connected' }]
      })
      brain.emit({ type: 'assistant-message', messageId: 'm0', text: 'Title: Retry work\nReady.' })
      brain.emit({ type: 'turn-result', ok: true, interrupted: false, durationMs: 1 })
      await until(
        () =>
          (
            rig.opened.sqlite
              .prepare('select count(*) as n from session_projects where branch_name is not null')
              .get() as { n: number }
          ).n >= 2
      )
      return created.sessionId
    },
    configOf,
    call: (handle, tool, args) => callTool(configOf(handle), tool, args),
    brain: () => rig.adapter.handles[0] as FakeHandle,
    workerHandle: (index = 0) =>
      rig.adapter.handles.filter((h) => h.agentId.startsWith('worker-'))[index] as FakeHandle,
    async close() {
      await rig.service.shutdown()
      await bridge.close()
      rig.close()
      api.cleanup()
      web.cleanup()
    }
  }
}

/** Runs git in a repo with the fixture identity. */
export function gitIn(cwd: string, ...args: string[]): string {
  return git(cwd, ...args).trim()
}

export function gitFails(cwd: string, ...args: string[]): boolean {
  try {
    execFileSync('git', args, { cwd, env: gitFixtureEnv, stdio: 'ignore' })
    return false
  } catch {
    return true
  }
}
