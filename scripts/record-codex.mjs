// Dev-only (never built or shipped): records ONE small real Codex turn from `codex app-server` as
// scrubbed JSONL for tests/fixtures/codex/<version>/real-turn.jsonl (spec 007, tech spec section 4).
//
// It makes ONE real model call, so it refuses to run without --confirm-real-run.
//   node scripts/record-codex.mjs --confirm-real-run [--model gpt-6-luna] [--effort low] [--out <file>]
//   node scripts/record-codex.mjs --confirm-real-run --dry-run --out <file>   (no turn, no model call)
//
// What it does, in a throwaway git repo with a linked worktree:
//   1. no-model sandbox pre-check with `command/exec` (aborts before the model call if it is wrong);
//   2. a real turn that reads a file, applies one patch, runs one command that needs approval
//      (`git commit`, forced to ask by a worktree rules file) and calls one tool of a local fake
//      MCP server named `arc` (approval mode `prompt`, so the elicitation shape is recorded);
//   3. every JSON-RPC line in both directions is written, scrubbed, to the output file.
// The user's real CODEX_HOME is used for auth only. Nothing is written to it by this script;
// Codex itself keeps its own session and cache files there. All overrides are per thread.
import { spawn, execFileSync } from 'node:child_process'
import http from 'node:http'
import os from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(name)
  return i === -1 ? fallback : (args[i + 1] ?? fallback)
}
if (!args.includes('--confirm-real-run')) {
  console.error('This makes one real Codex model call. Re-run with --confirm-real-run.')
  process.exit(2)
}
const MODEL = flag('--model', 'gpt-6-luna')
const EFFORT = flag('--effort', 'low')
const OUT = resolve(flag('--out', 'tests/fixtures/codex/0.162.1/real-turn.jsonl'))
const DRY_RUN = args.includes('--dry-run')
const TURN_TIMEOUT_MS = 240_000
const MAX_SERVER_REQUESTS = 12

const token = randomBytes(12).toString('hex')
const tmpRoot = realpathSync(mkdtempSync(join(os.tmpdir(), 'arc-record-codex-')))
const wire = []
const t0 = Date.now()
let child
let bridgeServer

function git(cwd, ...gitArgs) {
  return execFileSync('git', gitArgs, { cwd, encoding: 'utf8' }).trim()
}

// ---- fake bridge: one MCP server, tools echo (read only) and note (changes state) ----
function startBridge() {
  const server = http.createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401)
      res.end()
      return
    }
    const mcp = new McpServer({ name: 'fake-bridge', version: '0.0.1' })
    mcp.registerTool(
      'echo',
      {
        description: 'Echo the text back.',
        inputSchema: { text: z.string() },
        annotations: { readOnlyHint: true }
      },
      ({ text }) => ({ content: [{ type: 'text', text: `echo:${text}` }] })
    )
    mcp.registerTool(
      'note',
      {
        description: 'Store a note (changes state).',
        inputSchema: { text: z.string() },
        annotations: { readOnlyHint: false }
      },
      ({ text }) => ({ content: [{ type: 'text', text: `noted:${text}` }] })
    )
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.on('close', () => {
      void transport.close()
      void mcp.close()
    })
    await mcp.connect(transport)
    await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined)
  })
  return new Promise((ok) =>
    server.listen(0, '127.0.0.1', () => {
      bridgeServer = server
      ok(`http://127.0.0.1:${server.address().port}/mcp`)
    })
  )
}

// ---- JSON-RPC over the app-server's stdio ----
const pending = new Map()
const serverRequests = []
let nextId = 0
let turnDone
const turnCompleted = new Promise((ok) => (turnDone = ok))
let serverRequestCount = 0

// Request ids whose request and reply must stay out of the recording (config/read returns the
// user's whole config, including MCP server env values).
const quietIds = new Set()
function log(dir, msg) {
  // Client ids and server-request ids are separate namespaces: match requests we sent and the
  // replies to them only.
  const isOurs = dir === 'c2s' ? msg.method !== undefined : msg.method === undefined
  if (isOurs && msg.id !== undefined && quietIds.has(msg.id)) return
  wire.push({ dir, t: Date.now() - t0, msg })
}
function send(obj) {
  log('c2s', obj)
  child.stdin.write(`${JSON.stringify(obj)}\n`)
}
function request(method, params, timeoutMs = 30_000, quiet = false) {
  return new Promise((ok) => {
    const id = ++nextId
    if (quiet) quietIds.add(id)
    pending.set(id, ok)
    send({ id, method, params })
    setTimeout(() => ok({ error: { message: `timeout awaiting ${method}` } }), timeoutMs)
  })
}

function answer(msg) {
  serverRequestCount += 1
  serverRequests.push(msg.method)
  switch (msg.method) {
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
      return { decision: 'accept' }
    case 'mcpServer/elicitation/request':
      return { action: 'accept', content: null }
    case 'item/permissions/requestApproval':
      return { permissions: msg.params.permissions, scope: 'turn' }
    default:
      return { action: 'cancel', decision: 'cancel' }
  }
}

