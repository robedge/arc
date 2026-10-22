import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CursorStartRequest } from '../../../src/main/agents/agent-adapter'
import { buildSessionParams } from '../../../src/main/agents/cursor/cursor-config'
import { cursorBrainDenyText, cursorDenyText } from '../../../src/main/agents/cursor/cursor-deny'
import { normalizeCursorApproval } from '../../../src/main/agents/cursor/cursor-normalize'
import type { CursorApprovalRequest } from '../../../src/main/agents/cursor/cursor-types'
import { LoadCatalogue, type LoadCatalogueDeps } from '../../../src/main/personal/load-catalogue'
import { McpToolCatalogue } from '../../../src/main/personal/mcp-tool-catalogue'
import { applyCursorMcp, PersonalConfigService } from '../../../src/main/personal/personal-config'
import type { RequestAction } from '../../../src/main/sessions/codex-approvals'
import { createCursorApprovalHandler } from '../../../src/main/sessions/cursor-approvals'
import { loadKey, type AgentLoadOff } from '../../../src/shared/types/agent-load'
import { createLoadSelection } from '../../../src/main/personal/load-selection'
import { useTempDir } from '../helpers/temp-dir'

const dir = useTempDir('arc-cursor-mcp-')
const FAKE = join(__dirname, '..', 'helpers', 'fake-mcp-user-server.mjs')
const SECRET = 'sk-never-in-the-listing'

function write(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value))
}

function setup(): { home: string; repo: string } {
  const home = join(dir(), 'home')
  const repo = join(dir(), 'repos', 'api')
  mkdirSync(join(home, '.cursor'), { recursive: true })
  mkdirSync(repo, { recursive: true })
  return { home, repo }
}

function catalogue(
  home: string,
  projects: string[],
  ready: boolean,
  extra: Partial<LoadCatalogueDeps> = {}
): LoadCatalogue {
  return new LoadCatalogue({
    getHome: () => home,
    projectPaths: () => projects,
    plugins: { sources: () => Promise.resolve([]) },
    codex: { ready: () => true, servers: () => Promise.resolve({ servers: [], degraded: false }) },
    cursor: { ready: () => ready },
    ...extra
  })
}

describe('loadKey.cursorMcp', () => {
  it('prefixes the name', () => {
    expect(loadKey.cursorMcp('github')).toBe('cursor-mcp:github')
  })
})

describe('LoadCatalogue.listCursor', () => {
  it('is unavailable while Cursor is not ok, and reads nothing', async () => {
    const { home, repo } = setup()
    write(join(home, '.cursor', 'mcp.json'), { mcpServers: { a: { command: 'x' } } })
    expect(await catalogue(home, [repo], false).listCursor()).toEqual({
      items: [],
      state: 'unavailable'
    })
  })

  it('lists the home and project servers with their source, and never a secret', async () => {
    const { home, repo } = setup()
    write(join(home, '.cursor', 'mcp.json'), {
      mcpServers: {
        zeta: { command: 'node', args: ['s.js'], env: { TOKEN: SECRET } },
        alpha: { url: 'https://example.invalid/mcp', headers: { Authorization: SECRET } }
      }
    })
    write(join(repo, '.cursor', 'mcp.json'), { mcpServers: { local: { command: 'x' } } })
    const data = await catalogue(home, [repo], true, {
      knownTools: () => new Map([['alpha', ['search', 'fetch']]])
    }).listCursor()
    expect(data.state).toBe('ok')
    expect(data.items.map((i) => [i.key, i.kind, i.detail])).toEqual([
      ['cursor-mcp:alpha', 'cursor-mcp', 'Your Cursor servers'],
      ['cursor-mcp:local', 'cursor-mcp', '.cursor/mcp.json in api'],
      ['cursor-mcp:zeta', 'cursor-mcp', 'Your Cursor servers']
    ])
    expect(data.items[0]?.tokens).toBe(Math.ceil('alpha-search\nalpha-fetch\n'.length / 4))
    expect(data.items[1]?.tokens).toBeNull()
    expect(JSON.stringify(data)).not.toContain(SECRET)
  })

  it('is ok and empty without any file, and unreadable for a broken one', async () => {
    const { home, repo } = setup()
    expect(await catalogue(home, [repo], true).listCursor()).toEqual({ items: [], state: 'ok' })
    write(join(repo, '.cursor', 'mcp.json'), '{ not json')
    expect(await catalogue(home, [repo], true).listCursor()).toEqual({
      items: [],
      state: 'unreadable'
    })
  })
})

