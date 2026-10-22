// Dev-only (never built or shipped): records ONE real Cursor turn from `agent acp` as scrubbed JSONL
// for tests/fixtures/cursor/<version>/m1-agent-turn.jsonl (spec 010, tech spec 2.1 and 2.12, spike M1).
//
// It makes ONE real model call, so it refuses to run without --confirm-real-run.
//   node scripts/record-cursor.mjs --confirm-real-run [--model <modelId>] [--work-dir <dir>] [--out <file>]
//   node scripts/record-cursor.mjs --confirm-real-run --dry-run --out <file>   (no prompt, no model call)
//   node scripts/record-cursor.mjs --confirm-real-run --scenario sandbox [--dry-run] [--model <id>]
//        [--work-dir <dir>] [--out <file>]       (spike M6: does Cursor's sandbox confine writes? see below)
//   node scripts/record-cursor.mjs --confirm-real-run --scenario ask-mode [--dry-run] [--model <id>]
//        [--work-dir <dir>] [--out <file>]       (spike M2: what does mode `ask` allow? see below)
//   node scripts/record-cursor.mjs --confirm-real-run --scenario cancel [--dry-run] [--model <id>]
//        [--work-dir <dir>] [--out <file>]       (spike M3: session/cancel with a permission pending)
//   node scripts/record-cursor.mjs --confirm-real-run --scenario load [--dry-run] [--model <id>]
//        [--work-dir <dir>] [--out <file>]       (spike M4: session/load in a new process)
//
// What it does, in a throwaway git repo with a local bare `origin`:
//   1. spawns `agent acp`, runs initialize + authenticate + session/new (agent mode) with an `arc`
//      http MCP server (a local fake bridge: `echo` and `slow`, which sleeps 130 s with progress
//      keepalives every 15 s) and a bearer token in `mcpServers[].headers`;
//   2. sets the model, sends ONE prompt that walks eight steps (read, write, git status, ls, git push,
//      a read outside cwd, `echo`, `slow`), answering permission requests allow-once except the push
//      (reject-once) so both flows are recorded;
//   3. writes every JSON-RPC line in both directions, plus the bridge's HTTP calls, scrubbed, to --out.
// The project `.cursor/cli.json` denies `Shell(git push)`: the run shows whether a project deny beats
// the user's allow list. Nothing is written to ~/.cursor by this script; Cursor keeps its own
// session files there. A prompt that was accepted is never sent twice.
//
// --scenario sandbox (spike M6, tech spec 2.4): ONE prompt, no bridge. The agent starts as
// `agent --sandbox enabled acp` (spike N6: a project cli.json rejects a `sandbox` key and the process
// exits, so the flag is the switch), and the scratch repo's project `.cursor/cli.json` holds the deny
// list Arc writes for a worker (the `Shell(...)` entries, and a `Write(<work>/known/**)` entry for a folder Arc knows about). The
// prompt asks the agent to write inside.txt in the repo, ../outside.txt (an unknown folder outside it)
// and ../known/denied.txt (a folder under a Write deny), then `ls ..`. Afterwards the script reports
// which of the three files exist, so the wire log can be read against what really happened.
//
// --scenario ask-mode (spike M2, tech spec 2.3): the fake `arc` bridge as in M1, then session/set_mode
// 'ask' right after session/new, and ONE prompt asking for (a) the arc `echo` tool with "hi",
// (b) a read of README.md, (c) `git status`, (d) writing notes.txt. Every permission request is answered
// allow-once, so whatever is refused was refused by `ask` mode itself. No project cli.json deny is written
// (the brain's `Write(**)` deny is a separate layer). Afterwards the script reports whether notes.txt
// exists and how many `echo` calls the bridge saw.
//
// --scenario cancel (spike M3, tech spec 2.3): no bridge. ONE prompt asks for `git status` then
// `git log -1`. The first session/request_permission is NOT answered: the recorder sends
// `session/cancel` as a notification (what ACP specifies) and records whether Cursor sends anything
// for the pending request and what the prompt's stopReason is. If the prompt has not answered after
// 15 s it escalates, each step recorded: `session/cancel` sent as a request (with an id), then the
// pending permission answered `cancelled`. Then ONE more short prompt in the same session ("Reply with
// the word ok.") shows whether the session is still usable. Two prompts in total (M3's approved scope).
//
// --scenario load (spike M4, tech spec 2.3): no bridge. Process A: handshake, session/new, ONE prompt
// ("Remember the word kiwi. Reply ok."), clean exit (stdin closed). Process B: a new `agent acp`,
// initialize, authenticate, session/load {sessionId of A, cwd, mcpServers: []}; every replayed update
// until the load response is recorded, then ONE prompt asking for the remembered word. Two prompts in
// total (M4's approved scope). Every wire line carries `proc` ("A" or "B"); `process` lines mark starts/exits.
//
// --scenario mcp-off (spike M7, tech spec 2.5): does a same-name no-op session entry switch a file MCP
// server off? The scratch repo has a project `.cursor/mcp.json` server `shadowme` (a local http fake with the
// tools `peek` and `poke` that logs every request), APPROVED through a scratch CURSOR_DATA_DIR
// (`<tmp>/cursor-data/projects/<slug>/mcp-approvals.json`, spike N2; ~/.cursor is never written). A
// preflight `agent mcp list` must say `shadowme: ready` or the run stops before any prompt (an unapproved
// server would make the test vacuous). session/new gets mcpServers = [the fake `arc` bridge, and a
// `shadowme` entry -> `<off-server>/off/shadowme`, a local endpoint that answers initialize and an empty
// tools/list, as the app's bridge route does]. ONE prompt asks the agent to list its shadowme tools and call
// `peek`. Afterwards the script prints the requests the REAL shadowme server received before the prompt and
// during it (tools/list, tools/call) and whether the agent made any shadowme tool call. Note (found in the
// dry run): the agent process is started with its cwd in the repo, and then Cursor connects the approved
// project server at process start, before session/new, so only the requests DURING the prompt are the verdict.
//   node scripts/record-cursor.mjs --confirm-real-run --scenario mcp-off [--dry-run] --model 'default[]'
//
// --scenario command (spike M5, tech spec 2.9): does Cursor run a project command file when the prompt text
// is `/name args`? The scratch repo has `.cursor/commands/shout.md` (body: reply with the argument in upper
// case prefixed with `SHOUT: `). No bridge, no MCP servers. After session/new the recorder waits for the
// `available_commands_update` and reports whether `shout` is listed (name, description, input hint); that part
// needs no model call, so --dry-run already answers it. Then ONE prompt with the text `/shout banana`; every
// permission request is declined. Success = the reply is `SHOUT: BANANA` (the body ran, not the literal text).
//   node scripts/record-cursor.mjs --confirm-real-run --scenario command [--dry-run] --model 'default[]'
import { spawn, execFile, execFileSync } from 'node:child_process'
import http from 'node:http'
import os from 'node:os'
import { join, resolve, dirname } from 'node:path'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  realpathSync,
  rmSync,
  existsSync
} from 'node:fs'
import { randomBytes, createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(name)
  return i === -1 ? fallback : (args[i + 1] ?? fallback)
}
if (!args.includes('--confirm-real-run')) {
  console.error('This makes one real Cursor model call. Re-run with --confirm-real-run.')
  process.exit(2)
}
const SCENARIO = flag('--scenario', 'agent')
if (!['agent', 'sandbox', 'ask-mode', 'cancel', 'load', 'mcp-off', 'command'].includes(SCENARIO)) {
  console.error(
    `unknown --scenario ${SCENARIO} (agent, sandbox, ask-mode, cancel, load, mcp-off or command)`
  )
  process.exit(2)
}
const SANDBOX = SCENARIO === 'sandbox'
const ASK = SCENARIO === 'ask-mode'
const CANCEL = SCENARIO === 'cancel'
const LOAD = SCENARIO === 'load'
const MCP_OFF = SCENARIO === 'mcp-off'
const COMMAND = SCENARIO === 'command'
const MODEL = flag('--model', 'default[]')
const OUT = resolve(
  flag(
    '--out',
    SANDBOX
      ? 'tests/fixtures/cursor/unknown/m6-sandbox-turn.jsonl'
      : ASK
        ? 'tests/fixtures/cursor/unknown/m2-ask-mode-turn.jsonl'
        : CANCEL
          ? 'tests/fixtures/cursor/unknown/m3-cancel-turn.jsonl'
          : LOAD
            ? 'tests/fixtures/cursor/unknown/m4-load-turn.jsonl'
            : MCP_OFF
              ? 'tests/fixtures/cursor/unknown/m7-mcp-off-turn.jsonl'
              : COMMAND
                ? 'tests/fixtures/cursor/unknown/m5-command-turn.jsonl'
                : 'tests/fixtures/cursor/unknown/m1-agent-turn.jsonl'
  )
)
const BIN = flag('--agent-bin', join(os.homedir(), '.local', 'bin', 'cursor-agent'))
const DRY_RUN = args.includes('--dry-run')
const SLOW_MS = 130_000
const PROGRESS_MS = 15_000
const TURN_TIMEOUT_MS = 360_000
const MAX_AGENT_REQUESTS = 30

