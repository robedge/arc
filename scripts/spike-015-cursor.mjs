// Dev-only (never built or shipped): spikes K3 and K4 of spec 015 (Skip all approvals), real Cursor
// turns over `agent acp` on the logged-in Free tier with model Auto. It makes real model calls, so it
// refuses to run without --confirm-real-run, and each scenario is meant to be run ONCE.
//
//   node scripts/spike-015-cursor.mjs --confirm-real-run --scenario k3 [--dry-run]
//   node scripts/spike-015-cursor.mjs --confirm-real-run --scenario k4 [--dry-run]
//
// Everything happens in throwaway directories (mktemp) holding scratch git repos; the only push goes
// to a local bare repository in the same temp root. ~/.cursor is never written by this script
// (Cursor keeps its own session files there). The user's own cli-config is NOT edited: the "allow"
// question in K4 uses a PROJECT-level `.cursor/cli.json` in the scratch repo.
//
// K3: ONE process, TWO prompts. `.cursor/cli.json` holds `Write(<other>/**)` as a deny for prompt 1,
//     is rewritten without it, and prompt 2 asks for the same kind of write. Is the deny re-read?
// K4: process A, no `Shell(git push)` deny: does `git push` ask over ACP? Answer `reject_once`, record
//     what the agent says. Process B (fresh, so the answer does not depend on K3): the project
//     `.cursor/cli.json` allows `Shell(git push)`: does the ask go away?
import { spawn, execFileSync } from 'node:child_process'
import os from 'node:os'
import { join, resolve } from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync, existsSync } from 'node:fs'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(name)
  return i === -1 ? fallback : (args[i + 1] ?? fallback)
}
if (!args.includes('--confirm-real-run')) {
  console.error('This makes real Cursor model calls. Re-run with --confirm-real-run.')
  process.exit(2)
}
const SCENARIO = flag('--scenario', '')
if (!['k3', 'k4'].includes(SCENARIO)) {
  console.error('--scenario k3 or k4 is required')
  process.exit(2)
}
const DRY_RUN = args.includes('--dry-run')
const BIN = flag('--agent-bin', join(os.homedir(), '.local', 'bin', 'cursor-agent'))
const MODEL = flag('--model', 'default[]') // Auto
const OUT = resolve(
  flag('--out', `tests/fixtures/cursor/2026.11.13-eacade1/skip-approvals/${SCENARIO}.jsonl`)
)
const PROMPT_TIMEOUT_MS = 150_000
const HARD_LIMIT_MS = 9 * 60_000
const MAX_AGENT_REQUESTS = 20

const root = realpathSync(mkdtempSync(join(os.tmpdir(), `arc-spike015-${SCENARIO}-`)))
const wire = []
const t0 = Date.now()
const pids = []
let child
let proc
let nextId = 0
const pending = new Map()
let permissionPolicy = 'reject'
let agentRequestCount = 0

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms))
function git(cwd, ...a) {
  return execFileSync('git', a, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}
function note(text) {
  wire.push({ dir: 'note', t: Date.now() - t0, ...(proc ? { proc } : {}), note: text })
}
function log(dir, msg) {
  wire.push({ dir, t: Date.now() - t0, ...(proc ? { proc } : {}), msg })
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

/** Answers a permission request by kind, never by option id text. Every request is noted. */
function onPermission(msg) {
  const options = msg.params?.options ?? []
  const want = permissionPolicy === 'allow' ? 'allow_once' : 'reject_once'
  const option = options.find((o) => o.kind === want)
  note(
    `permission request (${msg.params?.toolCall?.title ?? '?'}); answered ${option ? want : 'cancelled'}`
  )
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
    if (agentRequestCount > MAX_AGENT_REQUESTS) {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'spike limit' } })
    } else if (msg.method === 'session/request_permission') {
      onPermission(msg)
    } else {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } })
    }
  } else if (msg.id !== undefined && pending.has(msg.id)) {
    pending.get(msg.id)(msg)
    pending.delete(msg.id)
  }
}

