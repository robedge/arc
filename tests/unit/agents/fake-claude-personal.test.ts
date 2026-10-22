import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const fake = resolve('tests/e2e/fixtures/fake-claude.mjs')
let tmp: string | undefined
let server: Server | undefined

afterEach(() => {
  server?.close()
  server = undefined
  if (tmp) rmSync(tmp, { recursive: true, force: true })
  tmp = undefined
})

interface Played {
  code: number | null
  stderr: string
  log: Record<string, unknown>[]
  texts: string[]
  results: { text: string; isError: boolean }[]
  permissionCalls: Record<string, unknown>[]
}

/** Runs the fake with `args`, a script and a stub bridge that allows every permission request. */
async function play(
  args: (paths: { config: string; dir: string }) => string[],
  steps: unknown[],
  mcpServers: (url: string) => Record<string, unknown> = (url) => ({ arc: { url } })
): Promise<Played> {
  tmp = mkdtempSync(join(tmpdir(), 'arc-fake-personal-'))
  const permissionCalls: Record<string, unknown>[] = []
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (d: Buffer) => (body += d.toString()))
    req.on('end', () => {
      const msg = JSON.parse(body) as { id?: number; method: string; params?: unknown }
      res.setHeader('content-type', 'application/json')
      if (msg.method === 'tools/call') {
        permissionCalls.push((msg.params as { arguments: Record<string, unknown> }).arguments)
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: { content: [{ type: 'text', text: JSON.stringify({ behavior: 'allow' }) }] }
          })
        )
      } else {
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }))
      }
    })
  })
  await new Promise<void>((r) => server?.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  const config = join(tmp, 'mcp.json')
  writeFileSync(config, JSON.stringify({ mcpServers: mcpServers(`http://127.0.0.1:${port}/`) }))
  const script = join(tmp, 's.jsonl')
  writeFileSync(script, steps.map((s) => JSON.stringify(s)).join('\n'))
  const logFile = join(tmp, 'fake.log')
  const child = spawn(process.execPath, [fake, '-p', ...args({ config, dir: tmp })], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      FAKE_CLAUDE_SCRIPT: script,
      FAKE_CLAUDE_LOG: logFile
    },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  let out = ''
  let err = ''
  child.stdout.on('data', (d: Buffer) => (out += d.toString()))
  child.stderr.on('data', (d: Buffer) => (err += d.toString()))
  child.stdin.end()
  const code = await new Promise<number | null>((r) => child.on('close', r))
  const lines = out
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map(
      (l) =>
        JSON.parse(l) as {
          message?: {
            content?: {
              type: string
              text?: string
              is_error?: boolean
              content?: { text: string }[]
            }[]
          }
        }
    )
  const blocks = lines.flatMap((l) => l.message?.content ?? [])
  let log: Record<string, unknown>[] = []
  try {
    log = readFileSync(logFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
  } catch {
    // The fake logs nothing when it never started a session run.
  }
  return {
    code,
    stderr: err,
    log,
    texts: blocks.filter((b) => b.type === 'text').map((b) => b.text ?? ''),
    results: blocks
      .filter((b) => b.type === 'tool_result')
      .map((b) => ({ text: b.content?.[0]?.text ?? '', isError: b.is_error === true })),
    permissionCalls
  }
}

const valid = ({ config }: { config: string }): string[] => [
  '--setting-sources',
  'project',
  '--mcp-config',
  config,
  '--strict-mcp-config'
]

describe('the fake CLI argv assertion', () => {
  it('lets the flag set Arc agents start with through', async () => {
    const played = await play(
      ({ config, dir }) => {
        writeFileSync(join(dir, 'hooks.json'), JSON.stringify({ hooks: { SessionStart: [] } }))
        return [...valid({ config }), '--settings', join(dir, 'hooks.json')]
      },
      [{ say: 'ok' }, { result: true }]
    )
    expect(played.code).toBe(0)
    expect(played.log.some((r) => 'argvViolation' in r)).toBe(false)
  })

  it.each([
    [
      'a setting source other than project',
      ['--setting-sources', 'user,project'],
      /setting-sources/
    ],
    ['--mcp-config without --strict-mcp-config', ['--mcp-config', '/x.json'], /strict-mcp-config/]
  ])('exits with code 2 for %s', async (_name, args, message) => {
    const played = await play(() => args, [{ say: 'never' }])
    expect(played.code).toBe(2)
    expect(played.stderr).toMatch(message)
    expect(played.log.some((r) => 'argvViolation' in r)).toBe(true)
    expect(played.texts).toEqual([])
  })

  it('exits with code 2 when --settings holds anything but hooks', async () => {
    const played = await play(
      ({ dir }) => {
        writeFileSync(
          join(dir, 'bad.json'),
          JSON.stringify({ hooks: {}, permissions: { allow: ['Bash'] } })
        )
        return ['--settings', join(dir, 'bad.json')]
      },
      [{ say: 'never' }]
    )
    expect(played.code).toBe(2)
    expect(played.stderr).toMatch(/only "hooks".*hooks, permissions/)
  })
})

describe('the fake CLI personal MCP step', () => {
  const servers = (url: string): Record<string, unknown> => ({
    // The user's server comes first: the bridge is still found by its name.
    figma: { command: 'figma-mcp' },
    arc: { url }
  })

  it('asks the permission tool about mcp__<server>__<tool> for a configured server', async () => {
    const played = await play(
      valid,
      [
        { personalTool: { server: 'figma', tool: 'get_file', input: { file: 'abc' } } },
        { result: true }
      ],
      servers
    )
    expect(played.code).toBe(0)
    expect(played.permissionCalls).toHaveLength(1)
    expect(played.permissionCalls[0]).toMatchObject({
      tool_name: 'mcp__figma__get_file',
      input: { file: 'abc' }
    })
    expect(played.log.find((r) => 'personalMcp' in r)?.['personalMcp']).toEqual({
      server: 'figma',
      tool: 'get_file',
      configured: true
    })
    expect(played.results[0]).toMatchObject({ isError: false })
  })

  it('fails the call, without asking, when the server is not in the --mcp-config file', async () => {
    const played = await play(
      valid,
      [{ personalTool: { server: 'github', tool: 'search', input: {} } }, { result: true }],
      servers
    )
    expect(played.permissionCalls).toEqual([])
    expect(played.results).toEqual([{ text: 'server not configured: github', isError: true }])
    expect(played.log.find((r) => 'personalMcp' in r)?.['personalMcp']).toMatchObject({
      configured: false
    })
  })

  it('logs the ARC_* markers of the agent', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'arc-fake-personal-'))
    const logFile = join(tmp, 'fake.log')
    const child = spawn(process.execPath, [fake, '-p', '--setting-sources', 'project'], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        FAKE_CLAUDE_LOG: logFile,
        ARC_AGENT: '1',
        ARC_AGENT_ROLE: 'brain',
        ARC_PROVIDER: 'claude'
      },
      stdio: ['pipe', 'ignore', 'ignore']
    })
    child.stdin.end()
    await new Promise((r) => child.on('close', r))
    const records = readFileSync(logFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(records.find((r) => 'arcEnv' in r)?.['arcEnv']).toEqual({
      ARC_AGENT: '1',
      ARC_AGENT_ROLE: 'brain',
      ARC_PROVIDER: 'claude'
    })
  })
})