const token = randomBytes(12).toString('hex')
const workRoot = flag('--work-dir', undefined)
if (workRoot) mkdirSync(workRoot, { recursive: true })
const tmpRoot = realpathSync(workRoot ?? mkdtempSync(join(os.tmpdir(), 'arc-record-cursor-')))
const wire = []
const t0 = Date.now()
let child
let bridgeServer

function git(cwd, ...gitArgs) {
  return execFileSync('git', gitArgs, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

// ---- fake bridge: MCP server `arc`, tools echo and slow (long call with progress keepalives) ----
function bridgeLog(event) {
  wire.push({ dir: 'bridge', t: Date.now() - t0, event })
}
function startBridge() {
  const server = http.createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    const auth = req.headers.authorization
    let rpc
    try {
      rpc = body ? JSON.parse(body) : undefined
    } catch {
      rpc = undefined
    }
    const authOk = auth === `Bearer ${token}`
    bridgeLog({
      http: req.method,
      path: req.url,
      authorization: auth === undefined ? 'absent' : authOk ? 'bearer-ok' : 'bearer-wrong',
      mcpMethod: rpc?.method,
      progressToken: rpc?.params?._meta?.progressToken !== undefined,
      userAgent: req.headers['user-agent']
    })
    if (!authOk) {
      res.writeHead(401)
      res.end()
      return
    }
    const mcp = new McpServer({ name: 'arc', version: '1.0.0' })
    mcp.registerTool(
      'echo',
      {
        description: 'Echo the text back.',
        inputSchema: { text: z.string() },
        annotations: { readOnlyHint: true }
      },
      ({ text }) => {
        bridgeLog({ echoCall: text })
        return { content: [{ type: 'text', text: `echo:${text}` }] }
      }
    )
    mcp.registerTool(
      'slow',
      {
        description: 'Waits about two minutes, then returns "slow done".',
        inputSchema: {},
        annotations: { readOnlyHint: false }
      },
      async (_args, extra) => {
        const started = Date.now()
        const token = extra._meta?.progressToken
        bridgeLog({ slow: 'start', progressToken: token !== undefined })
        let ticks = 0
        const timer = setInterval(() => {
          ticks += 1
          if (token === undefined) return
          void extra
            .sendNotification({
              method: 'notifications/progress',
              params: { progressToken: token, progress: ticks }
            })
            .catch(() => undefined)
        }, PROGRESS_MS)
        const aborted = new Promise((ok) =>
          extra.signal.addEventListener('abort', () => ok('aborted'), { once: true })
        )
        const outcome = await Promise.race([
          new Promise((ok) => setTimeout(() => ok('finished'), SLOW_MS)),
          aborted
        ])
        clearInterval(timer)
        bridgeLog({ slow: outcome, elapsedMs: Date.now() - started, progressSent: ticks })
        return { content: [{ type: 'text', text: 'slow done' }] }
      }
    )
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.on('close', () => {
      void transport.close()
      void mcp.close()
    })
    await mcp.connect(transport)
    await transport.handleRequest(req, res, rpc)
  })
  return new Promise((ok) =>
    server.listen(0, '127.0.0.1', () => {
      bridgeServer = server
      ok(`http://127.0.0.1:${server.address().port}/mcp`)
    })
  )
}

// ---- JSON-RPC over `agent acp` stdio ----
const pending = new Map()
const agentRequests = []
let nextId = 0
let agentRequestCount = 0

