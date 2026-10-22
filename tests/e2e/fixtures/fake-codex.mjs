#!/usr/bin/env node
// Stand-in for the `codex` CLI, used by e2e and unit tests. No model call is made.
//
// Modes (decided from argv):
//   --version      prints `codex-cli <FAKE_CODEX_VERSION>` (default 0.162.1; FAKE_CODEX_VERSION_FILE, when the file
//                  exists, overrides it).
//   login status   prints the login state; FAKE_CODEX_AUTH=ok (default) | signed_out | api_key.
//                  ok prints "Logged in using ChatGPT" (exit 0), api_key prints "Logged in using an
//                  API key" (exit 0), signed_out prints "Not logged in" (exit 1).
//   app-server     a scripted JSON-RPC app-server over stdio (below).
//
// A missing Codex is simulated by pointing HARNESS_CODEX_BIN at a path that does not exist.
//
// ---- app-server ---------------------------------------------------------------------------
// Speaks the protocol of codex-cli 0.162.x as recorded in tests/fixtures/codex/0.162.1/real-turn.jsonl:
// one JSON object per line, no `jsonrpc` field. It answers these client requests by itself:
//   initialize            userAgent `arc/<FAKE_CODEX_VERSION> (...)`.
//   account/read          FAKE_CODEX_AUTH: ok (ChatGPT account), api_key, signed_out (account null).
//   model/list            fake-deep (default) and fake-fast, plus fake-hidden when includeHidden is true.
//                         FAKE_CODEX_MODELS (JSON array of ids or entries) replaces the list, FAKE_CODEX_MODELS_PAGE=n pages it
//                         (nextCursor), FAKE_CODEX_MODELS_FAIL=1 answers with an error.
//   skills/list           one entry per cwd with the skills of FAKE_CODEX_SKILLS (JSON array of names or entries
//                         {name, description, path, scope, enabled}); FAKE_CODEX_SKILLS_FAIL=1 answers with an error.
//   config/read           {config:{mcp_servers}} from FAKE_CODEX_MCP_SERVERS (a JSON object of server name to entry,
//                         default {}); the entries may hold env values and tokens, as the real answer does.
//                         FAKE_CODEX_CONFIG_FAIL=1 answers with an error.
//   mcpServerStatus/list  one entry per server of FAKE_CODEX_MCP_TOOLS (a JSON object of server name to an object of
//                         tool name to its annotations, e.g. {"figma":{"read":{"readOnlyHint":true},"write":{}}}),
//                         the way the real answer lists tools (`tools` keyed by tool name, `annotations` only when
//                         the tool has some). FAKE_CODEX_MCP_STATUS_FAIL=1 answers with an error.
//   account/rateLimits/read   {rateLimits:{primary,secondary,planType,...}} like the real answer (no model call).
//                         Default: primary usedPercent 12 over 300 minutes, secondary 30 over 10080, planType pro.
//                         FAKE_CODEX_RATE_LIMITS (JSON: the `rateLimits` object, or just {primary,secondary}) replaces it;
//                         "none" answers with both windows null (a provider that reports no limit).
//                         FAKE_CODEX_RATE_LIMITS_FILE, when the file exists, wins and is read on every call, so a test can
//                         change the numbers between reads. FAKE_CODEX_RATE_LIMITS_FAIL=1 answers with an error.
//                         A running agent can push the same shape with {"emit":{"method":"account/rateLimits/updated",
//                         "params":{"rateLimits":{...}}}}.
//   thread/start, thread/resume   picks the scenario, answers with the thread, then emits thread/started and the
//                         MCP startup statuses of the `arc` server (FAKE_CODEX_ARC_STATUS=ready (default) | failed |
//                         never). FAKE_CODEX_RESUME_FAIL=1 makes thread/resume fail with "thread not found".
//   turn/interrupt        answers {} at once. If a scripted turn is running it is then ended the way the real
//                         app-server does (spike S6): turn/completed with status "interrupted", then
//                         serverRequest/resolved for every request still waiting. The script skips ahead to its
//                         next {"expect":"turn/start"}. Not while {"ignoreInterrupt":true} is in force.
//   turn/steer            answers {turnId} while a turn runs, else an error "no active turn to steer".
// Every other client request (turn/start, ...) waits in an inbox until a script step {"expect":...} takes it.
//
// Scenario selection (like fake-claude): FAKE_CODEX_SCRIPT is the default file; with FAKE_CODEX_SCRIPT_DIR,
// `<dir>/<role>.jsonl` wins when it exists. The role is FAKE_CODEX_ROLE, else the marker `[arc-role:<role>]` in the
// thread's developerInstructions. A worker tries `<dir>/worker-<slug>.jsonl` first (marker `[arc-worker:<slug>]`).
// A brain started with thread/resume tries `<dir>/brain-resumed-<n>.jsonl` (n counts resumed brain starts in
// FAKE_CODEX_LOG), then `<dir>/brain-resumed.jsonl`. With no script: one turn that says "ok".
//
// Environment:
//   FAKE_CODEX_LOG   If set, appends one JSON record per line: {"argv"} and {"env"} at start, {"recv"} for every
//                    client line, {"send"} for every line written to the client, {"thread"} at thread/start|resume,
//                    {"mcpResult"} for an mcp step, {"shell"} for a shell step.
//   FAKE_CODEX_THREAD_ID   the id thread/start answers with (default: a fresh one per run).
//
// Scenario lines (one JSON object per line; blank lines and lines starting with # are ignored). Strings inside any
// step may use {{THREAD_ID}}, {{TURN_ID}}, {{CWD}} and {{saved.<key>.<path>}}. Any step may carry
// "when":{"saved":"key.path","equals":"x"} (or "notEquals") and runs only then.
//   {"expect":"turn/start"}         wait for the client's request, answer it ({turn:{id,...}}) and make the turn active.
//                                   Options: "text":"substr" (only a request whose text contains it),
//                                   "responseDelayMs":n (answer late; the client's turn is "starting" meanwhile),
//                                   "fail":"message" (answer turn/start with a JSON-RPC error; no turn starts).
//                                   Any other method (e.g. "turn/steer") is answered with {} .
//   {"turnStarted":true}            emit turn/started for the active turn.
//   {"emit":{"method","params"}}    write a notification. threadId (and turnId for item/* and thread/tokenUsage/*)
//                                   are filled in when absent. "delay":ms sleeps first.
//   {"say":"text"}                  an agentMessage item: item/started, one item/agentMessage/delta, item/completed.
//   {"turnCompleted":"completed"}   emit turn/completed ("interrupted" and "failed" work too; "error":"msg" for failed)
//                                   after a thread/tokenUsage/updated. The turn is over. "usageUpdates":n sends n updates
//                                   (default 1), "duplicateUsage":true re-sends the last one unchanged. `total` is
//                                   cumulative for the thread, `last` is one request (input 120 incl. 40 cached, output 30).
//   {"usage":n}                     n thread/tokenUsage/updated notifications mid-turn, as the real app-server sends one
//                                   per request while a turn runs. Follow with "turnCompleted" and "usageUpdates":0 to
//                                   end the turn without a further update.
//   {"request":{"method","params"},"saveAs":"k"}
//                                   a server request with a fresh id; waits for the client's response (stored under k),
//                                   then emits serverRequest/resolved. Ends early when the turn is interrupted.
//   {"shell":"cmd","id":"c1"}       a commandExecution item that really runs `cmd` with sh -c in the thread's cwd:
//                                   item/started, item/completed with the output. "approval":true first asks
//                                   item/commandExecution/requestApproval (the command is shown as the zsh wrapper) and runs
//                                   only on "accept"; "decline" completes the item as declined; "cancel" ends the turn
//                                   as interrupted. "saveAs":"k" keeps the approval response. "run":"cmd2" runs cmd2
//                                   instead of the command the item shows (so a scenario can ask to `git push` without pushing).
//   {"write":{"path","content"},"id":"f1"}
//                                   a fileChange item that really writes the file (path relative to the cwd), with the
//                                   same "approval":true / "saveAs" behaviour using item/fileChange/requestApproval.
//   {"mcp":{"tool":"x","args":{}},"id":"m1"}
//                                   call the bridge tool x: a real streamable-HTTP MCP call to the url of
//                                   config.mcp_servers.arc in thread/start, with the bearer token from the env var
//                                   named by bearer_token_env_var (ARC_BRIDGE_TOKEN). Emits an mcpToolCall item around
//                                   it; logs {"mcpResult":{tool,isError,text}}. "approval":true asks
//                                   mcpServer/elicitation/request first (a personal server in "prompt" mode). "saveAs":"k"
//                                   stores {isError,text}.
//   {"sleep":ms}                    wait (ends early when the turn is interrupted).
//   {"stderr":"text"}               write to stderr.
//   {"ignoreInterrupt":true}        later turn/interrupt requests are answered but change nothing.
//   {"ignoreSignals":true}          ignore SIGINT and SIGTERM (only SIGKILL stops the process).
//   {"ignoreStdinClose":true}       closing stdin no longer ends the process (so stop() has to signal it).
//   {"exit":code}                   exit now.
//
// When the script ends the process stays alive until stdin closes, then exits 0.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join } from 'node:path'
import { createInterface } from 'node:readline'

