import { MCP_SERVER_NAME } from '../../bridge/types'
import type { CursorStartRequest } from '../agent-adapter'
import type { AcpHttpMcpServer, AcpSessionParams } from './acp-client'

/**
 * What goes into `session/new` and `session/load`, and the child's env (tech spec 2.3, 2.5 and the
 * spike results N1 and M1). Arc's bridge reaches Cursor as an http MCP server in the session
 * params, so the token travels in the ACP pipe and never in argv or a config file.
 */

/**
 * The single switch for Cursor's own sandbox (tech spec 2.4, spike M6). Off until the recorded run
 * shows that `agent --sandbox enabled acp` really confines a worker's writes to its workspace; then
 * set it to `true` and every Cursor agent starts with the flag. (Spike N6: a project `cli.json`
 * cannot carry a `sandbox` key, so the flag is the only per-process switch and nothing in
 * `~/.cursor` is edited.)
 */
export const CURSOR_SANDBOX_ENABLED = false

/** Options placed before the `acp` subcommand. */
export function cursorGlobalArgs(sandbox: boolean = CURSOR_SANDBOX_ENABLED): string[] {
  return sandbox ? ['--sandbox', 'enabled'] : []
}

/**
 * Arc's `arc` MCP server entry. Cursor sends the `Authorization` header on every request. It sends
 * no `progressToken` and times a call out after 60 s (spike M1), which the bridge tools handle.
 */
export function arcMcpServer(bridge: { url: string; token: string }): AcpHttpMcpServer {
  return {
    type: 'http',
    name: MCP_SERVER_NAME,
    url: bridge.url,
    headers: [{ name: 'Authorization', value: `Bearer ${bridge.token}` }]
  }
}

/**
 * The no-op entry for a switched-off user server (tech spec 2.5, spike N2): Cursor replaces a file
 * server by the session entry of the same name, so the real one is never connected. The entry must
 * load, so it points at the bridge's `/off/<server>` route, which answers `initialize` and an empty
 * `tools/list` under the same token.
 */
export function offMcpServer(
  bridge: { url: string; token: string },
  name: string
): AcpHttpMcpServer {
  const url = new URL(bridge.url)
  url.pathname = `/off/${encodeURIComponent(name)}`
  return {
    type: 'http',
    name,
    url: url.toString(),
    headers: [{ name: 'Authorization', value: `Bearer ${bridge.token}` }]
  }
}

/** `session/new` and `session/load` params. A start without a bridge (unit tests) has no MCP servers. */
export function buildSessionParams(options: CursorStartRequest): AcpSessionParams {
  if (!options.bridge) return { cwd: options.cwd, mcpServers: [] }
  const off = [...new Set(options.cursor.offMcpServers ?? [])].filter((n) => n !== MCP_SERVER_NAME)
  return {
    cwd: options.cwd,
    mcpServers: [
      arcMcpServer(options.bridge),
      ...off.map((name) => offMcpServer(options.bridge as { url: string; token: string }, name))
    ]
  }
}

/**
 * The ACP mode of the session: a worker runs in `agent` mode, and the brain in `ask`. Spike M2: in `ask`
 * Arc's MCP tools work and no edit tool is offered, but a shell command still asks permission and runs
 * once allowed, so the brain's approval handler (classifyBrainAction) decides every request.
 */
export function cursorModeFor(access: CursorStartRequest['access']): 'agent' | 'ask' {
  return access === 'brain-readonly' ? 'ask' : 'agent'
}

/**
 * ACP has no system prompt, so Arc's instructions go in front of the first prompt of every start and
 * resume, in an `<arc-instructions>` block.
 */
export function withInstructions(instructions: string | undefined, text: string): string {
  if (!instructions || instructions.trim() === '') return text
  return `<arc-instructions>\n${instructions.trim()}\n</arc-instructions>\n\n${text}`
}

/** `CURSOR_API_KEY` and every other `CURSOR_*` setting: Cursor agents use the subscription login only. */
export function isForbiddenCursorEnvKey(key: string): boolean {
  return key.startsWith('CURSOR_')
}

/**
 * Drops the forbidden keys from the agent env. Arc's own `ARC_*` entries are applied last, so
 * `extraEnv` cannot change who the agent is. The bridge token is not in the env (it is in
 * `session/new`).
 */
export function finishCursorEnv(
  env: Record<string, string>,
  options: CursorStartRequest
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (!isForbiddenCursorEnvKey(key)) out[key] = value
  }
  out['ARC_AGENT'] = '1'
  out['ARC_AGENT_ROLE'] = options.role
  out['ARC_PROVIDER'] = 'cursor'
  return out
}

/**
 * ACP's reject carries no reason, so the adapter tells the agent in front of its next prompt. One
 * line per declined request; `reasons` are already phrased ("Arc declined `git push`. ...").
 */
export function withDeclines(reasons: readonly string[], text: string): string {
  if (reasons.length === 0) return text
  const lines = reasons.map((reason) => `[Arc] ${reason} Don't work around it; call ask_brain.`)
  return `${lines.join('\n')}\n\n${text}`
}