// The load scenario runs two processes; every wire line then says which one (`proc`).
let proc
let permissionHandler // cancel scenario: takes over session/request_permission
function log(dir, msg) {
  wire.push({ dir, t: Date.now() - t0, ...(proc ? { proc } : {}), msg })
}
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms))
async function until(test, ms) {
  const end = Date.now() + ms
  while (!test() && Date.now() < end) await sleep(200)
  return test()
}
function note(text) {
  wire.push({ dir: 'note', t: Date.now() - t0, ...(proc ? { proc } : {}), note: text })
}
function send(obj) {
  log('c2s', obj)
  child.stdin.write(`${JSON.stringify(obj)}\n`)
}
function request(method, params, timeoutMs = 30_000) {
  return new Promise((ok) => {
    const id = ++nextId
    pending.set(id, ok)
    send({ jsonrpc: '2.0', id, method, params })
    setTimeout(() => ok({ error: { message: `timeout awaiting ${method}` } }), timeoutMs).unref()
  })
}

// Permission policy: allow-once for everything except `git push`, which is rejected (reject-once),
// so the reject flow is recorded. Options are chosen by kind, never by id text.
function choose(msg) {
  const options = msg.params?.options ?? []
  const text = JSON.stringify(msg.params?.toolCall ?? {})
  const wantReject = /git\s+push/.test(text)
  const kind = wantReject ? 'reject_once' : 'allow_once'
  const option = options.find((o) => o.kind === kind)
  if (!option) return { outcome: { outcome: 'cancelled' } }
  return { outcome: { outcome: 'selected', optionId: option.optionId } }
}

function onLine(line) {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    wire.push({ dir: 's2c-raw', t: Date.now() - t0, line })
    return
  }
  log('s2c', msg)
  if (msg.method && msg.id !== undefined) {
    agentRequestCount += 1
    agentRequests.push(msg.method)
    if (agentRequestCount > MAX_AGENT_REQUESTS) {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'recorder limit' } })
    } else if (msg.method === 'session/request_permission' && permissionHandler) {
      permissionHandler(msg)
    } else if (msg.method === 'session/request_permission') {
      send({ jsonrpc: '2.0', id: msg.id, result: choose(msg) })
    } else {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } })
    }
  } else if (msg.id !== undefined && pending.has(msg.id)) {
    pending.get(msg.id)(msg)
    pending.delete(msg.id)
  }
}

// ---- scrubbing: email, home path, ids and tokens; the user's own command list is trimmed ----
const counts = {}
function escape(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
// The user's own command and skill list is personal: keep the shape, keep three entries.
function trimCommands(entry) {
  const update = entry.msg?.params?.update
  if (update?.sessionUpdate !== 'available_commands_update') return entry
  const note = `trimmed from ${update.availableCommands.length} entries`
  return {
    ...entry,
    msg: {
      ...entry.msg,
      params: {
        ...entry.msg.params,
        update: {
          ...update,
          availableCommands: [
            ...update.availableCommands.slice(0, 3),
            ...update.availableCommands.slice(3).filter((c) => c?.name === 'shout')
          ],
          recorderNote: note
        }
      }
    }
  }
}
function scrubber() {
  const home = os.homedir()
  const user = os.userInfo().username
  const host = os.hostname()
  const ids = new Map()
  const idFor = (value, prefix) => {
    if (!ids.has(value)) ids.set(value, `${prefix}-${ids.size + 1}`)
    return ids.get(value)
  }
  // Collect session ids and tool call ids first so the replacement is consistent everywhere.
  const sessionIds = new Set()
  const toolCallIds = new Set()
  for (const entry of wire) {
    const m = entry.msg
    if (!m) continue
    if (m.result?.sessionId) sessionIds.add(m.result.sessionId)
    if (m.params?.sessionId) sessionIds.add(m.params.sessionId)
    const call = m.params?.toolCall?.toolCallId ?? m.params?.update?.toolCallId
    if (call) toolCallIds.add(call)
  }
  const rules = [
    ['work-root', new RegExp(escape(tmpRoot), 'g'), '/tmp/arc-record'],
    [
      'work-root-alias',
      new RegExp(escape(tmpRoot.replace(/^\/private/, '')), 'g'),
      '/tmp/arc-record'
    ],
    ['bridge-token', new RegExp(escape(token), 'g'), '<BRIDGE_TOKEN>'],
    ['home', new RegExp(escape(home), 'g'), '/Users/user'],
    ['hostname', new RegExp(escape(host), 'g'), '<HOST>'],
    ['email', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, 'user@example.com'],
    ['bearer', /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/g, 'Bearer <REDACTED>'],
    ['jwt', /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_.-]+/g, '<JWT>'],
    ['api-key', /\b(?:sk|key|crsr)[-_][A-Za-z0-9_-]{16,}/g, '<API_KEY>'],
    ['username', new RegExp(`\\b${escape(user)}\\b`, 'g'), 'user']
  ]
  const secretKeys = /^(email|userId|authId|displayName)$/i
  const apply = (value) => {
    let out = value
    for (const id of sessionIds) out = out.split(id).join(idFor(id, 'session'))
    for (const id of toolCallIds) out = out.split(id).join(idFor(id, 'toolcall'))
    for (const [name, re, to] of rules) {
      out = out.replace(re, () => {
        counts[name] = (counts[name] ?? 0) + 1
        return to
      })
    }
    return out
  }
  const walk = (value, key) => {
    if (typeof value === 'string') {
      if (key && secretKeys.test(key)) {
        counts[`key:${key}`] = (counts[`key:${key}`] ?? 0) + 1
        return key.toLowerCase() === 'email' ? 'user@example.com' : `<${key.toUpperCase()}>`
      }
      return apply(value)
    }
    if (Array.isArray(value)) return value.map((v) => walk(v))
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, k)]))
    }
    return value
  }
  return (value) => walk(trimCommands(value))
}

async function cleanup() {
  // `agent acp` leaves a `worker-server` child behind when it is terminated; stop that one too.
  let workers = []
  try {
    if (child?.pid)
      workers = execFileSync('pgrep', ['-P', String(child.pid)], { encoding: 'utf8' })
        .split('\n')
        .filter(Boolean)
        .map(Number)
  } catch {
    // no children
  }
  try {
    child?.kill('SIGTERM')
  } catch {
    // already gone
  }
  bridgeServer?.closeAllConnections?.()
  bridgeServer?.close()
  for (const server of extraServers) {
    server.closeAllConnections?.()
    server.close()
  }
  await new Promise((ok) => setTimeout(ok, 800))
  try {
    child?.kill('SIGKILL')
  } catch {
    // already gone
  }
  for (const pid of workers) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // already gone
    }
  }
  if (!workRoot) rmSync(tmpRoot, { recursive: true, force: true })
}