const args = process.argv.slice(2)
const env = process.env
// FAKE_CODEX_VERSION_FILE names a file read on every run, so a test can "update" the tool while Arc runs.
const VERSION = (() => {
  const file = env.FAKE_CODEX_VERSION_FILE
  if (file && existsSync(file)) return readFileSync(file, 'utf8').trim()
  return env.FAKE_CODEX_VERSION ?? '0.162.1'
})()
const auth = env.FAKE_CODEX_AUTH ?? 'ok'

function log(record) {
  if (!env.FAKE_CODEX_LOG) return
  appendFileSync(env.FAKE_CODEX_LOG, JSON.stringify(record) + '\n')
}

if (args[0] === '--version') {
  console.log(`codex-cli ${VERSION}`)
  process.exit(0)
}

if (args[0] === 'login' && args[1] === 'status') {
  if (auth === 'signed_out') {
    console.log('Not logged in')
    process.exit(1)
  }
  console.log(auth === 'api_key' ? 'Logged in using an API key' : 'Logged in using ChatGPT')
  process.exit(0)
}

if (args[0] !== 'app-server') {
  console.error(`fake-codex: unsupported arguments: ${args.join(' ')}`)
  process.exit(2)
}

// ---- app-server --------------------------------------------------------------------------

log({ argv: args })
log({
  env: {
    keys: Object.keys(env).sort(),
    ARC_AGENT: env.ARC_AGENT,
    ARC_AGENT_ROLE: env.ARC_AGENT_ROLE,
    ARC_PROVIDER: env.ARC_PROVIDER,
    CODEX_HOME: env.CODEX_HOME,
    hasBridgeToken: Boolean(env.ARC_BRIDGE_TOKEN)
  }
})