describe('PersonalConfigService.cursorMcp and applyCursorMcp', () => {
  function service(home: string, off: AgentLoadOff, warn = vi.fn()): PersonalConfigService {
    return new PersonalConfigService({
      baseDir: join(dir(), 'cfg'),
      plugins: { sources: () => Promise.resolve([]) },
      off: createLoadSelection(() => off),
      getHome: () => home,
      log: { warn }
    })
  }

  it('returns the servers each role switched off', async () => {
    const { home, repo } = setup()
    write(join(home, '.cursor', 'mcp.json'), {
      mcpServers: { github: { command: 'a' }, linear: { url: 'http://x.invalid' } }
    })
    const off: AgentLoadOff = {
      brain: [loadKey.cursorMcp('github'), loadKey.cursorMcp('gone'), loadKey.codexMcp('linear')],
      workers: [loadKey.cursorMcp('linear')]
    }
    const svc = service(home, off)
    expect(await svc.cursorMcp(repo, 'brain')).toEqual({
      servers: ['github', 'linear'],
      off: ['github'],
      degraded: false
    })
    expect(await svc.cursorMcp(repo, 'workers')).toEqual({
      servers: ['github', 'linear'],
      off: ['linear'],
      degraded: false
    })
  })

  it('fails closed when a file is unreadable: every stored key counts', async () => {
    const { home, repo } = setup()
    write(join(home, '.cursor', 'mcp.json'), '{ broken')
    const svc = service(home, { brain: [], workers: [loadKey.cursorMcp('github')] })
    expect(await svc.cursorMcp(repo, 'workers')).toEqual({
      servers: [],
      off: ['github'],
      degraded: true
    })
  })

  it('puts the off servers into the start options, never the arc name', () => {
    const cursor: CursorStartRequest['cursor'] = {}
    expect(
      applyCursorMcp(cursor, { servers: [], off: ['github', 'arc'], degraded: false })
    ).toEqual(['github'])
    expect(cursor.offMcpServers).toEqual(['github'])
    const none: CursorStartRequest['cursor'] = {}
    applyCursorMcp(none, { servers: ['a'], off: [], degraded: false })
    expect(none.offMcpServers).toBeUndefined()
  })
})