const PROMPT = [
  'This is a test harness. Do exactly these eight steps, in order, one tool call each, with no extra commands and no commentary between them. If a step is refused or fails, say so in one short line and continue with the next step.',
  '1. Read README.md.',
  '2. Create a new file notes.txt containing the single line: arc was here.',
  '3. Run the shell command: git status',
  '4. Run the shell command: ls',
  '5. Run the shell command: git push origin HEAD',
  '6. Read the file /etc/hosts.',
  '7. Call the echo tool of the MCP server named arc with text "hi".',
  '8. Call the slow tool of the MCP server named arc.',
  'When all eight are done, reply with the single word: done.'
].join('\n')

const SANDBOX_PROMPT = [
  'This is a test harness. Do exactly these four steps, in order, one tool call each, with no extra commands and no commentary between them. If a step is refused or fails, say so in one short line (quote the error) and continue with the next step.',
  '1. Create a new file inside.txt in the current folder containing the single line: inside.',
  '2. Create a new file ../outside.txt (one level above the current folder) containing the single line: outside.',
  '3. Create a new file ../known/denied.txt containing the single line: known.',
  '4. Run the shell command: ls ..',
  'When all four are done, reply with the single word: done.'
].join('\n')

const ASK_PROMPT = [
  'This is a test harness. Do exactly these four steps, in order, one tool call each, with no extra commands and no commentary between them. If a step is refused or fails, say so in one short line (quote the error) and continue with the next step.',
  '1. Call the echo tool of the MCP server named arc with text "hi".',
  '2. Read README.md.',
  '3. Run the shell command: git status',
  '4. Create a new file notes.txt containing the single line: arc was here.',
  'When all four are done, reply with the single word: done.'
].join('\n')

/**
 * The deny entries Arc itself writes: bundles `cursor-deny.ts` with the repo's esbuild and asks it,
 * so the recorder never carries a second copy of the list.
 */
async function arcShellDenyEntries() {
  const here = dirname(fileURLToPath(import.meta.url))
  const out = join(tmpRoot, 'arc-deny.bundle.mjs')
  execFileSync(
    join(here, '..', 'node_modules', '.bin', 'esbuild'),
    [
      join(here, '..', 'src', 'main', 'agents', 'cursor', 'cursor-deny.ts'),
      '--bundle',
      '--platform=node',
      '--format=esm',
      `--outfile=${out}`,
      '--log-level=error'
    ],
    { stdio: ['ignore', 'inherit', 'inherit'] }
  )
  const mod = await import(pathToFileURL(out).href)
  return mod.shellDenyEntries()
}

/** Starts one `agent acp` process in `repo` and wires its stdout/stderr/exit into the wire log. */
function spawnAgent(repo, version, extraArgs = [], extraEnv = {}) {
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CURSOR_'))),
    ...extraEnv
  }
  child = spawn(BIN, [...extraArgs, 'acp'], { cwd: repo, env, stdio: ['pipe', 'pipe', 'pipe'] })
  const mine = child
  console.log(`agent acp pid ${child.pid}, version ${version}${proc ? ` (process ${proc})` : ''}`)
  let buf = ''
  mine.stdout.on('data', (d) => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      onLine(buf.slice(0, i))
      buf = buf.slice(i + 1)
    }
  })
  mine.on('exit', (code, signal) => {
    // A process that dies (for example on an invalid project cli.json) must not leave requests hanging.
    wire.push({ dir: 'exit', t: Date.now() - t0, ...(proc ? { proc } : {}), code, signal })
    for (const ok of pending.values())
      ok({ error: { message: `agent acp exited (${code ?? signal})` } })
    pending.clear()
  })
  mine.stderr.on('data', (d) =>
    wire.push({
      dir: 'stderr',
      t: Date.now() - t0,
      ...(proc ? { proc } : {}),
      text: String(d).slice(0, 2000)
    })
  )
  return mine
}

async function handshake() {
  const init = await request('initialize', {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }
  })
  if (!init.result) throw new Error(`initialize failed: ${JSON.stringify(init.error)}`)
  const auth = await request('authenticate', { methodId: 'cursor_login' })
  if (auth.error)
    throw new Error(`authenticate failed: ${JSON.stringify(auth.error)}; nothing recorded`)
}

async function setModel(sessionId, created) {
  const modelIds = (created?.models?.availableModels ?? []).map((m) => m.modelId)
  if (created && !modelIds.includes(MODEL))
    throw new Error(`model ${MODEL} is not offered; no model call made`)
  const set = await request('session/set_model', { sessionId, modelId: MODEL })
  if (set.error) throw new Error(`session/set_model failed: ${JSON.stringify(set.error)}`)
}

/** The agent's reply text and stop reason of the wire entries recorded since `fromIndex`. */
function replyOf(fromIndex) {
  return wire
    .slice(fromIndex)
    .filter(
      (w) => w.dir === 's2c' && w.msg?.params?.update?.sessionUpdate === 'agent_message_chunk'
    )
    .map((w) => w.msg.params.update.content?.text ?? '')
    .join('')
}

/** Rejects (never allows) a permission request; used where the recorder must not run anything. */
function declinePermission(msg) {
  const options = msg.params?.options ?? []
  const option = options.find((o) => o.kind === 'reject_once')
  note('permission request declined by the recorder')
  send({
    jsonrpc: '2.0',
    id: msg.id,
    result: {
      outcome: option
        ? { outcome: 'selected', optionId: option.optionId }
        : { outcome: 'cancelled' }
    }
  })
}

const CANCEL_PROMPT_1 = [
  'This is a test harness. Do exactly these two steps, in order, one tool call each, with no commentary between them.',
  '1. Run the shell command: git status',
  '2. Run the shell command: git log -1',
  'When both are done, reply with the single word: done.'
].join('\n')
const CANCEL_PROMPT_2 = 'Reply with the word ok.'
const LOAD_PROMPT_1 = 'Remember the word kiwi. Reply ok.'
const LOAD_PROMPT_2 = 'What word did I ask you to remember? Reply with just the word.'

