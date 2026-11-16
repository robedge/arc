// Dev-only (never built or shipped): spike K5 of spec 015 (Skip all approvals), a real Claude turn
// on the logged-in subscription with the lightest model (haiku) and tiny prompts. It makes real model
// calls, so it refuses to run without --confirm-real-run, and it is meant to be run ONCE.
//
//   node scripts/spike-015-claude.mjs --confirm-real-run [--dry-run]
//
// K5: a worker relaunched with `--resume` WITHOUT the `Edit(//<dir>/**)` deny rules, under
// `--permission-mode acceptEdits` with `--add-dir <other>`: does an Edit into the added folder go
// through without a permission prompt?
//   Process 1 (creates the session): the worker args as Arc builds them today, deny rules included,
//     one tiny turn ("Reply with the single word: ok").
//   Process 2 (`--resume <id>`): the same args minus the deny rules; a turn that reads and edits
//     <other>/notes.txt with the Edit tool. No `--permission-prompt-tool`: in -p mode a tool that
//     needs a prompt is refused and listed in the result event's `permission_denials`.
// Everything happens in a throwaway directory; no repository other than a scratch one is touched.
// Claude Code keeps its own session transcript under ~/.claude/projects/ for the scratch folder
// (this script writes nothing there itself).
import { spawn } from 'node:child_process'
import os from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync } from 'node:fs'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(name)
  return i === -1 ? fallback : (args[i + 1] ?? fallback)
}
if (!args.includes('--confirm-real-run')) {
  console.error('This makes real Claude model calls. Re-run with --confirm-real-run.')
  process.exit(2)
}
const DRY_RUN = args.includes('--dry-run')
const CLAUDE_BIN = flag('--claude-bin', 'claude')
const OUT = resolve(flag('--out', 'tests/fixtures/claude/skip-approvals'))
const TURN_TIMEOUT_MS = 120_000
const root = realpathSync(mkdtempSync(join(os.tmpdir(), 'arc-spike015-k5-')))
const work = join(root, 'work')
const other = join(root, 'other')
mkdirSync(work)
mkdirSync(other)
writeFileSync(join(other, 'notes.txt'), 'status: old\n')
const sessionId = randomUUID()
const pids = []
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms))

// The worker args from buildClaudeArgs (src/main/agents/claude/claude-adapter.ts), minus the MCP bridge,
// the hooks file and the prompt tool.
function workerArgs({ deny, resume }) {
  const a = [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--replay-user-messages',
    '--model',
    'haiku',
    '--setting-sources',
    'project',
    '--add-dir',
    other
  ]
  a.push(...(resume ? ['--resume', sessionId] : ['--session-id', sessionId]))
  a.push('--permission-mode', 'acceptEdits', '--allowedTools', 'Read', 'Grep', 'Glob')
  if (deny) {
    a.push(
      '--disallowedTools',
      ...['Edit', 'Write', 'NotebookEdit'].map((tool) => `${tool}(/${other}/**)`)
    )
  }
  return a
}

function runProcess(label, argv, promptText) {
  return new Promise((ok) => {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([k]) => !/^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDECODE|CLAUDE_CODE_)/.test(k)
      )
    )
    const child = spawn(CLAUDE_BIN, argv, { cwd: work, env, stdio: ['pipe', 'pipe', 'pipe'] })
    pids.push(child.pid)
    console.log(`${label}: claude pid ${child.pid}`)
    const events = []
    let stderr = ''
    let buf = ''
    let resultSeen = false
    child.stderr.on('data', (d) => (stderr += d))
    child.stdout.on('data', (d) => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        if (!line.trim()) continue
        try {
          const ev = JSON.parse(line)
          events.push(ev)
          if (ev.type === 'result' && !resultSeen) {
            resultSeen = true
            child.stdin.end()
          }
        } catch {
          events.push({ type: 'raw', line })
        }
      }
    })
    const stdinLine = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: promptText }] }
    }
    child.stdin.write(`${JSON.stringify(stdinLine)}\n`)
    const timer = setTimeout(() => {
      console.error(`${label}: no result within ${TURN_TIMEOUT_MS} ms; stopping`)
      child.kill('SIGTERM')
    }, TURN_TIMEOUT_MS)
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      ok({ label, argv, stdin: stdinLine, events, stderr, code, signal })
    })
  })
}

