#!/usr/bin/env node
// Stand-in for the Cursor CLI (`agent` / `cursor-agent`), used by e2e and unit tests. No model call is made.
// Output shapes follow tests/fixtures/cursor/2026.10.19-6bbf2c4 (recorded from the real CLI, scrubbed).
//
// Modes (decided from argv):
//   --version              prints `<FAKE_CURSOR_VERSION>` (default 2026.10.19-6bbf2c4; FAKE_CURSOR_VERSION_FILE, when the
//                          file exists, overrides it).
//   status [--format json] the login state; FAKE_CURSOR_AUTH=ok (default) | signed_out. ok prints
//                          `✓ Logged in as user@example.com` (exit 0); signed_out prints `Not logged in`.
//                          The JSON form prints {status, isAuthenticated, ...}; signed out it is
//                          {"status":"unauthenticated","isAuthenticated":false} (assumed; only the signed-in shape was observed).
//   about [--format json]  version, latest version and tier. FAKE_CURSOR_ABOUT_LATEST (default: the running version)
//                          is the latest version it reports; FAKE_CURSOR_ABOUT_LATEST_FILE, when the file exists, wins.
//   models                 `Available models`, then `<id> - <label>` lines. FAKE_CURSOR_MODELS names a file with those
//                          lines (or just ids); the default is a short list with Auto first.
//   update                 prints a message and exits 0 (nothing is updated).
//   acp                    a scripted Agent Client Protocol server over stdio (below).
//
// A missing Cursor is simulated by pointing HARNESS_CURSOR_BIN at a path that does not exist.
//
// ---- acp ----------------------------------------------------------------------------------
// JSON-RPC 2.0 over stdio, one JSON object per line, shaped like tests/fixtures/cursor/2026.10.19-6bbf2c4/
// m1-agent-turn.jsonl (replies carry "jsonrpc":"2.0"; requests without it are accepted). Answered by the fake itself:
//   initialize            protocol 1, loadSession and http/sse MCP, auth method cursor_login.
//   authenticate          {} (FAKE_CURSOR_AUTH=signed_out: -32000 "Authentication required").
//   session/new           {sessionId, modes (agent/plan/ask), models, configOptions}, then an available_commands_update.
//                         sessionId is FAKE_CURSOR_SESSION_ID or a fresh one. models come from FAKE_CURSOR_MODELS (the
//                         same file as the `models` subcommand: `<id> - <label>` lines, or a JSON array of ids or
//                         {modelId,name}); the default is Auto (`default[]`) and three more, one parameterised.
//                         FAKE_CURSOR_COMMANDS (a JSON array of names or {name,description}, or a path to such a file)
//                         is what the commands update lists (default: none).
//   session/load          {} after replaying FAKE_CURSOR_HISTORY (JSON array of strings, each an agent_message_chunk);
//                         FAKE_CURSOR_RESUME_FAIL=1: -32602 Invalid params, data.message `Session "<id>" not found`.
//   session/set_mode      {} and a current_mode_update. session/set_model: {}, or -32602 for an id not in the list.
//   session/prompt        waits in the inbox until a script step {"expect":"prompt"} takes it.
//   session/cancel        (notification) interrupts the running turn; see {"expect":"cancel"} and the interrupt rules below.
// Any other request is answered -32601 "Method not found".
//
// Scenario selection (like fake-codex): FAKE_CURSOR_SCRIPT is the default file; with FAKE_CURSOR_SCRIPT_DIR,
// `<dir>/<role>.jsonl` wins when it exists. ACP has no system prompt, so the script is chosen at the FIRST
// session/prompt: the role is FAKE_CURSOR_ROLE, else the marker `[arc-role:<role>]` in the prompt (Arc's
// `<arc-instructions>` block), else ARC_AGENT_ROLE of the process env. A worker tries `<dir>/worker-<slug>.jsonl`
// first (marker `[arc-worker:<slug>]`); the merge resolver (slug merge-conflict) then tries `<dir>/resolver.jsonl`.
// After session/load, `worker-<slug>-resumed.jsonl`, `<role>-resumed-<n>.jsonl` (n counts resumed starts of that role
// in FAKE_CURSOR_LOG) and `<role>-resumed.jsonl` are tried before the plain names. With no script: one turn that says "ok".
//
// Scenario lines (one JSON object per line; blank lines and lines starting with # are ignored). Strings inside any
// step may use {{SESSION_ID}}, {{CWD}} and {{saved.<key>.<path>}}. Any step may carry
// "when":{"saved":"key.path","equals":"x"} (or "notEquals") and runs only then.
//   {"expect":"prompt"}             wait for a session/prompt and make it the active turn ("text":"substr" takes only a
//                                   prompt that contains it). Each prompt is one turn; a turn ends with "end".
//   {"expect":"cancel"}             wait for the client's session/cancel; the active prompt then ends with stopReason
//                                   "cancelled" (pending permission requests are resolved first). While this step waits,
//                                   a cancel does not interrupt anything else.
//   {"emit":{...}}                  a session/update whose `update` is the given object ("delay":ms sleeps first).
//   {"text":"hello"}                an agent_message_chunk ("thought":"..." sends an agent_thought_chunk, "title":"..."
//                                   a session_info_update).
//   {"write":{"path","content"},"id":"f1"}
//                                   an edit tool call that really writes the file (path relative to the cwd), shaped like
//                                   M1 (title "Edit File", then the path, then a diff). "approval":true asks first.
//   {"shell":"cmd","id":"c1"}       an execute tool call that really runs `cmd` with sh -c in the cwd and reports
//                                   rawOutput {exitCode,stdout,stderr}. "approval":true asks first ("Not in allowlist:
//                                   cmd") and runs only on an allow option; a rejected call completes with no rawOutput.
//                                   "run":"cmd2" runs cmd2 instead of the command the call shows.
//   {"request":{"toolCall":{...},"options":[...]},"saveAs":"k","then":{"allow-once":[steps],"reject-once":[steps],"cancelled":[steps]}}
//                                   a session/request_permission with a fresh id (0, 1, 2, ...). toolCall defaults to a
//                                   pending execute call; options default to allow-once, allow-always, reject-once. Waits
//                                   for the answer, stores {outcome,optionId} under k, logs {"permission":{...}} and runs
//                                   the `then` steps of the chosen optionId (or "cancelled"). Ends early on session/cancel.
//   {"mcp":{"tool":"x","args":{}},"id":"m1","saveAs":"k","approval":true,"follow":true}
//                                   an MCP tool call (tool_call "MCP: tool", then "arc: x") and a real streamable-HTTP call
//                                   to the bridge named `arc` in the session/new mcpServers, with its Authorization header
//                                   and no progressToken (as Cursor). Logs {"mcpResult":{tool,isError,text}}; saveAs stores
//                                   {isError,text}. "approval":true asks first (title `arc-x: x`). "follow":true: while
//                                   the result is {status:"pending",waitId} the step calls `wait_for` until it is not.
//   {"sleep":ms}                    wait (ends early when the turn is cancelled).
//   {"end":"end_turn"}              answer the active session/prompt with {stopReason} ("end":true is end_turn; any other
//                                   ACP stop reason works). See FAKE_CURSOR_USAGE.
//   {"stderr":"text"}               write to stderr.
//   {"exit":code}                   exit now.
// When the script ends the process stays alive until stdin closes, then exits 0.
//
// Environment:
//   FAKE_CURSOR_LOG   If set, appends one JSON record per line, each with `pid` and (once known) `role` and `slug`:
//                     {"argv"} for every invocation; in acp mode also {"env"} at start, {"recv"} for every client
//                     line, {"send"} for every line written, {"session"} at session/new|load (cwd, mcpServers),
//                     {"agent"} when the script is chosen, {"permission"} for an answered request, {"mcpResult"},
//                     {"shell"}.
//   FAKE_CURSOR_USAGE none (default; what the real Cursor does: no usage anywhere) | prompt (a usage object
//                     {inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens} in the prompt response) | update
//                     (a usage_update notification with the same object, before the response).
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join } from 'node:path'
import { createInterface } from 'node:readline'