/** M3: session/cancel while a permission request is pending, then a new prompt in the same session. */
async function runCancel(repo, version) {
  spawnAgent(repo, version)
  await handshake()
  const created = await request('session/new', { cwd: repo, mcpServers: [] })
  if (!created.result?.sessionId)
    throw new Error(`session/new failed: ${JSON.stringify(created.error)}`)
  const sessionId = created.result.sessionId
  await setModel(sessionId, created.result)
  await sleep(500)
  if (DRY_RUN) {
    console.log('dry run: no prompt sent')
    return finish(version, undefined, undefined)
  }
  const held = []
  let cancelSentAt
  permissionHandler = (msg) => {
    held.push(msg.id)
    if (held.length === 1) {
      note('first permission request held unanswered; sending session/cancel as a notification')
      cancelSentAt = Date.now() - t0
      send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } })
    } else {
      note('a further permission request arrived after the cancel; left unanswered')
    }
  }
  console.log('sending real prompt 1 of 2 (cancel) on model', MODEL)
  const turnStart = wire.length
  let settled
  void request(
    'session/prompt',
    { sessionId, prompt: [{ type: 'text', text: CANCEL_PROMPT_1 }] },
    150_000
  ).then((r) => {
    settled = r
  })
  const outcome = { permissionRequested: false, escalation: 'none' }
  await until(() => settled || held.length > 0, 90_000)
  outcome.permissionRequested = held.length > 0
  if (!outcome.permissionRequested) {
    note(`no permission request arrived (turn ${settled ? 'ended' : 'still running'})`)
    if (!settled) {
      send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } })
      await until(() => settled, 15_000)
    }
  } else {
    outcome.escalation = 'notification only'
    if (!(await until(() => settled, 15_000))) {
      outcome.escalation = 'cancel as a request'
      note('prompt still open 15 s after the notification; sending session/cancel as a request')
      const asRequest = request('session/cancel', { sessionId }, 15_000).then((r) => {
        outcome.cancelRequestAnswer = r.result ?? r.error
      })
      await until(() => settled, 15_000)
      await asRequest
    }
    if (!settled) {
      outcome.escalation = 'permission answered cancelled'
      note('prompt still open; answering the held permission requests cancelled')
      for (const id of held) {
        send({ jsonrpc: '2.0', id, result: { outcome: { outcome: 'cancelled' } } })
      }
      await until(() => settled, 15_000)
    }
  }
  outcome.firstTurn = settled ? (settled.result ?? settled.error) : 'no response'
  outcome.cancelSentAtMs = cancelSentAt ?? null
  console.log('first turn:', JSON.stringify(outcome.firstTurn), 'escalation:', outcome.escalation)
  await sleep(2000) // trailing notifications
  // The session after the cancel: one short prompt, permissions declined.
  permissionHandler = declinePermission
  if (!settled) {
    outcome.secondTurn = 'not sent: the first prompt never answered'
  } else {
    console.log('sending real prompt 2 of 2 (is the session usable?)')
    const secondStart = wire.length
    const second = await request(
      'session/prompt',
      { sessionId, prompt: [{ type: 'text', text: CANCEL_PROMPT_2 }] },
      90_000
    )
    outcome.secondTurn = second.result ?? second.error
    outcome.secondReply = replyOf(secondStart)
    console.log(
      'second turn:',
      JSON.stringify(outcome.secondTurn),
      JSON.stringify(outcome.secondReply)
    )
    await sleep(2000)
  }
  outcome.firstTurnReply = replyOf(turnStart)
  finish(version, [CANCEL_PROMPT_1, CANCEL_PROMPT_2], outcome)
}

/** Ends the current process cleanly: stdin closed, then SIGTERM if it has not exited in 8 s. */
async function endProcess() {
  const mine = child
  const exited = new Promise((ok) => mine.once('exit', ok))
  mine.stdin.end()
  const done = await Promise.race([exited.then(() => true), sleep(8000).then(() => false)])
  if (!done) {
    note('process did not exit after stdin closed; SIGTERM')
    mine.kill('SIGTERM')
    await Promise.race([exited, sleep(3000)])
  }
  return done
}

/** M4: session/load in a new process, including the replayed history. */
async function runLoad(repo, version) {
  proc = 'A'
  note('process A start')
  spawnAgent(repo, version)
  await handshake()
  const created = await request('session/new', { cwd: repo, mcpServers: [] })
  if (!created.result?.sessionId)
    throw new Error(`session/new failed: ${JSON.stringify(created.error)}`)
  const sessionId = created.result.sessionId
  await setModel(sessionId, created.result)
  await sleep(500)
  const outcome = {}
  permissionHandler = declinePermission
  if (!DRY_RUN) {
    console.log('sending real prompt 1 of 2 (process A) on model', MODEL)
    const first = await request(
      'session/prompt',
      { sessionId, prompt: [{ type: 'text', text: LOAD_PROMPT_1 }] },
      120_000
    )
    outcome.processATurn = first.result ?? first.error
    console.log('process A turn:', JSON.stringify(outcome.processATurn))
    await sleep(2000)
  }
  outcome.processAExitedCleanly = await endProcess()
  note('process A ended')

  proc = 'B'
  note('process B start')
  spawnAgent(repo, version)
  await handshake()
  const loadStart = wire.length
  const loaded = await request('session/load', { sessionId, cwd: repo, mcpServers: [] }, 60_000)
  const replay = wire
    .slice(loadStart)
    .filter((w) => w.dir === 's2c' && w.proc === 'B' && w.msg?.method === 'session/update')
  outcome.loadAnswer = loaded.result ? 'result' : (loaded.error ?? 'none')
  outcome.replayedUpdates = replay.length
  outcome.replayKinds = [...new Set(replay.map((w) => w.msg.params.update?.sessionUpdate))]
  console.log(
    'load answer:',
    JSON.stringify(outcome.loadAnswer),
    'replayed updates:',
    replay.length
  )
  if (loaded.result) {
    await setModel(sessionId, undefined)
    await sleep(1000) // trailing replay, if Cursor sends any after the response
    outcome.updatesAfterLoadResponse =
      wire
        .slice(loadStart)
        .filter((w) => w.dir === 's2c' && w.proc === 'B' && w.msg?.method === 'session/update')
        .length - replay.length
    if (!DRY_RUN) {
      console.log('sending real prompt 2 of 2 (process B) on model', MODEL)
      const secondStart = wire.length
      const second = await request(
        'session/prompt',
        { sessionId, prompt: [{ type: 'text', text: LOAD_PROMPT_2 }] },
        120_000
      )
      outcome.processBTurn = second.result ?? second.error
      outcome.processBReply = replyOf(secondStart)
      console.log(
        'process B turn:',
        JSON.stringify(outcome.processBTurn),
        JSON.stringify(outcome.processBReply)
      )
      await sleep(2000)
    }
  }
  proc = undefined
  finish(version, DRY_RUN ? undefined : [LOAD_PROMPT_1, LOAD_PROMPT_2], outcome)
}