const INTERRUPTED = Symbol('interrupted')
const state = {
  threadId: null,
  cwd: process.cwd(),
  config: {},
  turnId: null,
  turnActive: false,
  turnCounter: 0,
  ignoreInterrupt: false,
  ignoreStdinClose: false,
  interrupted: false,
  fireInterrupt: () => {},
  interruptP: new Promise(() => {}),
  saved: {},
  nextServerId: 0,
  pendingServer: new Map(),
  scriptStarted: false
}
/** Client requests no script step has taken yet. */
const inbox = []
let wake = () => {}

function write(obj) {
  log({ send: obj })
  return new Promise((resolve) => process.stdout.write(JSON.stringify(obj) + '\n', () => resolve()))
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function exitNow(code) {
  await new Promise((resolve) => process.stdout.write('', () => resolve()))
  process.exit(code)
}

// ---- templating ----------------------------------------------------------------------------

function lookup(path) {
  let value = state.saved
  for (const part of path.split('.')) value = value?.[part]
  return value
}

function sub(value) {
  if (typeof value === 'string') {
    const whole = /^\{\{(.+?)\}\}$/.exec(value)
    const resolve = (name) => {
      if (name === 'THREAD_ID') return state.threadId
      if (name === 'TURN_ID') return state.turnId
      if (name === 'CWD') return state.cwd
      if (name.startsWith('saved.')) return lookup(name.slice(6))
      return `{{${name}}}`
    }
    if (whole) return resolve(whole[1])
    return value.replace(/\{\{(.+?)\}\}/g, (_m, name) => String(resolve(name) ?? ''))
  }
  if (Array.isArray(value)) return value.map(sub)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sub(v)]))
  }
  return value
}

function whenOk(step) {
  if (!step.when) return true
  const actual = lookup(step.when.saved)
  if (step.when.equals !== undefined) return actual === step.when.equals
  if (step.when.notEquals !== undefined) return actual !== step.when.notEquals
  return true
}

// ---- notifications -------------------------------------------------------------------------

function notify(method, params) {
  const filled = { ...params }
  if (filled.threadId === undefined) filled.threadId = state.threadId
  if (
    filled.turnId === undefined &&
    (method.startsWith('item/') || method.startsWith('thread/tokenUsage'))
  ) {
    filled.turnId = state.turnId
  }
  return write({ method, params: filled, emittedAtMs: Date.now() })
}

function turnObject(status, extra = {}) {
  return {
    id: state.turnId,
    rootTurnId: state.turnId,
    items: [],
    itemsView: 'notLoaded',
    status,
    error: null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
    ...extra
  }
}

// Token usage, like the real app-server: `last` is one request (input 120 incl. 40 cached, output 30), `total` is
// cumulative for the thread across turns. A turn sends one update by default; {"turnCompleted":..., "usageUpdates":2}
// sends two requests' worth, and "duplicateUsage":true re-sends the final update unchanged (same total and last).
const usageTotal = { input: 0, output: 0, cached: 0 }

async function sendUsage(count) {
  let update
  for (let i = 0; i < count; i += 1) {
    usageTotal.input += 120
    usageTotal.output += 30
    usageTotal.cached += 40
    update = {
      tokenUsage: {
        total: usage(usageTotal.input, usageTotal.output, usageTotal.cached),
        last: usage(120, 30, 40),
        modelContextWindow: 258400
      }
    }
    await notify('thread/tokenUsage/updated', update)
  }
  return update
}

async function completeTurn(status, error, usageUpdates = 1, duplicateUsage = false) {
  const update = await sendUsage(usageUpdates)
  if (duplicateUsage && update) await notify('thread/tokenUsage/updated', update)
  await notify('thread/status/changed', { status: { type: 'idle' } })
  await notify('turn/completed', {
    turn: turnObject(status, {
      durationMs: 25,
      error: error ? { message: error, codexErrorInfo: 'other', additionalDetails: null } : null
    })
  })
  state.turnActive = false
}

function usage(input, output, cached) {
  return {
    totalTokens: input + output,
    inputTokens: input,
    cachedInputTokens: cached,
    cacheWriteInputTokens: 0,
    outputTokens: output,
    reasoningOutputTokens: 0
  }
}

