// Dev-only (never built or shipped): spikes K1 and K2 of spec 015 (Skip all approvals).
//
// Drives `codex app-server` over JSON-RPC, as Arc's Codex adapter does, against a SCRIPTED local
// Responses provider (a tiny HTTP server on 127.0.0.1 that replays fixed tool calls). There is no
// model call and no network beyond 127.0.0.1. Everything runs in a throwaway directory with its
// own CODEX_HOME and HOME, so the user's ~/.codex, ~/.cursor and ~/.claude are never touched.
//
//   node scripts/spike-015-codex.mjs [--out <dir>] [--only k1|k2]
//
// K1: under `danger-full-access` (and the fallback `workspaceWrite` root `/` with network on) with
//     approvalPolicy `untrusted`, do command and file-change approvals still reach the client, and does
//     an `arc.rules` prompt rule still ask when a user-level rule allows `git push`?
// K2: does a `turn/start` `sandboxPolicy` override apply to that turn and later ones, does an explicit
//     restore take effect, and does an accepted command run unsandboxed under the override?
import { spawn, execFileSync } from 'node:child_process'
import http from 'node:http'
import os from 'node:os'
import { join, resolve } from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync, existsSync } from 'node:fs'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(name)
  return i === -1 ? fallback : (args[i + 1] ?? fallback)
}
const OUT = resolve(flag('--out', 'tests/fixtures/codex/0.163.0/skip-approvals'))
const ONLY = flag('--only', 'all')
const CODEX_BIN = flag('--codex-bin', 'codex')
// An unknown slug: Codex then lists its generic tools (a known slug listed none against this provider).
const MODEL = flag('--model', 'scripted-model')
const TURN_TIMEOUT_MS = 60_000
const HARD_LIMIT_MS = 6 * 60_000

const root = realpathSync(mkdtempSync(join(os.tmpdir(), 'arc-spike015-codex-')))
const codexHome = join(root, 'codex-home')
const fakeHome = join(root, 'home')
const outside = join(root, 'outside')
const remote = join(root, 'remote.git')
const repo = join(root, 'repo')
for (const d of [codexHome, join(codexHome, 'rules'), fakeHome, outside]) {
  mkdirSync(d, { recursive: true })
}

function sh(cwd, cmd, ...a) {
  return execFileSync(cmd, a, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, HOME: fakeHome, GIT_CONFIG_GLOBAL: '/dev/null' }
  }).trim()
}

// ---- throwaway repositories: one main checkout, linked worktrees, a local bare remote ----
sh(root, 'git', 'init', '--bare', '-q', remote)
sh(root, 'git', 'init', '-q', '-b', 'main', repo)
sh(repo, 'git', 'config', 'user.email', 'spike@example.com')
sh(repo, 'git', 'config', 'user.name', 'Spike')
writeFileSync(join(repo, 'README.md'), 'spike\n')
sh(repo, 'git', 'add', '-A')
sh(repo, 'git', 'commit', '-q', '-m', 'init')
sh(repo, 'git', 'remote', 'add', 'origin', remote)
sh(repo, 'git', 'push', '-q', 'origin', 'main')

/** One linked worktree on its own branch; `withRules` writes the arc.rules prompt rule. */
function makeWorktree(name, withRules) {
  const dir = join(root, name)
  sh(repo, 'git', 'worktree', 'add', '-q', '-b', name, dir)
  if (withRules) {
    mkdirSync(join(dir, '.codex', 'rules'), { recursive: true })
    writeFileSync(
      join(dir, '.codex', 'rules', 'arc.rules'),
      '# the same line Arc writes (src/main/agents/codex/codex-rules.ts)\n' +
        'prefix_rule(pattern=["git","push"], decision="prompt")\n'
    )
  }
  return dir
}

// ---- the scripted Responses provider ----
const scenarios = new Map() // name -> steps
const providerLog = []
let respN = 0