describe('session entries and the deny files', () => {
  const bridge = { url: 'http://127.0.0.1:4242/mcp', token: 'tok' }
  const request = (offMcpServers: string[] | undefined): CursorStartRequest =>
    ({
      provider: 'cursor',
      cwd: '/w',
      bridge,
      cursor: offMcpServers ? { offMcpServers } : {}
    }) as unknown as CursorStartRequest

  it('adds a same-name /off/<server> http entry with the Authorization header for each off server', () => {
    const params = buildSessionParams(request(['github', 'my server']))
    expect(params.mcpServers).toEqual([
      {
        type: 'http',
        name: 'arc',
        url: bridge.url,
        headers: [{ name: 'Authorization', value: 'Bearer tok' }]
      },
      {
        type: 'http',
        name: 'github',
        url: 'http://127.0.0.1:4242/off/github',
        headers: [{ name: 'Authorization', value: 'Bearer tok' }]
      },
      {
        type: 'http',
        name: 'my server',
        url: 'http://127.0.0.1:4242/off/my%20server',
        headers: [{ name: 'Authorization', value: 'Bearer tok' }]
      }
    ])
  })

  it('has only the arc entry when nothing is off', () => {
    expect(buildSessionParams(request(undefined)).mcpServers.map((s) => s.name)).toEqual(['arc'])
  })

  it('writes Mcp(<server>:*) into the worker and brain deny files', () => {
    const worker = JSON.parse(
      cursorDenyText({ worktree: '/w', denyDirs: [], offMcp: ['github', 'linear'] })
    ) as { permissions: { deny: string[] } }
    expect(worker.permissions.deny).toEqual(
      expect.arrayContaining(['Mcp(github:*)', 'Mcp(linear:*)'])
    )
    const brain = JSON.parse(cursorBrainDenyText(['github'])) as { permissions: { deny: string[] } }
    expect(brain.permissions.deny).toEqual(['Write(**)', 'Mcp(github:*)'])
    expect(cursorDenyText({ worktree: '/w', denyDirs: [] })).not.toContain('Mcp(')
  })
})

function mcpRequest(
  server: string,
  tool: string,
  extra: Partial<CursorApprovalRequest> = {}
): CursorApprovalRequest {
  return {
    agentId: 'worker-w1',
    sessionId: 's',
    requestId: 0,
    toolCallId: 'tc',
    title: `${server}-${tool}: ${tool}`,
    kind: 'other',
    options: [],
    raw: {},
    ...extra
  }
}

describe('normalizeCursorApproval annotations', () => {
  it('reads a read-only hint carried in the request', () => {
    const action = (annotations: Record<string, unknown>) =>
      normalizeCursorApproval(mcpRequest('s', 't', { raw: { toolCall: { annotations } } }))
    expect(action({ readOnlyHint: true })).toMatchObject({ kind: 'mcp', readOnly: 'yes' })
    expect(action({ readOnlyHint: true, destructiveHint: true })).toMatchObject({ readOnly: 'no' })
    expect(action({ readOnlyHint: false })).toMatchObject({ readOnly: 'unknown' })
    expect(normalizeCursorApproval(mcpRequest('s', 't'))).toMatchObject({ readOnly: 'unknown' })
  })
})