// ---- interrupt -----------------------------------------------------------------------------

function newTurn() {
  state.turnCounter += 1
  state.turnId = `fake-turn-${state.turnCounter}`
  state.turnActive = true
  state.interrupted = false
  state.interruptP = new Promise((resolve) => {
    state.fireInterrupt = () => resolve(INTERRUPTED)
  })
}

/** Resolves with the value, or with INTERRUPTED when the active turn is interrupted first. */
function interruptible(promise) {
  if (!state.turnActive) return promise
  return Promise.race([promise, state.interruptP])
}

/** The real app-server's order (spike S6): turn/completed first, then serverRequest/resolved. */
async function finishInterrupted() {
  await sleep(20)
  await completeTurn('interrupted')
  for (const id of [...state.pendingServer.keys()]) {
    state.pendingServer.delete(id)
    await notify('serverRequest/resolved', { requestId: id })
  }
  state.interrupted = false
}

// ---- server requests -----------------------------------------------------------------------

/** Sends a server request and waits for the response. Resolves INTERRUPTED if the turn is interrupted first. */
async function serverRequest(method, params, saveAs) {
  const id = state.nextServerId++
  const response = new Promise((resolve) => state.pendingServer.set(id, resolve))
  await write({ method, id, params })
  const result = await interruptible(response)
  if (result === INTERRUPTED) return INTERRUPTED
  state.pendingServer.delete(id)
  if (saveAs) state.saved[saveAs] = result
  await notify('serverRequest/resolved', { requestId: id })
  return result
}

function zshWrapper(cmd) {
  return `/bin/zsh -lc '${cmd.replaceAll("'", "'\\''")}'`
}

/** Asks for approval of `kind`. Returns 'accept', 'decline', 'cancel' or INTERRUPTED. */
async function ask(method, params, saveAs) {
  const result = await serverRequest(method, params, saveAs)
  if (result === INTERRUPTED) return INTERRUPTED
  const answer = result?.decision ?? result?.action
  if (answer === 'accept' || answer === 'decline' || answer === 'cancel') return answer
  return 'decline'
}

// ---- items ---------------------------------------------------------------------------------

let itemCounter = 0
const itemId = (step, prefix) => step.id ?? `${prefix}-${++itemCounter}`

async function runShell(step) {
  const command = sub(step.shell)
  const id = itemId(step, 'exec')
  const actions = [{ type: 'unknown', command }]
  const base = {
    type: 'commandExecution',
    id,
    pluginId: null,
    scriptPath: null,
    command: zshWrapper(command),
    cwd: state.cwd,
    processId: null,
    source: 'agent',
    commandActions: actions
  }
  await notify('item/started', {
    item: {
      ...base,
      status: 'inProgress',
      aggregatedOutput: null,
      exitCode: null,
      durationMs: null
    }
  })
  if (step.approval) {
    const answer = await ask(
      'item/commandExecution/requestApproval',
      {
        kind: 'command',
        threadId: state.threadId,
        turnId: state.turnId,
        itemId: id,
        startedAtMs: Date.now(),
        environmentId: 'local',
        command: base.command,
        cwd: state.cwd,
        commandActions: actions,
        availableDecisions: ['accept', 'cancel']
      },
      step.saveAs
    )
    if (answer === INTERRUPTED) return INTERRUPTED
    if (answer !== 'accept') {
      await notify('item/completed', {
        item: {
          ...base,
          status: 'declined',
          aggregatedOutput: null,
          exitCode: null,
          durationMs: null
        }
      })
      if (answer === 'cancel') {
        await completeTurn('interrupted')
        return 'cancelled'
      }
      return undefined
    }
  }
  const outcome = await interruptible(
    new Promise((resolve) => {
      const child = spawn('sh', ['-c', step.run ?? command], { cwd: state.cwd, env: process.env })
      let out = ''
      child.stdout.on('data', (d) => (out += d))
      child.stderr.on('data', (d) => (out += d))
      child.on('close', (code) => resolve({ code: code ?? 1, out }))
    })
  )
  if (outcome === INTERRUPTED) return INTERRUPTED
  log({ shell: { cmd: command, code: outcome.code, out: outcome.out } })
  await notify('item/completed', {
    item: {
      ...base,
      status: outcome.code === 0 ? 'completed' : 'failed',
      aggregatedOutput: outcome.out,
      exitCode: outcome.code,
      durationMs: 5
    }
  })
  return undefined
}