function spawnAgent(cwd) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('CURSOR_'))
  )
  child = spawn(BIN, ['acp'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
  pids.push(child.pid)
  console.log(`agent acp pid ${child.pid}${proc ? ` (process ${proc})` : ''}`)
  let buf = ''
  child.stdout.on('data', (d) => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      onLine(buf.slice(0, i))
      buf = buf.slice(i + 1)
    }
  })
  const mine = child
  mine.on('exit', (code, signal) => {
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
}

/** Stops the current process and the `worker-server` child Cursor leaves behind. */
async function stopAgent() {
  const mine = child
  if (!mine) return
  let kids = []
  try {
    kids = execFileSync('pgrep', ['-P', String(mine.pid)], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
      .map(Number)
  } catch {
    // no children
  }
  const exited = new Promise((ok) => mine.once('exit', ok))
  try {
    mine.stdin.end()
  } catch {
    // closed already
  }
  const clean = await Promise.race([exited.then(() => true), sleep(6000).then(() => false)])
  if (!clean) {
    mine.kill('SIGTERM')
    await Promise.race([exited, sleep(3000)])
  }
  for (const pid of kids) {
    try {
      process.kill(pid, 'SIGTERM')
      pids.push(pid)
    } catch {
      // already gone
    }
  }
}

async function handshake() {
  const init = await request('initialize', {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }
  })
  if (!init.result) throw new Error(`initialize failed: ${JSON.stringify(init.error)}`)
  const auth = await request('authenticate', { methodId: 'cursor_login' })
  if (auth.error) throw new Error(`authenticate failed: ${JSON.stringify(auth.error)}`)
}

async function newSession(cwd) {
  const created = await request('session/new', { cwd, mcpServers: [] })
  if (!created.result?.sessionId)
    throw new Error(`session/new failed: ${JSON.stringify(created.error)}`)
  const sessionId = created.result.sessionId
  const ids = (created.result.models?.availableModels ?? []).map((m) => m.modelId)
  if (!ids.includes(MODEL)) throw new Error(`model ${MODEL} is not offered; no model call made`)
  const set = await request('session/set_model', { sessionId, modelId: MODEL })
  if (set.error) throw new Error(`session/set_model failed: ${JSON.stringify(set.error)}`)
  return sessionId
}

/** One real prompt. Returns the stop reason, the agent's text and the tool calls seen in it. */
async function prompt(sessionId, text, label) {
  const from = wire.length
  note(`PROMPT ${label}: ${text}`)
  console.log(`sending real prompt: ${label}`)
  const r = await request(
    'session/prompt',
    { sessionId, prompt: [{ type: 'text', text }] },
    PROMPT_TIMEOUT_MS
  )
  await sleep(1500) // trailing notifications
  const updates = wire.slice(from).filter((w) => w.dir === 's2c' && w.msg?.params?.update)
  const tools = new Map()
  for (const w of updates) {
    const u = w.msg.params.update
    if (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') {
      const cur = tools.get(u.toolCallId) ?? {}
      tools.set(u.toolCallId, {
        ...cur,
        title: u.title ?? cur.title,
        kind: u.kind ?? cur.kind,
        status: u.status ?? cur.status,
        rawInput: u.rawInput ?? cur.rawInput,
        rawOutput: u.rawOutput ?? cur.rawOutput
      })
    }
  }
  const reply = updates
    .filter((w) => w.msg.params.update.sessionUpdate === 'agent_message_chunk')
    .map((w) => w.msg.params.update.content?.text ?? '')
    .join('')
  const permissions = wire
    .slice(from)
    .filter((w) => w.dir === 's2c' && w.msg?.method === 'session/request_permission')
    .map((w) => w.msg.params?.toolCall?.title ?? '?')
  const out = {
    label,
    stop: r.result ?? r.error,
    reply,
    permissionRequests: permissions,
    toolCalls: [...tools.values()]
  }
  note(`RESULT ${label}: ${JSON.stringify(out)}`)
  return out
}

function writeCli(repo, permissions) {
  writeFileSync(join(repo, '.cursor', 'cli.json'), JSON.stringify({ permissions }, null, 2))
  note(`cli.json now: ${JSON.stringify({ permissions })}`)
}

function scratchRepo(name) {
  const repo = join(root, name)
  mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 'spike@example.com')
  git(repo, 'config', 'user.name', 'Spike')
  writeFileSync(join(repo, 'README.md'), '# Scratch\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'init')
  mkdirSync(join(repo, '.cursor'))
  return repo
}

// ---- scrubbing ----
function scrubAll() {
  const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const home = os.homedir()
  const user = os.userInfo().username
  const ids = new Map()
  const sessionIds = new Set()
  const callIds = new Set()
  for (const e of wire) {
    const m = e.msg
    if (!m) continue
    if (m.result?.sessionId) sessionIds.add(m.result.sessionId)
    if (m.params?.sessionId) sessionIds.add(m.params.sessionId)
    const c = m.params?.toolCall?.toolCallId ?? m.params?.update?.toolCallId
    if (c) callIds.add(c)
  }
  const idFor = (v, p) =>
    ids.has(v) ? ids.get(v) : (ids.set(v, `${p}-${ids.size + 1}`), ids.get(v))
  const rules = [
    [new RegExp(esc(root), 'g'), '<TMP>'],
    [new RegExp(esc(root.replace(/^\/private/, '')), 'g'), '<TMP>'],
    [new RegExp(esc(home), 'g'), '/Users/user'],
    [new RegExp(esc(os.hostname()), 'g'), '<HOST>'],
    [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, 'user@example.com'],
    [/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/g, 'Bearer <REDACTED>'],
    [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_.-]+/g, '<JWT>'],
    [/\b(?:sk|key|crsr)[-_][A-Za-z0-9_-]{16,}/g, '<API_KEY>'],
    [new RegExp(`\\b${esc(user)}\\b`, 'g'), 'user']
  ]
  const secretKeys = /^(email|userId|authId|displayName)$/i
  const apply = (s) => {
    let out = s
    for (const id of sessionIds) out = out.split(id).join(idFor(id, 'session'))
    for (const id of callIds) out = out.split(id).join(idFor(id, 'toolcall'))
    for (const [re, to] of rules) out = out.replace(re, to)
    return out
  }
  const walk = (v, key) => {
    if (typeof v === 'string') {
      if (key && secretKeys.test(key))
        return key.toLowerCase() === 'email' ? 'user@example.com' : `<${key.toUpperCase()}>`
      return apply(v)
    }
    if (Array.isArray(v)) return v.map((x) => walk(x))
    if (v && typeof v === 'object')
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]))
    return v
  }
  // The user's own command and skill list is personal: keep the shape, keep three entries.
  const trim = (entry) => {
    const u = entry.msg?.params?.update
    if (u?.sessionUpdate !== 'available_commands_update') return entry
    return {
      ...entry,
      msg: {
        ...entry.msg,
        params: {
          ...entry.msg.params,
          update: {
            ...u,
            availableCommands: u.availableCommands.slice(0, 3),
            recorderNote: `trimmed from ${u.availableCommands.length} entries`
          }
        }
      }
    }
  }
  return wire.map((e) => walk(trim(e)))
}

