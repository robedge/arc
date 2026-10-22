import { randomBytes } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { Server as McpLowServer } from '@modelcontextprotocol/sdk/server/index.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { PROGRESS_INTERVAL_MS, startKeepalive } from './keepalive'
import { CURSOR_POLL_MS, pollsLongCalls, waitForTool, WaitRegistry } from './polling'
import type { PollOutcome } from './polling'
import { toolsForRole } from './tools/registry'
import { BridgeToolError, MCP_SERVER_NAME } from './types'
import type { AnyBridgeTool, BridgeAgent, BridgeServices } from './types'

export { PROGRESS_INTERVAL_MS }
const MAX_BODY_BYTES = 1024 * 1024
/** The path prefix of the empty stand-in for a switched-off user server. */
const OFF_PREFIX = '/off/'

export interface BridgeLog {
  warn: (message: string, ...rest: unknown[]) => void
  error: (message: string, ...rest: unknown[]) => void
}

export interface BridgeServerOptions {
  /** `userData/mcp`; one `<agentId>.json` (mode 0600) per running agent. */
  configDir: string
  log: BridgeLog
  progressIntervalMs?: number
  /** After this long a Cursor agent's call comes back pending (default 50 s, under Cursor's 60 s limit). */
  pollMs?: number
}

/** What an agent registration hands back: the endpoint and token, and the `--mcp-config` file Claude takes. */
export interface BridgeRegistration {
  url: string
  token: string
  configPath: string
}

/** The part of the bridge the orchestrator uses; tests can fake it. */
export interface BridgeRegistry {
  registerAgent(agent: BridgeAgent, services: BridgeServices): BridgeRegistration
  revokeAgent(agentId: string): void
}

interface AgentEntry {
  agent: BridgeAgent
  services: BridgeServices
  configPath: string
  calls: Set<AbortController>
  /** The calls handed back as pending; only a Cursor agent has it. */
  waits: WaitRegistry | undefined
}

function jsonText(value: unknown): string {
  return JSON.stringify(value) ?? 'null'
}

function toolResult(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: jsonText(value) }] }
}

function pollResult(outcome: PollOutcome<unknown>): CallToolResult {
  return toolResult(outcome.done ? outcome.value : outcome.pending)
}

function toolError(code: string, message: string): CallToolResult {
  return { content: [{ type: 'text', text: jsonText({ error: code, message }) }], isError: true }
}