async function runWrite(step) {
  const { path, content } = sub(step.write)
  const file = isAbsolute(path) ? path : join(state.cwd, path)
  const id = itemId(step, 'patch')
  const existed = existsSync(file)
  const change = {
    path: file,
    kind: { type: existed ? 'update' : 'add', move_path: null },
    diff: `+${String(content).trimEnd().split('\n').join('\n+')}\n`
  }
  await notify('item/started', {
    item: { type: 'fileChange', id, changes: [change], status: 'inProgress' }
  })
  if (step.approval) {
    const answer = await ask(
      'item/fileChange/requestApproval',
      {
        threadId: state.threadId,
        turnId: state.turnId,
        itemId: id,
        startedAtMs: Date.now(),
        reason: null,
        grantRoot: null
      },
      step.saveAs
    )
    if (answer === INTERRUPTED) return INTERRUPTED
    if (answer !== 'accept') {
      await notify('item/completed', {
        item: { type: 'fileChange', id, changes: [change], status: 'declined' }
      })
      if (answer === 'cancel') {
        await completeTurn('interrupted')
        return 'cancelled'
      }
      return undefined
    }
  }
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
  await notify('item/completed', {
    item: { type: 'fileChange', id, changes: [change], status: 'completed' }
  })
  return undefined
}

// ---- the bridge ----------------------------------------------------------------------------

function bridge() {
  const arc = state.config?.mcp_servers?.arc
  if (!arc?.url) throw new Error('fake-codex: thread/start carried no config.mcp_servers.arc.url')
  const token = env[arc.bearer_token_env_var ?? 'ARC_BRIDGE_TOKEN']
  return { url: arc.url, headers: token ? { authorization: `Bearer ${token}` } : {} }
}

async function rpc(server, body, expectResponse = true) {
  const res = await fetch(server.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...server.headers
    },
    body: JSON.stringify(body)
  })
  const text = await res.text()
  if (!expectResponse) return null
  if (!res.ok) throw new Error(`fake-codex: bridge answered ${res.status}: ${text}`)
  const type = res.headers.get('content-type') ?? ''
  const messages = type.includes('text/event-stream')
    ? text
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => JSON.parse(l.slice(5).trim()))
    : [JSON.parse(text)]
  const answer = messages.find((m) => m.id === body.id)
  if (!answer) throw new Error('fake-codex: no answer in ' + text)
  if (answer.error) throw new Error('fake-codex: ' + JSON.stringify(answer.error))
  return answer.result
}

let mcpInitialized = false
let toolCounter = 0
async function callMcp(tool, toolArgs) {
  const server = bridge()
  if (!mcpInitialized) {
    mcpInitialized = true
    await rpc(server, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'fake-codex', version: '0' }
      }
    })
    await rpc(server, { jsonrpc: '2.0', method: 'notifications/initialized' }, false)
  }
  return rpc(server, {
    jsonrpc: '2.0',
    id: 100 + ++toolCounter,
    method: 'tools/call',
    params: { name: tool, arguments: toolArgs ?? {}, _meta: { progressToken: 'p' + toolCounter } }
  })
}

async function runMcp(step) {
  const { tool } = step.mcp
  const toolArgs = sub(step.mcp.args) ?? {}
  const id = itemId(step, 'mcp')
  const item = {
    type: 'mcpToolCall',
    id,
    server: 'arc',
    tool,
    arguments: toolArgs,
    appContext: null,
    mcpAppUi: null,
    pluginId: null,
    readOnlyHint: null
  }
  await notify('item/started', {
    item: { ...item, status: 'inProgress', result: null, error: null, durationMs: null }
  })
  if (step.approval) {
    const answer = await ask(
      'mcpServer/elicitation/request',
      {
        threadId: state.threadId,
        turnId: state.turnId,
        serverName: 'arc',
        mode: 'form',
        message: `Allow the arc MCP server to run tool "${tool}"?`,
        requestedSchema: { type: 'object', properties: {} },
        _meta: {
          codex_approval_kind: 'mcp_tool_call',
          tool_description: '',
          tool_params: toolArgs,
          tool_params_display: []
        }
      },
      step.saveAs
    )
    if (answer === INTERRUPTED) return INTERRUPTED
    if (answer !== 'accept') {
      await notify('item/completed', {
        item: {
          ...item,
          status: 'failed',
          result: null,
          error: { message: 'user cancelled MCP tool call' },
          durationMs: 1
        }
      })
      return undefined
    }
  }
  const outcome = await interruptible(
    (async () => {
      try {
        const result = await callMcp(tool, toolArgs)
        return {
          isError: result.isError === true,
          text: (result.content ?? []).map((c) => c.text ?? '').join(''),
          content: result.content ?? []
        }
      } catch (error) {
        const text = String(error?.message ?? error)
        return { isError: true, text, content: [{ type: 'text', text }] }
      }
    })()
  )
  if (outcome === INTERRUPTED) return INTERRUPTED
  log({ mcpResult: { tool, isError: outcome.isError, text: outcome.text } })
  if (step.saveAs && !step.approval) state.saved[step.saveAs] = outcome
  await notify('item/completed', {
    item: {
      ...item,
      status: outcome.isError ? 'failed' : 'completed',
      result: outcome.isError
        ? null
        : { content: outcome.content, structuredContent: null, _meta: null },
      error: outcome.isError ? { message: outcome.text } : null,
      durationMs: 7
    }
  })
  return undefined
}

// ---- the script ----------------------------------------------------------------------------

const DEFAULT_SCRIPT = [
  { expect: 'turn/start' },
  { turnStarted: true },
  { say: 'ok' },
  { turnCompleted: 'completed' }
]