// ---- scenarios ----
const results = {}

async function runK3() {
  const repo = scratchRepo('k3-repo')
  const other = join(root, 'k3-other')
  mkdirSync(other)
  writeCli(repo, { allow: [], deny: [`Write(${other}/**)`] })
  proc = 'A'
  spawnAgent(repo)
  await handshake()
  const sessionId = await newSession(repo)
  if (DRY_RUN) {
    console.log('dry run: no prompt sent')
    return
  }
  permissionPolicy = 'reject' // anything Cursor asks about is declined, so only the edit tool can write
  const ask = (n) =>
    `This is a test harness. Use ONLY your file edit/write tool (not the shell) to create the file ${other}/p${n}.txt containing the single line: ${n}. If the tool refuses or fails, quote the error in one short line and do nothing else. Otherwise reply with the single word: done.`
  results.prompt1 = await prompt(sessionId, ask(1), 'K3 prompt 1 (deny present)')
  results.p1Exists = existsSync(join(other, 'p1.txt'))
  writeCli(repo, { allow: [], deny: [] })
  results.prompt2 = await prompt(
    sessionId,
    ask(2),
    'K3 prompt 2 (deny removed, same process and session)'
  )
  results.p2Exists = existsSync(join(other, 'p2.txt'))
  note(`files: p1.txt exists=${results.p1Exists}, p2.txt exists=${results.p2Exists}`)
}