describe('McpToolCatalogue.cursorAction', () => {
  let httpServer: Server | undefined
  afterEach(async () => {
    const s = httpServer
    httpServer = undefined
    if (s) {
      s.closeAllConnections()
      await new Promise<void>((resolve) => s.close(() => resolve()))
    }
  })

  async function startHttpServer(seen: string[]): Promise<string> {
    httpServer = createServer((req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405).end()
        return
      }
      seen.push(String(req.headers['x-test'] ?? ''))
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        const mcp = new McpServer({ name: 'fake-mcp-http', version: '1.0.0' })
        mcp.registerTool('lookup', { annotations: { readOnlyHint: true } }, () => ({
          content: [{ type: 'text', text: 'ok' }]
        }))
        mcp.registerTool('remove', { annotations: { destructiveHint: true } }, () => ({
          content: [{ type: 'text', text: 'ok' }]
        }))
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
        res.on('close', () => {
          void transport.close()
          void mcp.close()
        })
        void mcp
          .connect(transport)
          .then(() =>
            transport.handleRequest(req, res, JSON.parse(Buffer.concat(chunks).toString('utf8')))
          )
      })
    })
    await new Promise<void>((resolve) => httpServer?.listen(0, '127.0.0.1', resolve))
    return `http://127.0.0.1:${(httpServer?.address() as AddressInfo).port}/mcp`
  }

  const action = (server: string, tool: string) =>
    ({ kind: 'mcp', server, tool, readOnly: 'unknown' }) as const

  it('asks the stdio server itself: read-only runs, changing and unannotated ask', async () => {
    const { home, repo } = setup()
    write(join(home, '.cursor', 'mcp.json'), {
      mcpServers: {
        files: { command: process.execPath, args: [FAKE], env: { ELECTRON_RUN_AS_NODE: '1' } }
      }
    })
    const catalogue = new McpToolCatalogue({ getHome: () => home })
    expect((await catalogue.cursorAction(action('files', 'lookup'), repo)).readOnly).toBe('yes')
    expect((await catalogue.cursorAction(action('files', 'remove'), repo)).readOnly).toBe('no')
    // Both hints: the rule is readOnly and not destructive, so a destructive tool is never unasked.
    expect((await catalogue.cursorAction(action('files', 'both'), repo)).readOnly).toBe('no')
    expect((await catalogue.cursorAction(action('files', 'plain'), repo)).readOnly).toBe('unknown')
    expect((await catalogue.cursorAction(action('files', 'missing'), repo)).readOnly).toBe(
      'unknown'
    )
  }, 30_000)

  it('asks an http server with its headers, and caches the answer for an hour', async () => {
    const { home, repo } = setup()
    const seen: string[] = []
    const url = await startHttpServer(seen)
    write(join(repo, '.cursor', 'mcp.json'), {
      mcpServers: { remote: { url, headers: { 'x-test': 'yes' } } }
    })
    let clock = 1000
    const catalogue = new McpToolCatalogue({ getHome: () => home, now: () => clock })
    expect((await catalogue.cursorAction(action('remote', 'lookup'), repo)).readOnly).toBe('yes')
    expect(seen.length).toBeGreaterThan(0)
    expect(new Set(seen)).toEqual(new Set(['yes']))
    const calls = seen.length
    clock += 59 * 60_000
    expect((await catalogue.cursorAction(action('remote', 'remove'), repo)).readOnly).toBe('no')
    expect(seen.length).toBe(calls)
    clock += 2 * 60_000
    await catalogue.cursorAction(action('remote', 'lookup'), repo)
    expect(seen.length).toBeGreaterThan(calls)
  })

  it('keeps a request annotation, skips arc, and asks when the server cannot be asked', async () => {
    const { home, repo } = setup()
    write(join(home, '.cursor', 'mcp.json'), {
      mcpServers: { down: { url: 'http://127.0.0.1:9/mcp' }, nodef: {} }
    })
    const list = vi.fn()
    const catalogue = new McpToolCatalogue({
      getHome: () => home,
      listCursorTools: list,
      timeoutMs: 200
    })
    const known = { ...action('down', 't'), readOnly: 'yes' as const }
    expect(await catalogue.cursorAction(known, repo)).toBe(known)
    expect((await catalogue.cursorAction(action('arc', 'echo'), repo)).readOnly).toBe('unknown')
    expect(list).not.toHaveBeenCalled()
    list.mockRejectedValue(new Error('down'))
    expect((await catalogue.cursorAction(action('down', 't'), repo)).readOnly).toBe('unknown')
    expect((await catalogue.cursorAction(action('nodef', 't'), repo)).readOnly).toBe('unknown')
    expect((await catalogue.cursorAction(action('unlisted', 't'), repo)).readOnly).toBe('unknown')
  })

  it('gives up on a server that never answers after the timeout', async () => {
    const { home, repo } = setup()
    write(join(home, '.cursor', 'mcp.json'), { mcpServers: { slow: { url: 'http://x.invalid' } } })
    const catalogue = new McpToolCatalogue({
      getHome: () => home,
      timeoutMs: 50,
      listCursorTools: () => new Promise(() => undefined)
    })
    expect((await catalogue.cursorAction(action('slow', 't'), repo)).readOnly).toBe('unknown')
  })
})

