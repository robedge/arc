// SPIKE (A2UI), throwaway. Starts the real bridge with a fake brain and asks ONE real CLI turn per
// provider to call show_surface. Makes real model calls:
//   node_modules/.bin/tsx scripts/spike-a2ui.ts <outDir> claude|codex|cursor [...]
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BridgeServer } from '../src/main/bridge/bridge-server'
import type { BridgeAgent, BridgeServices } from '../src/main/bridge/types'
import type { Surface } from '../src/shared/surface'

const PROMPT =
  'Use the arc MCP tool show_surface to show me a small engineering dashboard with made-up numbers: a heading, ' +
  'three KPI tiles in a grid (weekly commits, open PRs, reviews done) each with a change versus last week, ' +
  'a bar chart of code reviews per contributor for five people, a line chart of commits per day for a week, ' +
  'a warning callout about three stale pull requests with a "Ping reviewers" button, a table of those three pull requests, ' +
  'and a text field for a note. The button must send back the note as the user left it. ' +
  'If the tool refuses the call, fix it and try again, at most 3 times. Then reply with one short sentence. Do not do anything else.'

const [outDir, ...providers] = process.argv.slice(2)
if (!outDir || providers.length === 0) throw new Error('usage: spike-a2ui.ts <outDir> <provider>...')

function run(cmd: string, args: string[], cwd: string, env: Record<string, string>, out: string) {
  return new Promise<number>((resolve) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let text = ''
    child.stdout.on('data', (d: Buffer) => (text += d.toString()))
    child.stderr.on('data', (d: Buffer) => (text += d.toString()))
    const timer = setTimeout(() => child.kill('SIGKILL'), 240_000)
    child.on('close', (code) => {
      clearTimeout(timer)
      writeFileSync(out, text)
      resolve(code ?? -1)
    })
  })
}

const bridge = new BridgeServer({
  configDir: join(outDir, 'mcp'),
  log: { warn: console.warn, error: console.error }
})
await bridge.start()

for (const provider of providers) {
  const accepted: Surface[] = []
  const services = {
    showSurface: (_agent: BridgeAgent, input: Surface) => {
      accepted.push(input)
      return { ok: true as const, surfaceId: input.surfaceId }
    }
  } as unknown as BridgeServices
  const agent: BridgeAgent = {
    sessionId: 'spike',
    agentId: `brain-${provider}`,
    role: 'brain',
    provider: provider as BridgeAgent['provider']
  }
  const reg = bridge.registerAgent(agent, services)
  const config = JSON.parse(readFileSync(reg.configPath, 'utf8')) as {
    mcpServers: { arc: { url: string; headers: { Authorization: string } } }
  }
  const { url, headers } = config.mcpServers.arc
  const token = headers.Authorization.replace(/^Bearer /, '')
  const cwd = join(outDir, `work-${provider}`)
  mkdirSync(cwd, { recursive: true })
  const log = join(outDir, `${provider}.log`)
  const started = Date.now()
  let code = -1
  if (provider === 'claude') {
    code = await run(
      'claude',
      ['-p', PROMPT, '--mcp-config', reg.configPath, '--strict-mcp-config', '--allowedTools', 'mcp__arc__show_surface',
       '--output-format', 'stream-json', '--verbose', '--model', 'sonnet'],
      cwd, {}, log
    )
  } else if (provider === 'codex') {
    code = await run(
      'codex',
      ['exec', '--json', '--skip-git-repo-check', '-s', 'read-only',
       '-c', `mcp_servers.arc.url="${url}"`, '-c', 'mcp_servers.arc.bearer_token_env_var="ARC_BRIDGE_TOKEN"',
       '-c', 'mcp_servers.arc.default_tools_approval_mode="approve"', PROMPT],
      cwd, { ARC_BRIDGE_TOKEN: token }, log
    )
  } else if (provider === 'cursor') {
    mkdirSync(join(cwd, '.cursor'), { recursive: true })
    writeFileSync(join(cwd, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { arc: { url, headers } } }))
    code = await run(
      'cursor-agent',
      ['-p', '--output-format', 'stream-json', '--approve-mcps', '--trust', '--workspace', cwd, '--model', 'auto', PROMPT],
      cwd, {}, log
    )
  }
  writeFileSync(join(outDir, `${provider}.accepted.json`), JSON.stringify(accepted, null, 2))
  console.log(`${provider}: exit ${code}, ${Math.round((Date.now() - started) / 1000)} s, accepted ${accepted.length} surface(s)`)
  bridge.revokeAgent(agent.agentId)
}
await bridge.close()