async function runK4() {
  const remote = join(root, 'k4-remote.git')
  git(root, 'init', '--bare', '-q', remote)
  const pushPrompt = (branch) =>
    `This is a test harness. Run exactly this one shell command and nothing else: git push origin HEAD:refs/heads/${branch} . Do not retry or try another way if it is refused or fails. Then say in one short sentence exactly what happened, quoting any refusal or error text you were given.`

  // A: no Shell(git push) deny, nothing allowed: does the push ask? Answer reject_once.
  const repoA = scratchRepo('k4-repo-a')
  git(repoA, 'remote', 'add', 'origin', remote)
  writeCli(repoA, { allow: [], deny: [] })
  proc = 'A'
  spawnAgent(repoA)
  await handshake()
  const sessionA = await newSession(repoA)
  if (DRY_RUN) {
    console.log('dry run: no prompt sent')
    return
  }
  permissionPolicy = 'reject'
  results.promptA = await prompt(
    sessionA,
    pushPrompt('k4-a'),
    'K4 A (no deny, no allow; reject_once)'
  )
  results.remoteAfterA = git(root, '--git-dir', remote, 'branch', '--list')
    .split('\n')
    .map((s) => s.trim())
  await stopAgent()

  // B: fresh process, project allow for Shell(git push): does the ask go away? Rejections still answered
  // reject_once, so if it asks, nothing is pushed by the ask path.
  const repoB = scratchRepo('k4-repo-b')
  git(repoB, 'remote', 'add', 'origin', remote)
  writeCli(repoB, { allow: ['Shell(git push)'], deny: [] })
  proc = 'B'
  note('process B start')
  spawnAgent(repoB)
  await handshake()
  const sessionB = await newSession(repoB)
  permissionPolicy = 'reject'
  results.promptB = await prompt(
    sessionB,
    pushPrompt('k4-b'),
    'K4 B (project allow Shell(git push); reject_once if asked)'
  )
  results.remoteAfterB = git(root, '--git-dir', remote, 'branch', '--list')
    .split('\n')
    .map((s) => s.trim())
}

const watchdog = setTimeout(async () => {
  console.error('hard time limit reached; stopping')
  await stopAgent()
  process.exit(3)
}, HARD_LIMIT_MS)

try {
  if (SCENARIO === 'k3') await runK3()
  else await runK4()
} catch (error) {
  note(`ABORT: ${error.message}`)
  console.error(error.message)
} finally {
  clearTimeout(watchdog)
  await stopAgent()
  await sleep(500)
  note(`SUMMARY: ${JSON.stringify(results)}`)
  mkdirSync(resolve(OUT, '..'), { recursive: true })
  const lines = scrubAll()
  writeFileSync(OUT, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  console.log(JSON.stringify(results, null, 2).split(root).join('<TMP>'))
  console.log(`stopped pids: ${pids.join(', ')}`)
  rmSync(root, { recursive: true, force: true })
}
process.exit(0)