const rawArgs = process.argv.slice(2)
// Cursor takes global options before the subcommand: `agent --sandbox enabled acp`.
const sandboxFlag = rawArgs[0] === '--sandbox' ? rawArgs[1] : undefined
const args = sandboxFlag === undefined ? rawArgs : rawArgs.slice(2)
const env = process.env
const VERSION = (() => {
  const file = env.FAKE_CURSOR_VERSION_FILE
  if (file && existsSync(file)) return readFileSync(file, 'utf8').trim()
  return env.FAKE_CURSOR_VERSION ?? '2026.10.19-6bbf2c4'
})()
const auth = env.FAKE_CURSOR_AUTH ?? 'ok'
const latest = (() => {
  const file = env.FAKE_CURSOR_ABOUT_LATEST_FILE
  if (file && existsSync(file)) return readFileSync(file, 'utf8').trim()
  return env.FAKE_CURSOR_ABOUT_LATEST ?? VERSION
})()
const json = args.includes('--format') && args[args.indexOf('--format') + 1] === 'json'

const agent = { role: undefined, slug: undefined }
function log(record) {
  if (!env.FAKE_CURSOR_LOG) return
  const who = args[0] === 'acp' ? { pid: process.pid, role: agent.role, slug: agent.slug } : {}
  appendFileSync(env.FAKE_CURSOR_LOG, JSON.stringify({ ...who, ...record }) + '\n')
}