function onLine(line) {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  log('s2c', msg)
  if (msg.method && msg.id !== undefined) {
    if (serverRequestCount >= MAX_SERVER_REQUESTS) {
      console.error('too many server requests, interrupting')
      send({ id: msg.id, result: { decision: 'cancel', action: 'cancel' } })
      return
    }
    send({ id: msg.id, result: answer(msg) })
  } else if (msg.id !== undefined && pending.has(msg.id)) {
    pending.get(msg.id)(msg)
    pending.delete(msg.id)
  } else if (msg.method === 'turn/completed') {
    turnDone(msg.params.turn)
  }
}

// ---- scrubbing ----
const counts = {}
function scrubber() {
  const home = os.homedir()
  const user = os.userInfo().username
  const host = os.hostname()
  const codexHome = process.env.CODEX_HOME ?? join(home, '.codex')
  const rules = [
    ['tmp-root', new RegExp(escape(tmpRoot), 'g'), '<TMP>'],
    ['tmp-root-var-alias', new RegExp(escape(tmpRoot.replace(/^\/private/, '')), 'g'), '<TMP>'],
    ['bridge-token', new RegExp(escape(token), 'g'), '<BRIDGE_TOKEN>'],
    ['codex-home', new RegExp(escape(codexHome), 'g'), '<CODEX_HOME>'],
    ['home', new RegExp(escape(home), 'g'), '<HOME>'],
    ['hostname', new RegExp(escape(host), 'g'), '<HOST>'],
    ['email', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, 'user@example.com'],
    ['bearer', /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/g, 'Bearer <REDACTED>'],
    ['jwt', /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_.-]+/g, '<JWT>'],
    ['api-key', /\bsk-[A-Za-z0-9_-]{8,}/g, '<API_KEY>'],
    ['username', new RegExp(`\\b${escape(user)}\\b`, 'g'), '<USER>']
  ]
  const secretKeys =
    /^(email|installationId|accountId|chatgptAccountId|userId|organizationId|orgId)$/i
  const walk = (value, key) => {
    if (typeof value === 'string') {
      if (key && secretKeys.test(key)) {
        counts[`key:${key}`] = (counts[`key:${key}`] ?? 0) + 1
        return key.toLowerCase() === 'email' ? 'user@example.com' : `<${key.toUpperCase()}>`
      }
      let out = value
      for (const [name, re, to] of rules) {
        out = out.replace(re, () => {
          counts[name] = (counts[name] ?? 0) + 1
          return to
        })
      }
      return out
    }
    if (Array.isArray(value)) return value.map((v) => walk(v))
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, k)]))
    }
    return value
  }
  return (value) => walk(value)
}
function escape(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function cleanup() {
  try {
    child?.kill('SIGTERM')
  } catch {
    // already gone
  }
  bridgeServer?.close()
  await new Promise((ok) => setTimeout(ok, 500))
  try {
    child?.kill('SIGKILL')
  } catch {
    // already gone
  }
  rmSync(tmpRoot, { recursive: true, force: true })
}

async function main() {
  // throwaway repo with a linked worktree
  const repo = join(tmpRoot, 'repo')
  mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 'record@example.com')
  git(repo, 'config', 'user.name', 'record')
  writeFileSync(join(repo, 'hello.txt'), 'hello\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'init')
  const wt = join(tmpRoot, 'wt')
  git(repo, 'worktree', 'add', '-q', '-b', 'record', wt)
  const common = join(repo, '.git')
  const admin = join(common, 'worktrees', 'wt')
  // Force `git commit` to ask even though the user's own rules may allow it (strictest rule wins).
  mkdirSync(join(wt, '.codex', 'rules'), { recursive: true })
  writeFileSync(
    join(wt, '.codex', 'rules', 'arc.rules'),
    'prefix_rule(pattern=["git", "commit"], decision="prompt")\n'
  )
  const bridgeUrl = await startBridge()

  child = spawn('codex', ['app-server'], {
    env: { ...process.env, ARC_BRIDGE_TOKEN: token },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  console.log(`codex app-server pid ${child.pid}`)
  let buf = ''
  child.stdout.on('data', (d) => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      onLine(buf.slice(0, i))
      buf = buf.slice(i + 1)
    }
  })
  child.stderr.on('data', () => {})

  const init = await request('initialize', {
    clientInfo: { name: 'arc-record', title: 'Arc recorder', version: '0' },
    capabilities: { experimentalApi: true }
  })
  send({ method: 'initialized' })
  const version = /\/(\d+\.\d+\.\d+)/.exec(init.result?.userAgent ?? '')?.[1] ?? 'unknown'
  const account = await request('account/read', { refreshToken: false })
  if (!account.result?.account) throw new Error('Codex is not signed in; nothing recorded')

  // personal servers and plugins are switched off for this thread (per-thread merge, no file change)
  const cfg =
    (await request('config/read', { includeLayers: false }, 30_000, true)).result?.config ?? {}
  const off = (obj) =>
    Object.fromEntries(Object.keys(obj ?? {}).map((k) => [k, { enabled: false }]))
  const roots = [admin, join(common, 'objects'), join(common, 'refs'), join(common, 'logs')]
  const threadConfig = {
    sandbox_workspace_write: {
      writable_roots: roots,
      exclude_slash_tmp: true,
      exclude_tmpdir_env_var: true,
      network_access: false
    },
    mcp_servers: {
      ...off(cfg.mcp_servers),
      arc: {
        url: bridgeUrl,
        bearer_token_env_var: 'ARC_BRIDGE_TOKEN',
        startup_timeout_sec: 20,
        tool_timeout_sec: 86_400,
        required: true,
        default_tools_approval_mode: 'prompt'
      }
    },
    plugins: off(cfg.plugins),
    notify: [],
    features: { memories: false, multi_agent: false, goals: false },
    memories: { use_memories: false, generate_memories: false },
    web_search: 'disabled'
  }

  // 1. no-model pre-check of the sandbox policy (aborts before the real call)
  const policy = {
    type: 'workspaceWrite',
    writableRoots: roots,
    networkAccess: false,
    excludeSlashTmp: true,
    excludeTmpdirEnvVar: true
  }
  const outside = await request('command/exec', {
    command: ['sh', '-c', `echo x >> ${join(repo, 'hello.txt')}`],
    cwd: wt,
    sandboxPolicy: policy,
    timeoutMs: 10_000
  })
  const inside = await request('command/exec', {
    command: ['sh', '-c', `touch ${join(admin, 'precheck')} && rm ${join(admin, 'precheck')}`],
    cwd: wt,
    sandboxPolicy: policy,
    timeoutMs: 10_000
  })
  if (outside.result?.exitCode === 0 || inside.result?.exitCode !== 0) {
    throw new Error(
      `sandbox pre-check failed (outside=${outside.result?.exitCode}, inside=${inside.result?.exitCode}); no model call made`
    )
  }
  console.log('sandbox pre-check ok: main checkout write denied, worktree admin dir writable')

  // 2. the one real turn
  const started = await request('thread/start', {
    cwd: wt,
    model: MODEL,
    modelProvider: 'openai',
    approvalPolicy: 'untrusted',
    approvalsReviewer: 'user',
    sandbox: 'workspace-write',
    ephemeral: DRY_RUN,
    developerInstructions:
      'This is a test harness. Do exactly the numbered steps, in order, with no extra commands or commentary.',
    config: threadConfig
  })
  if (!started.result) throw new Error(`thread/start failed: ${JSON.stringify(started.error)}`)
  const threadId = started.result.thread.id
  await new Promise((ok) => setTimeout(ok, 3000)) // let the `arc` server report ready
  const prompt = [
    '1. Run the shell command `cat hello.txt`.',
    '2. Use apply_patch to append the line "patched" to hello.txt.',
    '3. Run the shell command `git commit -am record`.',
    '4. Call the `echo` tool of the `arc` MCP server with text "ping".',
    '5. Reply with the single word: done.'
  ].join('\n')
  if (DRY_RUN) {
    const status = (await request('mcpServerStatus/list', {})).result?.data ?? []
    console.log('dry run: no turn started; mcp servers:', status.map((s) => s.name).join(','))
    return finish(version, undefined)
  }
  console.log('starting the ONE real turn on model', MODEL)
  const turn = await request('turn/start', {
    threadId,
    effort: EFFORT,
    input: [{ type: 'text', text: prompt }]
  })
  const turnId = turn.result?.turn?.id
  const result = await Promise.race([
    turnCompleted,
    new Promise((ok) => setTimeout(() => ok('timeout'), TURN_TIMEOUT_MS))
  ])
  if (result === 'timeout') {
    console.error('turn timed out, interrupting')
    await request('turn/interrupt', { threadId, turnId }, 15_000)
  } else {
    console.log('turn status:', result.status)
  }
  await new Promise((ok) => setTimeout(ok, 1500)) // trailing notifications
  finish(version, prompt)
}

function finish(version, prompt) {
  const scrub = scrubber()
  const meta = {
    dir: 'meta',
    codexVersion: version,
    model: MODEL,
    effort: EFFORT,
    recordedAt: new Date().toISOString().slice(0, 10),
    prompt: prompt ?? '(dry run)'
  }
  mkdirSync(dirname(OUT), { recursive: true })
  const lines = [meta, ...wire].map((entry) => JSON.stringify(scrub(entry)))
  writeFileSync(OUT, `${lines.join('\n')}\n`)
  console.log(`wrote ${lines.length} lines to ${OUT}`)
  console.log('scrub counts:', JSON.stringify(counts))
  console.log('server requests answered:', serverRequests.join(', '))
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