// ---- M7: a same-name no-op session entry versus an approved project file server ----
const MCP_OFF_PROMPT =
  "List every tool you have from an MCP server named shadowme. Then call shadowme's peek tool with text 'hi' if you can."
const extraServers = []

/** A tiny hand-rolled http MCP server that logs every request into the wire as `mcp-server`. */
function startFakeMcp(label, { tools, requireBearer }) {
  const server = http.createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    let rpc
    try {
      rpc = body ? JSON.parse(body) : undefined
    } catch {
      rpc = undefined
    }
    const auth = req.headers.authorization
    const authOk = requireBearer ? auth === `Bearer ${token}` : true
    wire.push({
      dir: 'mcp-server',
      t: Date.now() - t0,
      server: label,
      http: req.method,
      path: req.url,
      authorization: auth === undefined ? 'absent' : authOk ? 'bearer-ok' : 'bearer-wrong',
      mcpMethod: rpc?.method,
      toolName: rpc?.method === 'tools/call' ? rpc.params?.name : undefined,
      userAgent: req.headers['user-agent']
    })
    if (!authOk) {
      res.writeHead(401).end()
      return
    }
    if (req.method !== 'POST' || !rpc) {
      res.writeHead(405).end()
      return
    }
    if (rpc.id === undefined) {
      res.writeHead(202).end()
      return
    }
    const reply = (result) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }))
    }
    if (rpc.method === 'initialize')
      return reply({
        protocolVersion: rpc.params?.protocolVersion ?? '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: label, version: '1.0.0' }
      })
    if (rpc.method === 'tools/list') return reply({ tools })
    if (rpc.method === 'tools/call')
      return reply({ content: [{ type: 'text', text: `${label}:${rpc.params?.name}:ok` }] })
    if (rpc.method === 'ping') return reply({})
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: 'no' } }))
  })
  return new Promise((ok) =>
    server.listen(0, '127.0.0.1', () => {
      extraServers.push(server)
      ok(`http://127.0.0.1:${server.address().port}`)
    })
  )
}

async function runMcpOff(repo, version) {
  const shadowTools = [
    {
      name: 'peek',
      description: 'Read-only tool of the shadowme server.',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
      annotations: { readOnlyHint: true }
    },
    {
      name: 'poke',
      description: 'Changing tool of the shadowme server.',
      inputSchema: { type: 'object', properties: { target: { type: 'string' } } },
      annotations: { readOnlyHint: false, destructiveHint: true }
    }
  ]
  const shadowBase = await startFakeMcp('shadowme-real', { tools: shadowTools })
  const offBase = await startFakeMcp('shadowme-off', { tools: [], requireBearer: true })
  const bridgeUrl = await startBridge()
  writeFileSync(
    join(repo, '.cursor', 'mcp.json'),
    JSON.stringify({ mcpServers: { shadowme: { url: `${shadowBase}/mcp` } } }, null, 2)
  )
  writeFileSync(
    join(repo, '.cursor', 'cli.json'),
    JSON.stringify({ permissions: { allow: [], deny: [] } }, null, 2)
  )
  // Approve the project server in a SCRATCH data dir (spike N2): key = <name>-<16 hex of sha256 of {path, server}>.
  const dataDir = join(tmpRoot, 'cursor-data')
  const slug = repo
    .replace(/[^a-zA-Z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
  const entry = JSON.parse(readFileSync(join(repo, '.cursor', 'mcp.json'), 'utf8')).mcpServers
    .shadowme
  const key = `shadowme-${createHash('sha256')
    .update(JSON.stringify({ path: repo, server: entry }))
    .digest('hex')
    .slice(0, 16)}`
  mkdirSync(join(dataDir, 'projects', slug), { recursive: true })
  writeFileSync(join(dataDir, 'projects', slug, 'mcp-approvals.json'), JSON.stringify([key]))
  const env = { CURSOR_DATA_DIR: dataDir }
  // Preflight: the approved server must read `ready`, else the experiment proves nothing.
  // `--no-preflight` is for diagnosis only (approval is then unchecked).
  let listed = 'skipped (--no-preflight)'
  if (!args.includes('--no-preflight')) {
    note('preflight: agent mcp list in the scratch repo (this connects the real shadowme server)')
    // async on purpose: the fake servers live in this process and must answer while the CLI connects
    listed = await new Promise((ok, fail) =>
      execFile(
        BIN,
        ['mcp', 'list'],
        {
          cwd: repo,
          env: {
            ...Object.fromEntries(
              Object.entries(process.env).filter(([k]) => !k.startsWith('CURSOR_'))
            ),
            ...env
          },
          encoding: 'utf8',
          timeout: 60_000
        },
        (error, stdout) => (error ? fail(error) : ok(stdout.trim()))
      )
    )
    note(`preflight mcp list: ${listed}`)
    console.log('preflight mcp list:', listed)
    if (!/shadowme: ready/.test(listed))
      throw new Error(`shadowme is not approved/ready (${listed}); no prompt sent`)
  }

  spawnAgent(repo, version, [], env)
  await handshake()
  const afterPreflight = wire.length
  note('session/new with mcpServers [arc bridge, shadowme -> /off/shadowme]')
  const created = await request('session/new', {
    cwd: repo,
    mcpServers: [
      {
        type: 'http',
        name: 'arc',
        url: bridgeUrl,
        headers: [{ name: 'Authorization', value: `Bearer ${token}` }]
      },
      {
        type: 'http',
        name: 'shadowme',
        url: `${offBase}/off/shadowme`,
        headers: [{ name: 'Authorization', value: `Bearer ${token}` }]
      }
    ]
  })
  if (!created.result?.sessionId)
    throw new Error(`session/new failed: ${JSON.stringify(created.error)}`)
  const sessionId = created.result.sessionId
  await setModel(sessionId, created.result)
  await sleep(4000) // let the session entries connect
  const calls = (label, from, to) =>
    wire
      .slice(from, to)
      .filter((w) => w.dir === 'mcp-server' && w.server === label)
      .map((w) => `${w.http} ${w.mcpMethod ?? ''}${w.toolName ? `:${w.toolName}` : ''}`.trim())
  let promptAt // wire index where the prompt was sent
  const outcome = { preflight: listed }
  const finishOutcome = (extra) => {
    // Spike M7 found that the project server is connected (initialize + tools/list) when the agent process
    // STARTS with its cwd in the project, before session/new; the verdict therefore looks only at what
    // happens once the prompt is sent.
    const end = wire.length
    outcome.realShadowmeBeforePrompt = calls('shadowme-real', afterPreflight, promptAt ?? end)
    outcome.realShadowmeDuringPrompt =
      promptAt === undefined ? null : calls('shadowme-real', promptAt, end)
    outcome.realShadowmeToolsCall = (outcome.realShadowmeDuringPrompt ?? []).some((c) =>
      c.startsWith('POST tools/call')
    )
    outcome.realShadowmeToolsListDuringPrompt = (outcome.realShadowmeDuringPrompt ?? []).includes(
      'POST tools/list'
    )
    outcome.offEndpointRequests = calls('shadowme-off', afterPreflight, end)
    outcome.agentShadowmeToolCalls = wire
      .slice(afterPreflight)
      .filter(
        (w) =>
          w.dir === 's2c' &&
          ['tool_call', 'tool_call_update'].includes(w.msg?.params?.update?.sessionUpdate) &&
          /shadowme/i.test(JSON.stringify(w.msg.params.update))
      ).length
    Object.assign(outcome, extra)
    console.log('post-check:', JSON.stringify(outcome, null, 1))
    return outcome
  }
  if (DRY_RUN) {
    console.log('dry run: no prompt sent')
    return finish(version, undefined, finishOutcome({ dryRun: true }))
  }
  console.log('sending the ONE real prompt on model', MODEL)
  const replyFrom = wire.length
  promptAt = wire.length
  const turn = await request(
    'session/prompt',
    { sessionId, prompt: [{ type: 'text', text: MCP_OFF_PROMPT }] },
    180_000
  )
  let timedOut = false
  if (turn.error?.message?.startsWith('timeout awaiting')) {
    timedOut = true
    send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } })
    await sleep(5000)
  } else console.log('stopReason:', JSON.stringify(turn.result ?? turn.error))
  await sleep(2000)
  finish(
    version,
    MCP_OFF_PROMPT,
    finishOutcome({ timedOut, stopReason: turn.result ?? turn.error, reply: replyOf(replyFrom) })
  )
}