// ---- scrubbing ----
function scrub(value) {
  const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const user = os.userInfo().username
  const rules = [
    [/-private-var-folders-[A-Za-z0-9-]*-T-arc-spike015-k5-[A-Za-z0-9]+/g, '<SCRATCH-SLUG>'],
    [new RegExp(esc(root), 'g'), '<TMP>'],
    [new RegExp(esc(root.replace(/^\/private/, '')), 'g'), '<TMP>'],
    [new RegExp(esc(sessionId), 'g'), '<SESSION>'],
    [new RegExp(esc(os.homedir()), 'g'), '/Users/<user>'],
    [new RegExp(esc(os.hostname()), 'g'), '<HOST>'],
    [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, 'user@example.com'],
    [/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/g, 'Bearer <REDACTED>'],
    [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_.-]+/g, '<JWT>'],
    [/\bsk-[A-Za-z0-9_-]{8,}/g, '<API_KEY>'],
    [new RegExp(`\\b${esc(user)}\\b`, 'g'), '<user>']
  ]
  const secretKeys =
    /^(email|accountId|organizationId|orgId|userId|credential_expires_at|messaging_socket_path|apiKeySource|organization|account)$/i
  const walk = (v, key) => {
    if (typeof v === 'string') {
      if (key && secretKeys.test(key)) return `<${key.toUpperCase()}>`
      let out = v
      for (const [re, to] of rules) out = out.replace(re, to)
      return out
    }
    if (Array.isArray(v)) return v.map((x) => walk(x))
    if (v && typeof v === 'object')
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]))
    return v
  }
  return walk(value)
}

/** The init event lists the user's own skills, plugins, agents and MCP servers: keep counts, not names. */
function trimInit(ev) {
  if (ev.type !== 'system' || ev.subtype !== 'init') return ev
  const out = { ...ev }
  for (const key of [
    'skills',
    'plugins',
    'slash_commands',
    'agents',
    'mcp_servers',
    'memory_paths'
  ]) {
    if (Array.isArray(out[key])) out[key] = `<${out[key].length} entries omitted>`
  }
  return out
}

function brief(events) {
  const tools = []
  for (const ev of events) {
    const blocks = ev.message?.content
    if (!Array.isArray(blocks)) continue
    for (const b of blocks) {
      if (b.type === 'tool_use') tools.push({ id: b.id, tool: b.name, input: b.input })
      if (b.type === 'tool_result') {
        const t = tools.find((x) => x.id === b.tool_use_id)
        if (t)
          t.result = {
            isError: b.is_error === true,
            content: typeof b.content === 'string' ? b.content : JSON.stringify(b.content)
          }
      }
    }
  }
  const result = events.find((e) => e.type === 'result')
  const init = events.find((e) => e.type === 'system' && e.subtype === 'init')
  return {
    permissionMode: init?.permissionMode,
    additionalDirectories: init?.additional_directories,
    tools,
    resultSubtype: result?.subtype,
    isError: result?.is_error,
    resultText: result?.result,
    permissionDenials: result?.permission_denials,
    numTurns: result?.num_turns,
    sessionIdMatches: init?.session_id === sessionId
  }
}

const results = {}
try {
  const first = await runProcess(
    'process 1 (create)',
    workerArgs({ deny: true, resume: false }),
    DRY_RUN ? 'Reply with the single word: ok' : 'Reply with the single word: ok'
  )
  results.create = brief(first.events)
  results.createExit = { code: first.code, stderr: first.stderr.slice(0, 500) }
  let second
  if (DRY_RUN) {
    console.log('dry run: process 1 only (one tiny turn), no resume')
  } else {
    await sleep(1000)
    second = await runProcess(
      'process 2 (resume, no deny rules)',
      workerArgs({ deny: false, resume: true }),
      `This is a test harness. Use the Read tool to read ${other}/notes.txt, then use the Edit tool (not Bash, not Write) to change the word old to new in that file. Then reply with the single word: done.`
    )
    results.resume = brief(second.events)
    results.resumeExit = { code: second.code, stderr: second.stderr.slice(0, 500) }
    results.notesAfter = readFileSync(join(other, 'notes.txt'), 'utf8')
  }
  mkdirSync(OUT, { recursive: true })
  const dump = (name, run) => {
    if (!run) return
    writeFileSync(
      join(OUT, name),
      [
        JSON.stringify(scrub({ dir: 'argv', argv: run.argv })),
        JSON.stringify(scrub({ dir: 'stdin', line: run.stdin })),
        ...run.events.map((e) => JSON.stringify(scrub({ dir: 'stdout', ev: trimInit(e) })))
      ].join('\n') + '\n'
    )
  }
  dump('k5-process1-create.jsonl', first)
  dump('k5-process2-resume.jsonl', second)
  writeFileSync(join(OUT, 'k5-summary.json'), JSON.stringify(scrub(results), null, 2) + '\n')
  console.log(JSON.stringify(scrub(results), null, 2))
  console.log(`stopped pids (each exited): ${pids.join(', ')}`)
} finally {
  rmSync(root, { recursive: true, force: true })
}
process.exit(0)