log({ argv: args, ...(sandboxFlag === undefined ? {} : { sandbox: sandboxFlag }) })

const DEFAULT_MODELS = [
  'auto - Auto (current, default)',
  'composer-2.5 - Composer 2.5',
  'claude-sonnet-5-thinking-high - Claude Sonnet 5 1M Thinking',
  'gpt-5.2 - GPT-5.2'
]

if (args[0] === '--version' || args[0] === '-v') {
  console.log(VERSION)
} else if (args[0] === 'status' || args[0] === 'whoami') {
  if (auth === 'signed_out') {
    if (json)
      console.log(JSON.stringify({ status: 'unauthenticated', isAuthenticated: false }, null, 2))
    else console.log('Not logged in')
  } else if (json) {
    console.log(
      JSON.stringify(
        {
          status: 'authenticated',
          isAuthenticated: true,
          hasAccessToken: true,
          hasRefreshToken: true,
          userInfo: { email: 'user@example.com', userId: 1, createdAt: '2025-12-27T10:58:44.539Z' }
        },
        null,
        2
      )
    )
  } else {
    console.log('✓ Logged in as user@example.com')
  }
} else if (args[0] === 'about') {
  const status = latest === VERSION ? 'up_to_date' : 'update_available'
  if (json) {
    console.log(
      JSON.stringify(
        {
          cliVersion: VERSION,
          latestStatus: status,
          latestVersion: latest,
          model: 'Auto',
          subscriptionTier: 'Free',
          osPlatform: 'darwin',
          osArch: 'arm64',
          userEmail: auth === 'signed_out' ? null : 'user@example.com',
          terminalProgram: 'apple-terminal',
          shell: 'zsh',
          lastRequestId: null
        },
        null,
        2
      )
    )
  } else {
    console.log('About Cursor CLI\n')
    console.log(`CLI Version         ${VERSION}`)
    console.log(
      `Latest              ${latest} (${status === 'up_to_date' ? 'up to date' : 'update available'})`
    )
    console.log('Model               Auto')
    console.log('Subscription Tier   Free')
  }
} else if (args[0] === 'models') {
  const file = env.FAKE_CURSOR_MODELS
  const lines =
    file && existsSync(file)
      ? readFileSync(file, 'utf8')
          .split('\n')
          .filter((line) => line.trim() !== '')
      : DEFAULT_MODELS
  console.log('Available models\n')
  for (const line of lines) console.log(line)
} else if (args[0] === 'update') {
  console.log('Cursor Agent is up to date (the fake does not update anything).')
} else if (args[0] === 'acp') {
  await runAcp()
} else {
  console.error(`fake-cursor: unsupported arguments: ${args.join(' ')}`)
  process.exit(2)
}

// ---- acp ---------------------------------------------------------------------------------