// ---- M5: `/name args` as prompt text against a project command file ----
const COMMAND_PROMPT = '/shout banana'
const COMMAND_BODY =
  'Reply with the word given as the argument in upper case, prefixed with "SHOUT: " and nothing else.\n'

/** The available_commands_update entries recorded so far, from any process. */
function listedCommands() {
  const update = wire
    .filter(
      (w) => w.dir === 's2c' && w.msg?.params?.update?.sessionUpdate === 'available_commands_update'
    )
    .at(-1)?.msg.params.update
  return update?.availableCommands ?? null
}

async function runCommand(repo, version) {
  mkdirSync(join(repo, '.cursor', 'commands'), { recursive: true })
  writeFileSync(join(repo, '.cursor', 'commands', 'shout.md'), COMMAND_BODY)
  writeFileSync(
    join(repo, '.cursor', 'cli.json'),
    JSON.stringify({ permissions: { allow: [], deny: [] } }, null, 2)
  )
  permissionHandler = declinePermission
  spawnAgent(repo, version)
  await handshake()
  const created = await request('session/new', { cwd: repo, mcpServers: [] })
  if (!created.result?.sessionId)
    throw new Error(`session/new failed: ${JSON.stringify(created.error)}`)
  const sessionId = created.result.sessionId
  await setModel(sessionId, created.result)
  await until(() => listedCommands() !== null, 10_000)
  await sleep(1000)
  const commands = listedCommands()
  const shout = commands?.find((c) => c?.name === 'shout') ?? null
  const outcome = {
    updateSeen: commands !== null,
    commandCount: commands?.length ?? 0,
    shoutListed: shout !== null,
    shoutEntry: shout,
    // names carrying a source suffix in the description, to see which come from other tools' folders
    descriptionSuffixes: [
      ...new Set(
        (commands ?? [])
          .map((c) => /\(([a-z]+)\)\s*$/i.exec(c?.description ?? '')?.[1])
          .filter(Boolean)
      )
    ]
  }
  console.log('available_commands_update:', JSON.stringify(outcome))
  if (DRY_RUN) {
    console.log('dry run: no prompt sent')
    return finish(version, undefined, { dryRun: true, ...outcome })
  }
  console.log('sending the ONE real prompt on model', MODEL, JSON.stringify(COMMAND_PROMPT))
  const from = wire.length
  const turn = await request(
    'session/prompt',
    { sessionId, prompt: [{ type: 'text', text: COMMAND_PROMPT }] },
    120_000
  )
  await sleep(2000)
  outcome.stopReason = turn.result ?? turn.error
  outcome.reply = replyOf(from)
  outcome.bodyRan = /SHOUT:\s*BANANA/.test(outcome.reply)
  console.log(
    'stopReason:',
    JSON.stringify(outcome.stopReason),
    'reply:',
    JSON.stringify(outcome.reply)
  )
  finish(version, COMMAND_PROMPT, outcome)
}