function resolveScriptPath(instructions, resumed) {
  const dir = env.FAKE_CODEX_SCRIPT_DIR
  if (dir) {
    const marker = /\[arc-role:([A-Za-z0-9_-]+)\]/.exec(instructions ?? '')
    const role = env.FAKE_CODEX_ROLE ?? marker?.[1]
    const worker = /\[arc-worker:([A-Za-z0-9_-]+)\]/.exec(instructions ?? '')
    if (role === 'worker' && worker) {
      const specific = join(dir, `worker-${worker[1]}.jsonl`)
      if (existsSync(specific)) return specific
    }
    if (role === 'brain' && resumed) {
      for (const name of [`brain-resumed-${resumedBrainRuns()}.jsonl`, 'brain-resumed.jsonl']) {
        if (existsSync(join(dir, name))) return join(dir, name)
      }
    }
    if (role) {
      const candidate = join(dir, role + '.jsonl')
      if (existsSync(candidate)) return candidate
    }
  }
  return env.FAKE_CODEX_SCRIPT
}

/** How many resumed brain threads the log holds, this one included (it was logged first). */
function resumedBrainRuns() {
  if (!env.FAKE_CODEX_LOG || !existsSync(env.FAKE_CODEX_LOG)) return 1
  let runs = 0
  for (const line of readFileSync(env.FAKE_CODEX_LOG, 'utf8').split('\n')) {
    if (!line.includes('"thread"')) continue
    try {
      const t = JSON.parse(line).thread
      if (t?.resumed && t.role === 'brain') runs += 1
    } catch {
      // not a record of ours
    }
  }
  return Math.max(runs, 1)
}

function loadScript(path) {
  if (!path) return DEFAULT_SCRIPT
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => JSON.parse(l))
}

function textOf(request) {
  return (request.params?.input ?? []).map((i) => i.text ?? '').join('\n')
}

async function takeRequest(method, text) {
  for (;;) {
    const at = inbox.findIndex(
      (r) => r.method === method && (text === undefined || textOf(r).includes(text))
    )
    if (at >= 0) return inbox.splice(at, 1)[0]
    await new Promise((resolve) => (wake = resolve))
  }
}

async function execStep(step) {
  if (step.expect) {
    const request = await takeRequest(step.expect, step.text)
    if (step.expect === 'turn/start' && step.fail) {
      await write({ id: request.id, error: { code: -32603, message: step.fail } })
      return undefined
    }
    if (step.expect === 'turn/start') {
      newTurn()
      if (step.responseDelayMs) await sleep(step.responseDelayMs)
      await write({ id: request.id, result: { turn: turnObject('inProgress') } })
    } else {
      await write({ id: request.id, result: {} })
    }
    return undefined
  }
  if (step.turnStarted) {
    await notify('thread/status/changed', { status: { type: 'active', activeFlags: [] } })
    await notify('turn/started', { turn: turnObject('inProgress', { startedAt: 1 }) })
    return undefined
  }
  if (step.emit) {
    if (step.delay) await interruptible(sleep(step.delay))
    await notify(step.emit.method, sub(step.emit.params ?? {}))
    return undefined
  }
  if (step.say !== undefined) {
    const id = itemId(step, 'msg')
    const text = sub(step.say)
    const item = { id, text: '', phase: 'final_answer', memoryCitation: null }
    await notify('item/started', { item: { type: 'agentMessage', ...item } })
    await notify('item/agentMessage/delta', { itemId: id, delta: text })
    await notify('item/completed', { item: { type: 'agentMessage', ...item, text } })
    return undefined
  }
  if (step.usage !== undefined) {
    await sendUsage(step.usage)
    return undefined
  }
  if (step.turnCompleted) {
    await completeTurn(
      step.turnCompleted,
      step.error,
      step.usageUpdates,
      step.duplicateUsage === true
    )
    return undefined
  }
  if (step.request) {
    const result = await serverRequest(
      step.request.method,
      sub(step.request.params ?? {}),
      step.saveAs
    )
    return result === INTERRUPTED ? INTERRUPTED : undefined
  }
  if (step.shell !== undefined) return runShell(step)
  if (step.write) return runWrite(step)
  if (step.mcp) return runMcp(step)
  if (step.sleep !== undefined) {
    const r = await interruptible(sleep(step.sleep))
    return r === INTERRUPTED ? INTERRUPTED : undefined
  }
  if (step.stderr !== undefined) {
    process.stderr.write(String(step.stderr))
    return undefined
  }
  if (step.ignoreInterrupt) {
    state.ignoreInterrupt = true
    return undefined
  }
  if (step.ignoreSignals) {
    process.on('SIGINT', () => {})
    process.on('SIGTERM', () => {})
    return undefined
  }
  if (step.ignoreStdinClose) {
    state.ignoreStdinClose = true
    setInterval(() => {}, 1000) // keeps the event loop alive once stdin has ended
    return undefined
  }
  if (step.exit !== undefined) await exitNow(step.exit)
  return undefined
}