async function runAcp() {
  const INTERRUPTED = Symbol('interrupted')
  const state = {
    sessionId: null,
    cwd: process.cwd(),
    mcpServers: [],
    resumed: false,
    model: null,
    mode: 'agent',
    models: [],
    promptId: null,
    turnActive: false,
    waitingCancel: false,
    interrupted: false,
    fireInterrupt: () => {},
    interruptP: new Promise(() => {}),
    saved: {},
    nextServerId: 0,
    pendingServer: new Map(),
    scriptStarted: false,
    toolCounter: 0
  }
  /** Client prompts and cancels no script step has taken yet. */
  const inbox = []
  let wake = () => {}

  log({
    env: {
      keys: Object.keys(env).sort(),
      ARC_AGENT: env.ARC_AGENT,
      ARC_AGENT_ROLE: env.ARC_AGENT_ROLE,
      ARC_PROVIDER: env.ARC_PROVIDER,
      hasBridgeToken: Boolean(env.ARC_BRIDGE_TOKEN)
    }
  })
  agent.role = env.FAKE_CURSOR_ROLE ?? env.ARC_AGENT_ROLE

  function write(obj) {
    const message = { jsonrpc: '2.0', ...obj }
    log({ send: message })
    return new Promise((resolve) =>
      process.stdout.write(JSON.stringify(message) + '\n', () => resolve())
    )
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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
        if (name === 'SESSION_ID') return state.sessionId
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

  // ---- session shapes --------------------------------------------------------------------------

  const MODES = [
    { id: 'agent', name: 'Agent', description: 'Full agent capabilities with tool access' },
    {
      id: 'plan',
      name: 'Plan',
      description: 'Read-only mode for planning and designing before implementation'
    },
    { id: 'ask', name: 'Ask', description: 'Q&A mode - no edits or command execution' }
  ]

  function modelList() {
    const file = env.FAKE_CURSOR_MODELS
    if (file && existsSync(file)) {
      const text = readFileSync(file, 'utf8').trim()
      if (text.startsWith('[')) {
        return JSON.parse(text).map((m) =>
          typeof m === 'string'
            ? { modelId: m, name: m }
            : { modelId: m.modelId, name: m.name ?? m.modelId }
        )
      }
      return text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '' && line !== 'Available models')
        .map((line) => {
          const at = line.indexOf(' - ')
          const id = at < 0 ? line : line.slice(0, at)
          return { modelId: id, name: at < 0 ? id : line.slice(at + 3) }
        })
    }
    return [
      { modelId: 'default[]', name: 'Auto' },
      { modelId: 'composer-2.5[fast=true]', name: 'composer-2.5' },
      {
        modelId: 'claude-sonnet-5[thinking=true,context=300k,effort=high]',
        name: 'claude-sonnet-5'
      },
      { modelId: 'gpt-5.2[reasoning=medium,fast=false]', name: 'gpt-5.2' }
    ]
  }

  function commandList() {
    const raw = env.FAKE_CURSOR_COMMANDS
    if (!raw) return []
    const text = existsSync(raw) ? readFileSync(raw, 'utf8') : raw
    return JSON.parse(text).map((c) =>
      typeof c === 'string' ? { name: c, description: `The ${c} command` } : c
    )
  }

  function sessionResult() {
    return {
      sessionId: state.sessionId,
      modes: { currentModeId: state.mode, availableModes: MODES },
      models: { currentModelId: state.model, availableModels: state.models },
      configOptions: [
        {
          id: 'mode',
          name: 'Mode',
          description: 'Controls how the agent executes tasks',
          category: 'mode',
          type: 'select',
          currentValue: state.mode,
          options: MODES.map((m) => ({ value: m.id, name: m.name, description: m.description }))
        },
        {
          id: 'model',
          name: 'Model',
          description: 'Controls which model variant is used for responses',
          category: 'model',
          type: 'select',
          currentValue: state.model,
          options: state.models.map((m) => ({ value: m.modelId, name: m.name }))
        }
      ]
    }
  }

  const update = (body) =>
    write({ method: 'session/update', params: { sessionId: state.sessionId, update: body } })

  // ---- turns -----------------------------------------------------------------------------------

  function newTurn(id) {
    state.promptId = id
    state.turnActive = true
    state.interrupted = false
    state.interruptP = new Promise((resolve) => {
      state.fireInterrupt = () => resolve(INTERRUPTED)
    })
  }

  /** Resolves with the value, or with INTERRUPTED when the active turn is cancelled first. */
  function interruptible(promise) {
    if (!state.turnActive) return promise
    return Promise.race([promise, state.interruptP])
  }

  const usageTotals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  function usageObject() {
    usageTotals.inputTokens += 120
    usageTotals.outputTokens += 30
    usageTotals.cacheReadTokens += 40
    return { ...usageTotals }
  }

  async function endTurn(stopReason) {
    if (!state.turnActive) return
    const mode = env.FAKE_CURSOR_USAGE ?? 'none'
    const result = { stopReason }
    if (mode === 'update') await update({ sessionUpdate: 'usage_update', usage: usageObject() })
    if (mode === 'prompt') result.usage = usageObject()
    state.turnActive = false
    await write({ id: state.promptId, result })
  }

  async function finishInterrupted() {
    await sleep(20)
    await endTurn('cancelled')
  }

  // ---- permission requests ---------------------------------------------------------------------

  const DEFAULT_OPTIONS = [
    { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'allow-always', name: 'Allow always', kind: 'allow_always' },
    { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' }
  ]

  /** Sends session/request_permission and waits. Resolves {outcome, optionId}, or INTERRUPTED on session/cancel. */
  async function ask(toolCall, options, saveAs) {
    const id = state.nextServerId++
    const answered = new Promise((resolve) => state.pendingServer.set(id, resolve))
    await write({
      id,
      method: 'session/request_permission',
      params: {
        sessionId: state.sessionId,
        toolCall: { status: 'pending', ...toolCall },
        options: options ?? DEFAULT_OPTIONS
      }
    })
    const answer = await interruptible(answered)
    state.pendingServer.delete(id)
    if (answer === INTERRUPTED) return INTERRUPTED
    const outcome = answer?.outcome?.outcome ?? 'error'
    const result = { outcome, optionId: answer?.outcome?.optionId }
    log({ permission: { toolCallId: toolCall.toolCallId, ...result } })
    if (saveAs) state.saved[saveAs] = result
    return result
  }

  const isAllow = (result) => result.outcome === 'selected' && /^allow/.test(result.optionId ?? '')

  async function runList(steps) {
    for (const step of steps) {
      if (!whenOk(step)) continue
      const r = await execStep(step)
      if (r === INTERRUPTED) return INTERRUPTED
    }
    return undefined
  }

  async function runRequest(step) {
    const spec = sub(step.request)
    const result = await ask(
      { toolCallId: `toolcall-${++state.toolCounter}`, kind: 'execute', ...spec.toolCall },
      spec.options,
      step.saveAs
    )
    if (result === INTERRUPTED) return INTERRUPTED
    const branch = step.then?.[result.outcome === 'selected' ? result.optionId : result.outcome]
    return branch ? runList(branch) : undefined
  }

  // ---- tool calls ------------------------------------------------------------------------------

  const nextToolId = (step) => step.id ?? `toolcall-${++state.toolCounter}`

  function runProcess(command) {
    return new Promise((resolve) => {
      const child = spawn('sh', ['-c', command], { cwd: state.cwd, env: process.env })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (d) => (stdout += d))
      child.stderr.on('data', (d) => (stderr += d))
      child.on('close', (code) => resolve({ exitCode: code ?? 1, stdout, stderr }))
    })
  }

  async function runShell(step) {
    const command = sub(step.shell)
    const toolCallId = nextToolId(step)
    const title = `\`${command}\``
    await update({
      sessionUpdate: 'tool_call',
      toolCallId,
      title,
      kind: 'execute',
      status: 'pending',
      rawInput: { command }
    })
    await update({ sessionUpdate: 'tool_call_update', toolCallId, status: 'in_progress' })
    if (step.approval) {
      const result = await ask(
        {
          toolCallId,
          title,
          kind: 'execute',
          content: [
            { type: 'content', content: { type: 'text', text: `Not in allowlist: ${command}` } }
          ]
        },
        undefined,
        step.saveAs
      )
      if (result === INTERRUPTED) return INTERRUPTED
      if (!isAllow(result)) {
        await update({ sessionUpdate: 'tool_call_update', toolCallId, status: 'completed' })
        return undefined
      }
    }
    const outcome = await interruptible(runProcess(sub(step.run ?? step.shell)))
    if (outcome === INTERRUPTED) return INTERRUPTED
    log({ shell: { cmd: command, code: outcome.exitCode, out: outcome.stdout } })
    await update({
      sessionUpdate: 'tool_call_update',
      toolCallId,
      status: 'completed',
      rawOutput: outcome
    })
    return undefined
  }

  async function runWrite(step) {
    const { path, content } = sub(step.write)
    const file = isAbsolute(path) ? path : join(state.cwd, path)
    const toolCallId = nextToolId(step)
    const oldText = existsSync(file) ? readFileSync(file, 'utf8') : null
    await update({
      sessionUpdate: 'tool_call',
      toolCallId,
      title: 'Edit File',
      kind: 'edit',
      status: 'pending',
      rawInput: {}
    })
    await update({
      sessionUpdate: 'tool_call_update',
      toolCallId,
      title: `Edit \`${file}\``,
      rawInput: { path: file },
      locations: [{ path: file }]
    })
    await update({ sessionUpdate: 'tool_call_update', toolCallId, status: 'in_progress' })
    if (step.approval) {
      const result = await ask(
        { toolCallId, title: `Edit \`${file}\``, kind: 'edit' },
        undefined,
        step.saveAs
      )
      if (result === INTERRUPTED) return INTERRUPTED
      if (!isAllow(result)) {
        await update({ sessionUpdate: 'tool_call_update', toolCallId, status: 'completed' })
        return undefined
      }
    }
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, content)
    await update({
      sessionUpdate: 'tool_call_update',
      toolCallId,
      status: 'completed',
      content: [{ type: 'diff', path: file, oldText, newText: content }]
    })
    return undefined
  }

  // ---- the bridge ------------------------------------------------------------------------------

  function bridge() {
    const arc = state.mcpServers.find((s) => s.name === 'arc')
    if (!arc?.url) throw new Error('fake-cursor: session/new carried no mcpServers entry named arc')
    return {
      url: arc.url,
      headers: Object.fromEntries((arc.headers ?? []).map((h) => [h.name.toLowerCase(), h.value]))
    }
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
    if (!res.ok) throw new Error(`fake-cursor: bridge answered ${res.status}: ${text}`)
    const type = res.headers.get('content-type') ?? ''
    const messages = type.includes('text/event-stream')
      ? text
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => JSON.parse(l.slice(5).trim()))
      : [JSON.parse(text)]
    const answer = messages.find((m) => m.id === body.id)
    if (!answer) throw new Error('fake-cursor: no answer in ' + text)
    if (answer.error) throw new Error('fake-cursor: ' + JSON.stringify(answer.error))
    return answer.result
  }

  let mcpInitialized = false
  let rpcCounter = 0
  /** A tools/call with no progressToken, the way Cursor sends it (spike M1). */
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
          clientInfo: { name: 'fake-cursor', version: '0' }
        }
      })
      await rpc(server, { jsonrpc: '2.0', method: 'notifications/initialized' }, false)
    }
    return rpc(server, {
      jsonrpc: '2.0',
      id: 100 + ++rpcCounter,
      method: 'tools/call',
      params: { name: tool, arguments: toolArgs ?? {} }
    })
  }

  async function callOutcome(tool, toolArgs) {
    try {
      const result = await callMcp(tool, toolArgs)
      const text = (result.content ?? []).map((c) => c.text ?? '').join('')
      return { isError: result.isError === true, text }
    } catch (error) {
      return { isError: true, text: String(error?.message ?? error) }
    }
  }

  function pendingWaitId(outcome) {
    try {
      const body = JSON.parse(outcome.text)
      return body?.status === 'pending' && typeof body.waitId === 'string' ? body.waitId : undefined
    } catch {
      return undefined
    }
  }

  async function runMcp(step) {
    const { tool } = step.mcp
    const toolArgs = sub(step.mcp.args) ?? {}
    const toolCallId = nextToolId(step)
    await update({
      sessionUpdate: 'tool_call',
      toolCallId,
      title: 'MCP: tool',
      kind: 'other',
      status: 'pending',
      rawInput: {}
    })
    await update({
      sessionUpdate: 'tool_call_update',
      toolCallId,
      title: `arc: ${tool}`,
      rawInput: { providerIdentifier: 'arc', toolName: tool, args: toolArgs }
    })
    await update({ sessionUpdate: 'tool_call_update', toolCallId, status: 'in_progress' })
    if (step.approval) {
      const result = await ask(
        {
          toolCallId,
          title: `arc-${tool}: ${tool}`,
          kind: 'other',
          content: [
            {
              type: 'content',
              content: {
                type: 'text',
                text: '```json\n' + JSON.stringify(toolArgs, null, 2) + '\n```'
              }
            }
          ]
        },
        undefined,
        step.saveAs
      )
      if (result === INTERRUPTED) return INTERRUPTED
      if (!isAllow(result)) {
        await update({
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: 'completed',
          rawOutput: { error: 'User rejected MCP tool call' }
        })
        return undefined
      }
    }
    let outcome = await interruptible(callOutcome(tool, toolArgs))
    if (outcome === INTERRUPTED) return INTERRUPTED
    log({ mcpResult: { tool, isError: outcome.isError, text: outcome.text } })
    for (let polls = 0; step.follow && polls < 20; polls += 1) {
      const waitId = pendingWaitId(outcome)
      if (!waitId) break
      outcome = await interruptible(callOutcome('wait_for', { waitId }))
      if (outcome === INTERRUPTED) return INTERRUPTED
      log({ mcpResult: { tool: 'wait_for', isError: outcome.isError, text: outcome.text } })
    }
    if (step.saveAs && !step.approval) state.saved[step.saveAs] = outcome
    await update({
      sessionUpdate: 'tool_call_update',
      toolCallId,
      status: 'completed',
      rawOutput: outcome.isError ? { error: outcome.text } : { success: true }
    })
    return undefined
  }

  // ---- the script ------------------------------------------------------------------------------

  const DEFAULT_SCRIPT = [{ expect: 'prompt' }, { text: 'ok' }, { end: 'end_turn' }]

  function resumedRuns(role) {
    if (!env.FAKE_CURSOR_LOG || !existsSync(env.FAKE_CURSOR_LOG)) return 1
    let runs = 0
    for (const line of readFileSync(env.FAKE_CURSOR_LOG, 'utf8').split('\n')) {
      if (!line.includes('"agent"')) continue
      try {
        const a = JSON.parse(line).agent
        if (a?.resumed && a.role === role) runs += 1
      } catch {
        // not a record of ours
      }
    }
    return Math.max(runs, 1)
  }

  function resolveScriptPath(role, slug, resumed) {
    const dir = env.FAKE_CURSOR_SCRIPT_DIR
    if (dir) {
      const names = []
      if (resumed) {
        if (role === 'worker' && slug) names.push(`worker-${slug}-resumed`)
        if (role) names.push(`${role}-resumed-${resumedRuns(role)}`, `${role}-resumed`)
      }
      if (role === 'worker' && slug) names.push(`worker-${slug}`)
      if (role === 'worker' && slug === 'merge-conflict') names.push('resolver')
      if (role) names.push(role)
      for (const name of names) {
        const candidate = join(dir, name + '.jsonl')
        if (existsSync(candidate)) return candidate
      }
    }
    return env.FAKE_CURSOR_SCRIPT
  }

  function loadScript(path) {
    if (!path) return DEFAULT_SCRIPT
    return readFileSync(path, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => JSON.parse(l))
  }

  async function takeInbox(kind, text) {
    for (;;) {
      const at = inbox.findIndex(
        (r) => r.kind === kind && (text === undefined || (r.text ?? '').includes(text))
      )
      if (at >= 0) return inbox.splice(at, 1)[0]
      await new Promise((resolve) => (wake = resolve))
    }
  }

  async function execStep(step) {
    if (step.expect === 'cancel') {
      state.waitingCancel = true
      try {
        await takeInbox('cancel')
      } finally {
        state.waitingCancel = false
      }
      await sleep(20)
      await endTurn('cancelled')
      return undefined
    }
    if (step.expect) {
      const prompt = await takeInbox('prompt', step.text)
      for (let at = inbox.findIndex((r) => r.kind === 'cancel'); at >= 0;) {
        inbox.splice(at, 1) // a cancel from before this turn means nothing now
        at = inbox.findIndex((r) => r.kind === 'cancel')
      }
      newTurn(prompt.id)
      return undefined
    }
    if (step.emit) {
      if (step.delay) await interruptible(sleep(step.delay))
      await update(sub(step.emit))
      return undefined
    }
    if (step.text !== undefined) {
      await update({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: sub(step.text) }
      })
      return undefined
    }
    if (step.thought !== undefined) {
      await update({
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: sub(step.thought) }
      })
      return undefined
    }
    if (step.title !== undefined) {
      await update({ sessionUpdate: 'session_info_update', title: sub(step.title) })
      return undefined
    }
    if (step.request) return runRequest(step)
    if (step.shell !== undefined) return runShell(step)
    if (step.write) return runWrite(step)
    if (step.mcp) return runMcp(step)
    if (step.sleep !== undefined) {
      const r = await interruptible(sleep(step.sleep))
      return r === INTERRUPTED ? INTERRUPTED : undefined
    }
    if (step.end !== undefined) {
      await endTurn(step.end === true ? 'end_turn' : step.end)
      return undefined
    }
    if (step.stderr !== undefined) {
      process.stderr.write(String(step.stderr))
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
      }
    }
  }

  function startScript(promptText) {
    const role =
      env.FAKE_CURSOR_ROLE ??
      /\[arc-role:([A-Za-z0-9_-]+)\]/.exec(promptText)?.[1] ??
      env.ARC_AGENT_ROLE
    const slug = /\[arc-worker:([A-Za-z0-9_-]+)\]/.exec(promptText)?.[1]
    agent.role = role
    agent.slug = slug
    const path = resolveScriptPath(role, slug, state.resumed)
    log({ agent: { role, slug, resumed: state.resumed, script: path } })
    void runScript(loadScript(path)).catch((error) => {
      process.stderr.write(`fake-cursor: script failed: ${error?.stack ?? error}\n`)
      process.exit(3)
    })
  }

  // ---- requests the client sends ---------------------------------------------------------------

  function promptText(params) {
    return (params?.prompt ?? []).map((p) => p.text ?? '').join('\n')
  }

  async function startSession(msg, resumed) {
    const p = msg.params ?? {}
    state.resumed = resumed
    state.cwd = p.cwd ?? state.cwd
    state.mcpServers = p.mcpServers ?? []
    state.models = modelList()
    // Like the M1 recording, the session starts on a model other than Auto, so Arc's session/set_model is needed.
    state.model = (state.models[1] ?? state.models[0])?.modelId ?? 'default[]'
    state.sessionId = resumed
      ? p.sessionId
      : (env.FAKE_CURSOR_SESSION_ID ?? `fake-session-${randomUUID()}`)
    log({
      session: {
        method: msg.method,
        sessionId: state.sessionId,
        cwd: state.cwd,
        mcpServers: state.mcpServers
      }
    })
    if (resumed) {
      if (env.FAKE_CURSOR_RESUME_FAIL === '1') {
        await write({
          id: msg.id,
          error: {
            code: -32602,
            message: 'Invalid params',
            data: { message: `Session "${p.sessionId}" not found` }
          }
        })
        return
      }
      for (const text of JSON.parse(env.FAKE_CURSOR_HISTORY ?? '[]')) {
        await update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })
      }
    }
    await write({ id: msg.id, result: resumed ? {} : sessionResult() })
    await update({ sessionUpdate: 'available_commands_update', availableCommands: commandList() })
  }

  async function onRequest(msg) {
    const p = msg.params ?? {}
    switch (msg.method) {
      case 'initialize':
        await write({
          id: msg.id,
          result: {
            protocolVersion: 1,
            agentCapabilities: {
              loadSession: true,
              mcpCapabilities: { http: true, sse: true },
              promptCapabilities: { audio: false, embeddedContext: false, image: true },
              sessionCapabilities: { list: {} }
            },
            authMethods: [
              {
                id: 'cursor_login',
                name: 'Cursor Login',
                description:
                  "Authenticate using existing Cursor login credentials. Run 'agent login' first if not logged in."
              }
            ]
          }
        })
        return
      case 'authenticate':
        if (auth === 'signed_out') {
          await write({ id: msg.id, error: { code: -32000, message: 'Authentication required' } })
        } else {
          await write({ id: msg.id, result: {} })
        }
        return
      case 'session/new':
        if (auth === 'signed_out') {
          await write({ id: msg.id, error: { code: -32000, message: 'Authentication required' } })
          return
        }
        await startSession(msg, false)
        return
      case 'session/load':
        await startSession(msg, true)
        return
      case 'session/set_mode':
        state.mode = p.modeId ?? state.mode
        await write({ id: msg.id, result: {} })
        await update({ sessionUpdate: 'current_mode_update', currentModeId: state.mode })
        return
      case 'session/set_model':
        if (!state.models.some((m) => m.modelId === p.modelId)) {
          await write({
            id: msg.id,
            error: {
              code: -32602,
              message: 'Invalid params',
              data: { message: `Invalid model value: ${p.modelId}` }
            }
          })
          return
        }
        state.model = p.modelId
        await write({ id: msg.id, result: {} })
        return
      case 'session/prompt': {
        const text = promptText(p)
        inbox.push({ kind: 'prompt', id: msg.id, text, params: p })
        if (!state.scriptStarted) {
          state.scriptStarted = true
          startScript(text)
        }
        wake()
        return
      }
      default:
        await write({
          id: msg.id,
          error: { code: -32601, message: `"Method not found": ${msg.method}` }
        })
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
    if (msg.method === 'session/cancel') {
      inbox.push({ kind: 'cancel' })
      if (state.turnActive && !state.waitingCancel) {
        state.interrupted = true
        state.fireInterrupt()
      }
      wake()
      return
    }
    if (msg.method !== undefined && msg.id !== undefined) void onRequest(msg)
  })
  reader.on('close', () => {
    void exitNow(0)
  })
}