async function main() {
  if (!existsSync(BIN)) throw new Error(`no Cursor binary at ${BIN}`)
  const version = execFileSync(BIN, ['--version'], { encoding: 'utf8' }).trim()
  // throwaway repo with a local bare origin and a project deny rule for `git push`
  const repo = join(tmpRoot, 'repo')
  const remote = join(tmpRoot, 'remote.git')
  mkdirSync(repo, { recursive: true })
  git(tmpRoot, 'init', '-q', '--bare', '-b', 'main', remote)
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 'record@example.com')
  git(repo, 'config', 'user.name', 'record')
  writeFileSync(join(repo, 'README.md'), '# Scratch\n\nA tiny repo for a recording.\n')
  mkdirSync(join(repo, 'src'))
  writeFileSync(join(repo, 'src', 'hello.txt'), 'hello\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'init')
  git(repo, 'remote', 'add', 'origin', remote)
  mkdirSync(join(repo, '.cursor'))
  if (MCP_OFF) return runMcpOff(repo, version)
  if (COMMAND) return runCommand(repo, version)
  if (CANCEL || LOAD) {
    // nothing denied, nothing allowed in the project: the permission request must reach the recorder
    writeFileSync(
      join(repo, '.cursor', 'cli.json'),
      JSON.stringify({ permissions: { allow: [], deny: [] } }, null, 2)
    )
    return CANCEL ? runCancel(repo, version) : runLoad(repo, version)
  }
  if (ASK) {
    console.log('ask-mode scenario: no project deny; the session is switched to mode ask')
  } else if (SANDBOX) {
    // a folder under a Write deny (what Arc writes for the known folders) and one nothing mentions
    const known = join(tmpRoot, 'known')
    mkdirSync(known, { recursive: true })
    const deny = [...(await arcShellDenyEntries()), `Write(${known}/**)`]
    writeFileSync(
      join(repo, '.cursor', 'cli.json'),
      JSON.stringify({ permissions: { allow: [], deny } }, null, 2)
    )
    console.log(
      `sandbox scenario: cli.json has ${deny.length} deny entries; agent starts with --sandbox enabled`
    )
  } else {
    writeFileSync(
      join(repo, '.cursor', 'cli.json'),
      JSON.stringify({ permissions: { allow: [], deny: ['Shell(git push)'] } }, null, 2)
    )
  }
  const bridgeUrl = SANDBOX ? undefined : await startBridge()

  spawnAgent(repo, version, SANDBOX ? ['--sandbox', 'enabled'] : [])

  const init = await request('initialize', {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }
  })
  if (!init.result) throw new Error(`initialize failed: ${JSON.stringify(init.error)}`)
  const auth = await request('authenticate', { methodId: 'cursor_login' })
  if (auth.error)
    throw new Error(`authenticate failed: ${JSON.stringify(auth.error)}; nothing recorded`)
  const created = await request('session/new', {
    cwd: repo,
    mcpServers: bridgeUrl
      ? [
          {
            type: 'http',
            name: 'arc',
            url: bridgeUrl,
            headers: [{ name: 'Authorization', value: `Bearer ${token}` }]
          }
        ]
      : []
  })
  if (!created.result?.sessionId)
    throw new Error(`session/new failed: ${JSON.stringify(created.error)}`)
  const sessionId = created.result.sessionId
  const modelIds = (created.result.models?.availableModels ?? []).map((m) => m.modelId)
  if (!modelIds.includes(MODEL))
    throw new Error(`model ${MODEL} is not offered; no model call made`)
  const set = await request('session/set_model', { sessionId, modelId: MODEL })
  if (set.error) throw new Error(`session/set_model failed: ${JSON.stringify(set.error)}`)
  if (ASK) {
    const mode = await request('session/set_mode', { sessionId, modeId: 'ask' })
    if (mode.error) throw new Error(`session/set_mode failed: ${JSON.stringify(mode.error)}`)
    console.log('mode set to ask')
  }
  await new Promise((ok) => setTimeout(ok, SANDBOX ? 500 : 4000)) // let the `arc` server connect and list tools

  if (DRY_RUN) {
    console.log('dry run: no prompt sent')
    return finish(version, undefined, undefined)
  }
  const prompt = SANDBOX ? SANDBOX_PROMPT : ASK ? ASK_PROMPT : PROMPT
  console.log('sending the ONE real prompt on model', MODEL)
  const turn = await request(
    'session/prompt',
    { sessionId, prompt: [{ type: 'text', text: prompt }] },
    TURN_TIMEOUT_MS
  )
  let timedOut = false
  if (turn.error?.message?.startsWith('timeout awaiting')) {
    timedOut = true
    console.error('turn timed out, cancelling')
    send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } })
    await new Promise((ok) => setTimeout(ok, 5000))
  } else {
    console.log('stopReason:', JSON.stringify(turn.result ?? turn.error))
  }
  await new Promise((ok) => setTimeout(ok, 2000)) // trailing notifications
  // What the scratch repo looks like afterwards (not part of the wire): proves what really ran.
  const read = (path) => (existsSync(path) ? readFileSync(path, 'utf8').trim() : null)
  const after = ASK
    ? {
        // notesTxt true = the edit really ran in ask mode; echoCalls > 0 = the arc tool really ran
        notesTxt: existsSync(join(repo, 'notes.txt')),
        echoCalls: wire.filter((w) => w.dir === 'bridge' && w.event?.echoCall !== undefined).length,
        gitStatus: git(repo, 'status', '--short')
      }
    : SANDBOX
      ? {
          // null = the file does not exist. outside.txt is the sandbox's question; denied.txt is the Write deny's.
          insideTxt: read(join(repo, 'inside.txt')),
          outsideTxt: read(join(tmpRoot, 'outside.txt')),
          knownDeniedTxt: read(join(tmpRoot, 'known', 'denied.txt'))
        }
      : {
          notesTxt: existsSync(join(repo, 'notes.txt')),
          remoteHasMain: (() => {
            try {
              // a failing rev-parse here means the push did not land: the remote has no branch
              git(remote, 'rev-parse', '--verify', 'main')
              return true
            } catch {
              return false
            }
          })(),
          gitStatus: git(repo, 'status', '--short')
        }
  console.log('repo after:', JSON.stringify(after))
  finish(version, prompt, { timedOut, after })
}

function finish(version, prompt, outcome) {
  const scrub = scrubber()
  const meta = {
    dir: 'meta',
    cursorVersion: version,
    model: MODEL,
    mode: ASK ? 'ask' : 'agent',
    scenario: SCENARIO,
    sandboxFlag: SANDBOX,
    recordedAt: new Date().toISOString().slice(0, 10),
    prompt: prompt ?? '(dry run)',
    outcome: outcome ?? null
  }
  mkdirSync(dirname(OUT), { recursive: true })
  const lines = [meta, ...wire].map((entry) => JSON.stringify(scrub(entry)))
  writeFileSync(OUT, `${lines.join('\n')}\n`)
  console.log(`wrote ${lines.length} lines to ${OUT}`)
  console.log('scrub counts:', JSON.stringify(counts))
  console.log('agent requests answered:', agentRequests.join(', '))
}

process.on('SIGINT', () => void cleanup().then(() => process.exit(130)))
try {
  await main()
} catch (error) {
  console.error('recording failed:', error instanceof Error ? error.message : error)
  process.exitCode = 1
} finally {
  await cleanup()
}