async function runScript(steps) {
  let i = 0
  const skipToExpect = () => {
    while (i < steps.length && !steps[i].expect) i++
  }
  while (i < steps.length) {
    const step = steps[i++]
    if (!whenOk(step)) continue
    if (state.interrupted && !step.expect) {
      await finishInterrupted()
      i--
      skipToExpect()
      continue
    }
    const result = await execStep(step)
    if (result === INTERRUPTED) {
      await finishInterrupted()
      skipToExpect()
    } else if (result === 'cancelled') {
      skipToExpect()
    }
  }
}

// ---- requests the client sends -------------------------------------------------------------

function account() {
  if (auth === 'signed_out') return { account: null, requiresOpenaiAuth: true }
  return {
    account:
      auth === 'api_key'
        ? { type: 'apiKey' }
        : { type: 'chatgpt', email: 'fake@example.com', planType: 'pro' },
    requiresOpenaiAuth: true
  }
}

function threadObject(id, cwd, model) {
  return {
    id,
    sessionId: id,
    cwd,
    ephemeral: false,
    modelProvider: 'openai',
    model,
    preview: '',
    status: { type: 'idle' }
  }
}

async function onThread(msg, resumed) {
  const p = msg.params ?? {}
  if (resumed && env.FAKE_CODEX_RESUME_FAIL === '1') {
    await write({ id: msg.id, error: { code: -32600, message: `thread not found: ${p.threadId}` } })
    return
  }
  state.threadId = resumed
    ? p.threadId
    : (env.FAKE_CODEX_THREAD_ID ?? `fake-thread-${randomUUID()}`)
  state.cwd = p.cwd ?? state.cwd
  state.config = p.config ?? {}
  const instructions = p.developerInstructions ?? ''
  const role = env.FAKE_CODEX_ROLE ?? /\[arc-role:([A-Za-z0-9_-]+)\]/.exec(instructions)?.[1]
  const slug = /\[arc-worker:([A-Za-z0-9_-]+)\]/.exec(instructions)?.[1]
  log({
    thread: {
      method: msg.method,
      resumed,
      role,
      slug,
      cwd: p.cwd,
      model: p.model,
      modelProvider: p.modelProvider,
      approvalPolicy: p.approvalPolicy,
      approvalsReviewer: p.approvalsReviewer,
      sandbox: p.sandbox,
      config: p.config,
      hasDeveloperInstructions: Boolean(p.developerInstructions),
      hasBaseInstructions: p.baseInstructions !== undefined
    }
  })
  const thread = threadObject(state.threadId, state.cwd, p.model ?? 'fake-model')
  await write({
    id: msg.id,
    result: {
      thread,
      model: p.model ?? 'fake-model',
      modelProvider: 'openai',
      cwd: state.cwd,
      approvalPolicy: p.approvalPolicy ?? 'untrusted',
      sandbox: p.sandbox ?? 'workspace-write'
    }
  })
  await notify('thread/started', { thread })
  if (state.config?.mcp_servers?.arc && (env.FAKE_CODEX_ARC_STATUS ?? 'ready') !== 'never') {
    const status = env.FAKE_CODEX_ARC_STATUS ?? 'ready'
    await notify('mcpServer/startupStatus/updated', {
      name: 'arc',
      status: 'starting',
      error: null,
      failureReason: null
    })
    await notify('mcpServer/startupStatus/updated', {
      name: 'arc',
      status,
      error: status === 'failed' ? 'fake-codex: could not reach the bridge' : null,
      failureReason: null
    })
  }
  if (!state.scriptStarted) {
    state.scriptStarted = true
    const steps = loadScript(resolveScriptPath(instructions, resumed))
    void runScript(steps).catch((error) => {
      process.stderr.write(`fake-codex: script failed: ${error?.stack ?? error}\n`)
      process.exit(3)
    })
  }
}