function sse(res, events) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  for (const ev of events) res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`)
  res.end()
}

function itemText(item) {
  const c = item?.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.map((p) => p.text ?? '').join('')
  return ''
}

function planResponse(body) {
  const input = Array.isArray(body.input) ? body.input : []
  let lastUser = -1
  for (let i = input.length - 1; i >= 0; i--) {
    if (
      input[i].type === 'message' &&
      input[i].role === 'user' &&
      /SCENARIO:/.test(itemText(input[i]))
    ) {
      lastUser = i
      break
    }
  }
  const scenario =
    lastUser >= 0 ? /SCENARIO:([\w-]+)/.exec(itemText(input[lastUser]))?.[1] : undefined
  const outputs = input.slice(lastUser + 1).filter((it) => /_output$/.test(it.type)).length
  const steps = scenario ? scenarios.get(scenario) : undefined
  return { scenario, outputs, steps, lastUser }
}

function toolNames(body) {
  return (body.tools ?? []).map((t) => `${t.type}:${t.name ?? t.function?.name ?? ''}`)
}

function toolItem(body, step) {
  const tools = body.tools ?? []
  const callId = `call_${++respN}`
  if (step.kind === 'shell') {
    const names = tools.map((t) => t.name)
    const name = ['shell_command', 'shell', 'exec_command'].find((n) => names.includes(n))
    const argsObj =
      name === 'shell'
        ? { command: ['bash', '-lc', step.cmd], workdir: step.workdir }
        : name === 'exec_command'
          ? { cmd: step.cmd, workdir: step.workdir }
          : { command: step.cmd, workdir: step.workdir }
    return { type: 'function_call', call_id: callId, name, arguments: JSON.stringify(argsObj) }
  }
  // apply_patch: freeform (custom) tool or function tool, whichever this build lists
  const tool = tools.find((t) => t.name === 'apply_patch')
  if (!tool) {
    // this build lists no apply_patch tool for the model: Codex intercepts `apply_patch` run as a command
    const cmd = `apply_patch <<'PATCH'\n${step.patch}PATCH`
    const names = tools.map((t) => t.name)
    const name = ['shell_command', 'shell', 'exec_command'].find((n) => names.includes(n))
    const a =
      name === 'exec_command'
        ? { cmd, workdir: step.workdir }
        : { command: cmd, workdir: step.workdir }
    return { type: 'function_call', call_id: callId, name, arguments: JSON.stringify(a) }
  }
  if (tool?.type === 'custom') {
    return { type: 'custom_tool_call', call_id: callId, name: 'apply_patch', input: step.patch }
  }
  return {
    type: 'function_call',
    call_id: callId,
    name: 'apply_patch',
    arguments: JSON.stringify({ input: step.patch })
  }
}

const providerServer = http.createServer(async (req, res) => {
  let raw = ''
  for await (const chunk of req) raw += chunk
  if (req.method !== 'POST' || !/\/responses$/.test(req.url ?? '')) {
    providerLog.push({ path: req.url, method: req.method, note: 'not a responses call' })
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{}')
    return
  }
  const body = JSON.parse(raw)
  if (process.env.SPIKE_DUMP)
    writeFileSync(`${process.env.SPIKE_DUMP}-${providerLog.length}.json`, raw)
  const { scenario, outputs, steps } = planResponse(body)
  const id = `resp_${++respN}`
  const log = {
    n: providerLog.length + 1,
    scenario,
    toolOutputsSoFar: outputs,
    tools: toolNames(body),
    lastInputType: body.input?.at?.(-1)?.type
  }
  const created = { type: 'response.created', response: { id } }
  const completed = {
    type: 'response.completed',
    response: { id, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }
  }
  if (steps && outputs < steps.length) {
    const item = toolItem(body, steps[outputs])
    log.emitted = `${item.type}:${item.name}`
    providerLog.push(log)
    sse(res, [
      created,
      { type: 'response.output_item.added', output_index: 0, item },
      { type: 'response.output_item.done', output_index: 0, item },
      completed
    ])
    return
  }
  const item = {
    type: 'message',
    role: 'assistant',
    id: `msg_${respN}`,
    content: [{ type: 'output_text', text: `scripted done (${scenario ?? 'no scenario'})` }]
  }
  log.emitted = 'message'
  providerLog.push(log)
  sse(res, [
    created,
    { type: 'response.output_item.added', output_index: 0, item },
    { type: 'response.output_item.done', output_index: 0, item },
    completed
  ])
})
await new Promise((ok) => providerServer.listen(0, '127.0.0.1', ok))
const providerPort = providerServer.address().port

// The user's own rule allows git push; it is why the prompt rule matters (CODEX_HOME rules, temp only).
writeFileSync(
  join(codexHome, 'rules', 'default.rules'),
  'prefix_rule(pattern=["git","push"], decision="allow")\n'
)
writeFileSync(
  join(codexHome, 'config.toml'),
  [
    `model = "${MODEL}"`,
    'model_provider = "scripted"',
    '[model_providers.scripted]',
    'name = "Scripted"',
    `base_url = "http://127.0.0.1:${providerPort}/v1"`,
    'wire_api = "responses"',
    'requires_openai_auth = false',
    'supports_websockets = false',
    ''
  ].join('\n')
)

// ---- JSON-RPC driver over the app-server's stdio ----
class Driver {
  constructor(label, decide) {
    this.label = label
    this.decide = decide
    this.wire = []
    this.pending = new Map()
    this.waiters = []
    this.nextId = 0
    this.t0 = Date.now()
    this.serverRequests = []
    const env = {
      PATH: process.env.PATH,
      HOME: fakeHome,
      CODEX_HOME: codexHome,
      TMPDIR: process.env.TMPDIR ?? '/tmp',
      GIT_CONFIG_GLOBAL: '/dev/null'
    }
    this.child = spawn(CODEX_BIN, ['app-server'], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    this.pid = this.child.pid
    this.stderr = ''
    this.child.stderr.on('data', (d) => (this.stderr += d))
    let buf = ''
    this.child.stdout.on('data', (d) => {
      buf += d
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (line.trim()) this.onLine(line)
      }
    })
  }
  log(dir, msg) {
    this.wire.push({ dir, t: Date.now() - this.t0, msg })
  }
  send(obj) {
    this.log('c2s', obj)
    this.child.stdin.write(`${JSON.stringify(obj)}\n`)
  }
  request(method, params, timeoutMs = 30_000) {
    return new Promise((ok) => {
      const id = ++this.nextId
      this.pending.set(id, ok)
      this.send({ id, method, params })
      setTimeout(() => ok({ error: { message: `timeout awaiting ${method}` } }), timeoutMs)
    })
  }
  notify(method, params) {
    this.send(params ? { method, params } : { method })
  }
  onLine(line) {
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    this.log('s2c', msg)
    if (msg.method && msg.id !== undefined) {
      this.serverRequests.push(msg)
      this.send({ id: msg.id, result: this.decide(msg) })
    } else if (msg.id !== undefined && this.pending.has(msg.id)) {
      this.pending.get(msg.id)(msg)
      this.pending.delete(msg.id)
    } else if (msg.method) {
      for (const w of [...this.waiters]) if (w.match(msg)) w.ok(msg)
    }
  }
  waitFor(match, timeoutMs = TURN_TIMEOUT_MS) {
    return new Promise((ok) => {
      const w = { match, ok: (m) => (this.waiters.splice(this.waiters.indexOf(w), 1), ok(m)) }
      this.waiters.push(w)
      setTimeout(() => ok(null), timeoutMs)
    })
  }
  async init() {
    const r = await this.request('initialize', {
      clientInfo: { name: 'arc-spike', title: 'Arc spike', version: '0.0.0' },
      capabilities: { experimentalApi: true }
    })
    this.notify('initialized')
    return r
  }
  stop() {
    try {
      this.child.kill('SIGTERM')
    } catch {
      /* already gone */
    }
  }
}

function acceptAll(msg) {
  switch (msg.method) {
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
      return { decision: 'accept' }
    case 'item/permissions/requestApproval':
      return { permissions: msg.params.permissions, scope: 'turn' }
    default:
      return { decision: 'cancel', action: 'cancel' }
  }
}

/** Runs one scripted turn and returns what happened in it. */
async function runTurn(driver, threadId, scenario, steps, extra = {}) {
  scenarios.set(scenario, steps)
  const before = driver.serverRequests.length
  const wireStart = driver.wire.length
  const done = driver.waitFor((m) => m.method === 'turn/completed')
  const started = await driver.request('turn/start', {
    threadId,
    input: [{ type: 'text', text: `SCENARIO:${scenario}`, text_elements: [] }],
    ...extra
  })
  const completed = await done
  const slice = driver.wire.slice(wireStart)
  const approvals = driver.serverRequests.slice(before).map((m) => ({
    method: m.method,
    command: m.params?.command ?? undefined,
    reason: m.params?.reason ?? undefined,
    proposedExecpolicyAmendment: m.params?.proposedExecpolicyAmendment ?? undefined
  }))
  const items = slice
    .filter((l) => l.dir === 's2c' && l.msg.method === 'item/completed')
    .map((l) => l.msg.params.item)
    .filter((it) => it.type !== 'userMessage' && it.type !== 'agentMessage')
    .map((it) => ({
      type: it.type,
      command: it.command,
      status: it.status,
      exitCode: it.exitCode,
      output: it.aggregatedOutput,
      changes: it.changes
    }))
  const settings = slice
    .filter((l) => l.dir === 's2c' && l.msg.method === 'thread/settings/updated')
    .map((l) => l.msg.params)
  return {
    scenario,
    startError: started.error?.message,
    status: completed?.params?.turn?.status ?? 'NO turn/completed (timeout)',
    approvals,
    items,
    settingsEchoes: settings
  }
}

async function startThread(driver, params) {
  const r = await driver.request('thread/start', {
    modelProvider: 'scripted',
    model: MODEL,
    approvalPolicy: 'untrusted',
    approvalsReviewer: 'user',
    ephemeral: false,
    ...params
  })
  return { id: r.result?.thread?.id, response: r }
}

const results = { k1: {}, k2: {} }
const recorded = []

function finishDriver(driver, file) {
  recorded.push({
    file,
    wire: driver.wire,
    pid: driver.pid,
    stderrTail: driver.stderr.slice(-2000)
  })
  driver.stop()
}

// ---- K1 ----
async function k1(mode) {
  const label = mode.name
  const driver = new Driver(`k1-${label}`, acceptAll)
  await driver.init()
  const wt = makeWorktree(`k1-${label}-rules`, true)
  const wtControl = makeWorktree(`k1-${label}-control`, false)
  const sandboxConfig =
    mode.sandbox === 'workspace-write'
      ? {
          sandbox_workspace_write: {
            writable_roots: ['/'],
            exclude_slash_tmp: true,
            exclude_tmpdir_env_var: true,
            network_access: true
          }
        }
      : {}
  const thread = await startThread(driver, {
    cwd: wt,
    sandbox: mode.sandbox,
    config: sandboxConfig
  })
  const out = { threadStart: thread.response.error ?? 'ok', turns: [] }
  const startEcho = thread.response.result?.sandbox ?? thread.response.result?.sandboxPolicy
  out.sandboxEcho = startEcho
  out.turns.push(
    await runTurn(driver, thread.id, `K1-${label}-cmd`, [
      { kind: 'shell', cmd: `touch ${wt}/k1-cmd.txt && echo made`, workdir: wt }
    ])
  )
  out.turns.push(
    await runTurn(driver, thread.id, `K1-${label}-patch`, [
      {
        kind: 'patch',
        patch: '*** Begin Patch\n*** Add File: k1-patch.txt\n+patched\n*** End Patch\n'
      }
    ])
  )
  out.turns.push(
    await runTurn(driver, thread.id, `K1-${label}-patch-outside`, [
      {
        kind: 'patch',
        patch: `*** Begin Patch\n*** Add File: ${outside}/k1-${label}-patch-outside.txt\n+outside\n*** End Patch\n`
      }
    ])
  )
  out.turns.push(
    await runTurn(driver, thread.id, `K1-${label}-push-rule`, [
      { kind: 'shell', cmd: 'git push origin HEAD', workdir: wt }
    ])
  )
  out.files = {
    cmd: existsSync(join(wt, 'k1-cmd.txt')),
    patch: existsSync(join(wt, 'k1-patch.txt')),
    patchOutside: existsSync(join(outside, `k1-${label}-patch-outside.txt`))
  }
  // control: the same push with NO arc.rules, so the user's allow rule applies
  const control = await startThread(driver, {
    cwd: wtControl,
    sandbox: mode.sandbox,
    config: sandboxConfig
  })
  out.turns.push(
    await runTurn(driver, control.id, `K1-${label}-push-control`, [
      { kind: 'shell', cmd: 'git push origin HEAD', workdir: wtControl }
    ])
  )
  out.remoteBranches = sh(root, 'git', '--git-dir', remote, 'branch', '--list')
    .split('\n')
    .map((s) => s.trim())
  finishDriver(driver, `k1-${label}.jsonl`)
  results.k1[label] = out
}

// ---- K2 ----
async function k2() {
  const driver = new Driver('k2', acceptAll)
  await driver.init()
  const wt = makeWorktree('k2-wt', false)
  const thread = await startThread(driver, {
    cwd: wt,
    sandbox: 'workspace-write',
    config: {
      sandbox_workspace_write: {
        writable_roots: [wt],
        exclude_slash_tmp: true,
        exclude_tmpdir_env_var: true,
        network_access: false
      }
    }
  })
  const out = {
    threadStart: thread.response.error ?? 'ok',
    sandboxEcho: thread.response.result?.sandbox,
    turns: []
  }
  const writeCmd = (n) =>
    `echo ${n} > ${outside}/${n}.txt; echo "outside-exit=$?"; echo ${n} > ${wt}/in-${n}.txt; echo "inside-exit=$?"`
  const plan = [
    ['T1-baseline-no-override', undefined],
    ['T2-override-danger', { sandboxPolicy: { type: 'dangerFullAccess' } }],
    ['T3-no-override-after-danger', undefined],
    [
      'T4-restore-with-tmp-excludes',
      {
        sandboxPolicy: {
          type: 'workspaceWrite',
          writableRoots: [wt],
          networkAccess: false,
          excludeSlashTmp: true,
          excludeTmpdirEnvVar: true
        }
      }
    ],
    ['T5-no-override-after-restore', undefined],
    [
      'T6-restore-without-tmp-excludes',
      { sandboxPolicy: { type: 'workspaceWrite', writableRoots: [wt], networkAccess: false } }
    ]
  ]
  for (const [name, extra] of plan) {
    const tag = name.split('-')[0].toLowerCase()
    const turn = await runTurn(
      driver,
      thread.id,
      `K2-${name}`,
      [{ kind: 'shell', cmd: writeCmd(tag), workdir: wt }],
      extra
    )
    turn.outsideFileExists = existsSync(join(outside, `${tag}.txt`))
    turn.insideFileExists = existsSync(join(wt, `in-${tag}.txt`))
    out.turns.push(turn)
  }
  finishDriver(driver, 'k2-override.jsonl')
  results.k2 = out
}

// ---- scrubbing and writing ----
function scrub(text) {
  const user = os.userInfo().username
  const rules = [
    [new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '<TMP>'],
    [
      new RegExp(root.replace(/^\/private/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
      '<TMP>'
    ],
    [new RegExp(os.homedir().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '<HOME>'],
    [new RegExp(`\\b${user}\\b`, 'g'), '<USER>'],
    [new RegExp(os.hostname().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '<HOST>'],
    [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, 'user@example.com'],
    [/127\.0\.0\.1:\d+/g, '127.0.0.1:<PORT>']
  ]
  let out = text
  for (const [re, to] of rules) out = out.replace(re, to)
  return out
}

const watchdog = setTimeout(() => {
  console.error('hard time limit reached; stopping')
  process.exit(3)
}, HARD_LIMIT_MS)

try {
  if (ONLY === 'all' || ONLY === 'k1') {
    await k1({ name: 'danger', sandbox: 'danger-full-access' })
    await k1({ name: 'fallback', sandbox: 'workspace-write' })
  }
  if (ONLY === 'all' || ONLY === 'k2') await k2()
} finally {
  clearTimeout(watchdog)
  mkdirSync(OUT, { recursive: true })
  for (const r of recorded) {
    writeFileSync(join(OUT, r.file), r.wire.map((l) => scrub(JSON.stringify(l))).join('\n') + '\n')
  }
  writeFileSync(
    join(OUT, 'provider-requests.json'),
    scrub(JSON.stringify(providerLog, null, 2)) + '\n'
  )
  writeFileSync(join(OUT, 'results.json'), scrub(JSON.stringify(results, null, 2)) + '\n')
  writeFileSync(
    join(OUT, 'cli-version.txt'),
    execFileSync(CODEX_BIN, ['--version'], { encoding: 'utf8' })
  )
  providerServer.close()
  for (const r of recorded) console.log(`${r.file}: app-server pid ${r.pid} stopped`)
  console.log(scrub(JSON.stringify(results, null, 2)))
  rmSync(root, { recursive: true, force: true })
}
process.exit(0)