function sendStatus(res: ServerResponse, status: number, message: string, allow?: string): void {
  if (res.headersSent) return
  res.writeHead(status, {
    'Content-Type': 'application/json',
    ...(allow ? { Allow: allow } : {})
  })
  res.end(JSON.stringify({ error: message }))
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    size += buf.length
    if (size > MAX_BODY_BYTES) throw new Error('body too large')
    chunks.push(buf)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

/**
 * The local MCP server the agents call (tech spec 2.4): streamable HTTP in stateless mode, bound to
 * 127.0.0.1 on a random port. Every request needs a loopback `Host` and the bearer token minted for
 * one agent; the token decides the agent's role and so which tools it is shown and may call.
 */
export class BridgeServer implements BridgeRegistry {
  private server: Server | undefined
  private portNumber = 0
  private readonly tokens = new Map<string, AgentEntry>()
  private readonly byAgent = new Map<string, string>()
  private readonly progressMs: number

  constructor(private readonly options: BridgeServerOptions) {
    this.progressMs = options.progressIntervalMs ?? PROGRESS_INTERVAL_MS
  }

  get port(): number {
    return this.portNumber
  }

  get url(): string {
    return `http://127.0.0.1:${this.portNumber}/mcp`
  }

  async start(): Promise<void> {
    if (this.server) return
    const server = createServer((req, res) => {
      void this.handle(req, res).catch((error: unknown) => {
        this.options.log.error('bridge request failed', error)
        sendStatus(res, 500, 'internal error')
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
    this.portNumber = (server.address() as AddressInfo).port
    this.server = server
  }

  async close(): Promise<void> {
    for (const agentId of [...this.byAgent.keys()]) this.revokeAgent(agentId)
    const server = this.server
    this.server = undefined
    if (!server) return
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  /** Mints a token for the agent and writes its `--mcp-config` file (mode 0600). Rewritten on every spawn. */
  registerAgent(agent: BridgeAgent, services: BridgeServices): BridgeRegistration {
    if (this.portNumber === 0) throw new Error('The MCP bridge is not running.')
    this.revokeAgent(agent.agentId)
    const token = randomBytes(32).toString('hex')
    mkdirSync(this.options.configDir, { recursive: true, mode: 0o700 })
    const configPath = join(this.options.configDir, `${agent.agentId}.json`)
    const config = {
      mcpServers: {
        [MCP_SERVER_NAME]: {
          type: 'http',
          url: this.url,
          headers: { Authorization: `Bearer ${token}` }
        }
      }
    }
    writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 })
    this.tokens.set(token, {
      agent,
      services,
      configPath,
      calls: new Set(),
      waits: pollsLongCalls(agent)
        ? new WaitRegistry(this.options.pollMs ?? CURSOR_POLL_MS)
        : undefined
    })
    this.byAgent.set(agent.agentId, token)
    return { url: this.url, token, configPath }
  }

  /** Revokes the agent's token, aborts its calls in flight and deletes its config file. */
  revokeAgent(agentId: string): void {
    const token = this.byAgent.get(agentId)
    if (token === undefined) return
    this.byAgent.delete(agentId)
    const entry = this.tokens.get(token)
    this.tokens.delete(token)
    if (!entry) return
    for (const call of entry.calls) call.abort()
    entry.calls.clear()
    entry.waits?.clear()
    rmSync(entry.configPath, { force: true })
  }

  private isLoopbackHost(host: string | undefined): boolean {
    if (host === undefined) return false
    const port = String(this.portNumber)
    return host === `127.0.0.1:${port}` || host === `localhost:${port}` || host === `[::1]:${port}`
  }

  private authenticate(req: IncomingMessage): AgentEntry | undefined {
    const header = req.headers.authorization
    if (header === undefined) return undefined
    const match = /^Bearer\s+(\S+)$/i.exec(header)
    if (!match?.[1]) return undefined
    return this.tokens.get(match[1])
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.isLoopbackHost(req.headers.host)) {
      sendStatus(res, 403, 'forbidden host')
      return
    }
    const path = (req.url ?? '').split('?')[0]
    if (path !== undefined && path.startsWith(OFF_PREFIX) && path.length > OFF_PREFIX.length) {
      await this.handleOff(req, res)
      return
    }
    if (path !== '/mcp') {
      sendStatus(res, 404, 'not found')
      return
    }
    const entry = this.authenticate(req)
    if (!entry) {
      sendStatus(res, 401, 'unauthorized')
      return
    }
    if (req.method !== 'POST') {
      // Stateless: there is no standalone stream to open and no session to close.
      sendStatus(res, 405, 'method not allowed', 'POST')
      return
    }
    let body: unknown
    try {
      body = await readJsonBody(req)
    } catch {
      sendStatus(res, 400, 'invalid body')
      return
    }

    const mcp = this.buildMcpServer(entry)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.on('close', () => {
      void transport.close()
      void mcp.close()
    })
    await mcp.connect(transport)
    await transport.handleRequest(req, res, body)
  }

  /**
   * `/off/<server>`: the stand-in for a user server switched off (tech spec 2.5). It answers `initialize`
   * and an empty `tools/list` and nothing else (any other method is "method not found"), under the same
   * token as `/mcp`, so Cursor loads the same-name session entry instead of the real server.
   */
  private async handleOff(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.authenticate(req)) {
      sendStatus(res, 401, 'unauthorized')
      return
    }
    if (req.method !== 'POST') {
      sendStatus(res, 405, 'method not allowed', 'POST')
      return
    }
    let body: unknown
    try {
      body = await readJsonBody(req)
    } catch {
      sendStatus(res, 400, 'invalid body')
      return
    }
    const mcp = new McpLowServer(
      { name: MCP_SERVER_NAME, version: '1.0.0' },
      { capabilities: { tools: {} } }
    )
    mcp.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [] }))
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.on('close', () => {
      void transport.close()
      void mcp.close()
    })
    await mcp.connect(transport)
    await transport.handleRequest(req, res, body)
  }

  /** One server per request (stateless), with only the tools the agent's role may use. */
  private buildMcpServer(entry: AgentEntry): McpServer {
    const mcp = new McpServer({ name: MCP_SERVER_NAME, version: '1.0.0' })
    // Claude's CLI calls request_permission itself; a Cursor agent asks through ACP and is not offered it.
    const tools = toolsForRole(entry.agent.role).filter(
      (t) => !(entry.agent.provider === 'cursor' && t.name === 'request_permission')
    )
    // Only a Cursor agent can be handed a pending reply, so only it is shown the tool to follow one up.
    if (entry.waits) tools.push(waitForTool)
    for (const tool of tools) this.registerTool(mcp, entry, tool)
    return mcp
  }

  private registerTool(mcp: McpServer, entry: AgentEntry, tool: AnyBridgeTool): void {
    mcp.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputShape,
        ...(tool.readOnly ? { annotations: { readOnlyHint: true } } : {})
      },
      async (args: Record<string, unknown>, extra): Promise<CallToolResult> => {
        const call = new AbortController()
        entry.calls.add(call)
        const onAbort = (): void => call.abort()
        extra.signal.addEventListener('abort', onAbort, { once: true })
        // A pending Cursor call goes on after this request ends, so it stays in `entry.calls`.
        let handedOff = false

        // Long-blocking tools (a question, a plan, a merge) keep the client's call alive.
        const stopKeepalive = tool.longRunning
          ? startKeepalive({
              progressToken: extra._meta?.progressToken,
              intervalMs: this.progressMs,
              send: (progressToken, progress) =>
                extra.sendNotification({
                  method: 'notifications/progress',
                  params: { progressToken, progress }
                })
            })
          : undefined
        try {
          const context = { agent: entry.agent, services: entry.services, signal: call.signal }
          const waits = entry.waits
          if (waits === undefined) return toolResult(await tool.run(args, context))
          if (tool.name === waitForTool.name) {
            return pollResult(await waits.wait(String(args['waitId'])))
          }
          // Cursor cancels a call after 60 s: hand back "pending" at about 50 s and let the work go on.
          const work = Promise.resolve().then(() => tool.run(args, context))
          const outcome = await waits.run(work, tool.waitingFor ?? 'the result')
          if (!outcome.done) {
            handedOff = true
            const release = (): void => void entry.calls.delete(call)
            work.then(release, release)
          }
          return pollResult(outcome)
        } catch (error: unknown) {
          if (error instanceof BridgeToolError) return toolError(error.code, error.message)
          this.options.log.error(`bridge tool ${tool.name} failed`, error)
          return toolError('internal', 'The tool failed unexpectedly. Details are in the logs.')
        } finally {
          stopKeepalive?.()
          extra.signal.removeEventListener('abort', onAbort)
          if (!handedOff) entry.calls.delete(call)
        }
      }
    )
  }
}