async function onRequest(msg) {
  switch (msg.method) {
    case 'initialize':
      await write({
        id: msg.id,
        result: {
          userAgent: `arc/${VERSION} (Fake OS 1.0; arm64) fake-codex (arc; 0)`,
          codexHome: env.CODEX_HOME ?? '<CODEX_HOME>',
          platformFamily: 'unix',
          platformOs: 'macos'
        }
      })
      return
    case 'account/read':
      await notify('account/updated', { authMode: 'chatgpt', planType: 'pro' })
      await write({ id: msg.id, result: account() })
      return
    case 'account/rateLimits/read': {
      if (env.FAKE_CODEX_RATE_LIMITS_FAIL === '1') {
        await write({
          id: msg.id,
          error: { code: -32603, message: 'account/rateLimits/read failed' }
        })
        return
      }
      const file = env.FAKE_CODEX_RATE_LIMITS_FILE
      const raw =
        file && existsSync(file) ? readFileSync(file, 'utf8').trim() : env.FAKE_CODEX_RATE_LIMITS
      const nowSeconds = Math.floor(Date.now() / 1000)
      const base = {
        limitId: 'codex',
        limitName: null,
        credits: null,
        planType: 'pro',
        rateLimitReachedType: null
      }
      let limits
      if (raw === 'none') limits = { ...base, primary: null, secondary: null }
      else if (raw) limits = { ...base, ...JSON.parse(raw) }
      else {
        limits = {
          ...base,
          primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: nowSeconds + 5 * 3600 },
          secondary: {
            usedPercent: 30,
            windowDurationMins: 10080,
            resetsAt: nowSeconds + 7 * 86400
          }
        }
      }
      await write({
        id: msg.id,
        result: { rateLimits: limits, rateLimitsByLimitId: { codex: limits } }
      })
      return
    }
    case 'skills/list': {
      if (env.FAKE_CODEX_SKILLS_FAIL === '1') {
        await write({ id: msg.id, error: { code: -32603, message: 'skills/list failed' } })
        return
      }
      const skills = JSON.parse(env.FAKE_CODEX_SKILLS ?? '[]').map((s) => {
        const entry = typeof s === 'string' ? { name: s } : s
        return {
          description: `The ${entry.name} skill`,
          path: `/fake-codex/skills/${entry.name}/SKILL.md`,
          scope: 'user',
          enabled: true,
          ...entry
        }
      })
      const cwds = msg.params?.cwds?.length ? msg.params.cwds : [state.cwd]
      await write({
        id: msg.id,
        result: { data: cwds.map((cwd) => ({ cwd, skills, errors: [] })) }
      })
      return
    }
    case 'config/read': {
      if (env.FAKE_CODEX_CONFIG_FAIL === '1') {
        await write({ id: msg.id, error: { code: -32603, message: 'config/read failed' } })
        return
      }
      const mcp_servers = JSON.parse(env.FAKE_CODEX_MCP_SERVERS ?? '{}')
      await write({ id: msg.id, result: { config: { model: 'fake', mcp_servers }, origins: {} } })
      return
    }
    case 'mcpServerStatus/list': {
      if (env.FAKE_CODEX_MCP_STATUS_FAIL === '1') {
        await write({ id: msg.id, error: { code: -32603, message: 'mcpServerStatus/list failed' } })
        return
      }
      const servers = JSON.parse(env.FAKE_CODEX_MCP_TOOLS ?? '{}')
      const data = Object.entries(servers).map(([name, tools]) => ({
        name,
        pluginId: null,
        authStatus: 'unsupported',
        runtimeStatus: 'connected',
        toolsError: null,
        resources: [],
        resourceTemplates: [],
        tools: Object.fromEntries(
          Object.entries(tools).map(([tool, annotations]) => [
            tool,
            {
              name: tool,
              inputSchema: { type: 'object' },
              ...(Object.keys(annotations).length > 0 ? { annotations } : {})
            }
          ])
        )
      }))
      await write({ id: msg.id, result: { data, nextCursor: null } })
      return
    }
    case 'model/list': {
      if (env.FAKE_CODEX_MODELS_FAIL === '1') {
        await write({ id: msg.id, error: { code: -32603, message: 'model/list failed' } })
        return
      }
      const entry = (model, extra = {}) => ({
        id: model,
        model,
        displayName: model,
        hidden: false,
        isDefault: false,
        ...extra
      })
      const all = env.FAKE_CODEX_MODELS
        ? JSON.parse(env.FAKE_CODEX_MODELS).map((m) =>
            typeof m === 'string' ? entry(m) : entry(m.model, m)
          )
        : [
            entry('fake-deep', { displayName: 'Fake Deep', isDefault: true }),
            entry('fake-fast', { displayName: 'Fake Fast' }),
            entry('fake-hidden', { hidden: true })
          ]
      const visible = msg.params?.includeHidden === true ? all : all.filter((m) => !m.hidden)
      const size = Number(env.FAKE_CODEX_MODELS_PAGE ?? 0) || visible.length || 1
      const start = Number(msg.params?.cursor ?? 0)
      const end = start + size
      await write({
        id: msg.id,
        result: {
          data: visible.slice(start, end),
          nextCursor: end < visible.length ? String(end) : null
        }
      })
      return
    }
    case 'thread/start':
      await onThread(msg, false)
      return
    case 'thread/resume':
      await onThread(msg, true)
      return
    case 'turn/interrupt':
      await write({ id: msg.id, result: {} })
      if (state.turnActive && !state.ignoreInterrupt) {
        state.interrupted = true
        state.fireInterrupt()
      }
      return
    case 'turn/steer':
      if (state.turnActive) await write({ id: msg.id, result: { turnId: state.turnId } })
      else await write({ id: msg.id, error: { code: -32600, message: 'no active turn to steer' } })
      return
    default:
      inbox.push(msg)
      wake()
  }
}

const reader = createInterface({ input: process.stdin })
reader.on('line', (line) => {
  if (line.trim() === '') return
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    log({ recv: line })
    return
  }
  log({ recv: msg })
  if (msg.method === undefined && msg.id !== undefined) {
    const waiting = state.pendingServer.get(msg.id)
    if (waiting) waiting(msg.result ?? msg.error)
    return
  }
  if (msg.method !== undefined && msg.id !== undefined) void onRequest(msg)
})
reader.on('close', () => {
  if (!state.ignoreStdinClose) void exitNow(0)
})