describe('the approval handler with user servers', () => {
  const agent = { sessionId: 's', agentId: 'worker-w1', role: 'worker' } as const

  it('rejects a request for an off server without asking', async () => {
    const requestAction = vi.fn()
    const handler = createCursorApprovalHandler({
      agent,
      requestAction,
      offServers: () => new Set(['github'])
    })
    const decision = await handler.handle(
      mcpRequest('github', 'search'),
      new AbortController().signal
    )
    expect(decision.decision).toBe('reject')
    expect(decision.message).toContain('github')
    expect(requestAction).not.toHaveBeenCalled()
  })

  it('hands the action the catalogue settled to requestAction', async () => {
    const requestAction = vi.fn<RequestAction>(() => Promise.resolve({ allow: true }))
    const resolveMcp = vi.fn(
      (a: { kind: 'mcp'; server: string; tool: string; readOnly: 'yes' | 'no' | 'unknown' }) =>
        Promise.resolve({ ...a, readOnly: 'yes' as const })
    )
    const handler = createCursorApprovalHandler({ agent, requestAction, resolveMcp })
    const decision = await handler.handle(
      mcpRequest('files', 'lookup'),
      new AbortController().signal
    )
    expect(decision).toEqual({ decision: 'allow' })
    expect(requestAction.mock.calls[0]?.[1]).toMatchObject({
      kind: 'mcp',
      server: 'files',
      tool: 'lookup',
      readOnly: 'yes'
    })
  })

  it('asks (the unknown action) when the catalogue throws', async () => {
    const requestAction = vi.fn<RequestAction>(() =>
      Promise.resolve({ allow: false, message: 'no' })
    )
    const handler = createCursorApprovalHandler({
      agent,
      requestAction,
      resolveMcp: () => Promise.reject(new Error('boom'))
    })
    const decision = await handler.handle(mcpRequest('files', 'x'), new AbortController().signal)
    expect(decision.decision).toBe('reject')
    expect(requestAction.mock.calls[0]?.[1]).toMatchObject({ readOnly: 'unknown' })
  })
})

function treeHash(root: string): string {
  const hash = createHash('sha256')
  const walk = (path: string): void => {
    for (const name of readdirSync(path).sort()) {
      const full = join(path, name)
      if (statSync(full).isDirectory()) walk(full)
      else {
        // The privacy cache is rewritten by Cursor itself; its timestamp is not Arc's doing.
        const text = readFileSync(full, 'utf8').replace(/"updatedAt":\s*\d+/g, '')
        hash.update(full).update(text)
      }
    }
  }
  walk(root)
  return hash.digest('hex')
}

describe('~/.cursor stays untouched', () => {
  it('is byte-identical after listing, reading the role selection and asking a server', async () => {
    const { home, repo } = setup()
    write(join(home, '.cursor', 'mcp.json'), {
      mcpServers: {
        files: { command: process.execPath, args: [FAKE], env: { ELECTRON_RUN_AS_NODE: '1' } }
      }
    })
    write(join(home, '.cursor', 'cli-config.json'), { permissions: { allow: ['Shell(ls)'] } })
    write(join(home, '.cursor', 'privacyCache.json'), { updatedAt: 1, mode: 'x' })
    write(join(repo, '.cursor', 'mcp.json'), { mcpServers: { p: { command: 'x' } } })
    const before = treeHash(join(home, '.cursor')) + treeHash(join(repo, '.cursor'))
    await catalogue(home, [repo], true).listCursor()
    const svc = new PersonalConfigService({
      baseDir: join(dir(), 'cfg'),
      plugins: { sources: () => Promise.resolve([]) },
      off: createLoadSelection(() => ({ brain: [], workers: [loadKey.cursorMcp('files')] })),
      getHome: () => home
    })
    await svc.cursorMcp(repo, 'workers')
    await new McpToolCatalogue({ getHome: () => home }).cursorAction(
      { kind: 'mcp', server: 'files', tool: 'lookup', readOnly: 'unknown' },
      repo
    )
    expect(treeHash(join(home, '.cursor')) + treeHash(join(repo, '.cursor'))).toBe(before)
  }, 30_000)
})
