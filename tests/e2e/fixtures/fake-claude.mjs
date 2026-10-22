#!/usr/bin/env node
// Stand-in for the `claude` CLI, used by e2e and unit/integration tests. No model call is made.
//
// Modes (decided from argv):
//   --version              prints the version line the real CLI prints (`<FAKE_CLAUDE_VERSION> (Claude Code)`,
//                          default 2.1.302; FAKE_CLAUDE_VERSION_FILE, when the file exists, overrides it).
//   auth status [--json]   prints the login state; FAKE_CLAUDE_AUTH=ok (default) | out.
//   plugin list --json     prints the file named by FAKE_CLAUDE_PLUGINS_JSON (default []).
//   plugin install|update|uninstall <id> ... / plugin marketplace update
//                          change the FAKE_CLAUDE_PLUGINS_JSON file (an install adds an entry and writes a plugin
//                          folder under FAKE_CLAUDE_PLUGIN_CACHE with one command `hello`; an update raises the
//                          patch version; an uninstall removes the entry) and print a JSON success line.
//                          FAKE_CLAUDE_PLUGIN_FAIL=<message> makes them fail (JSON error on stdout, exit 1);
//                          FAKE_CLAUDE_PLUGIN_DELAY=<ms> waits first.
//   (any run)              a stdin `control_request` with subtype `initialize` is answered at once with
//                          a fake system/hook_started line (like a repository SessionStart hook) and a
//                          control_response whose `commands` come from FAKE_CLAUDE_COMMANDS_JSON.
//   (any run)              a stdin `control_request` with subtype `mcp_status` is answered like the real CLI does
//                          (spike S8): each stdio server of --mcp-config is started, its `tools/list` read, and
//                          `{mcpServers:[{name,status,tools:[{name,annotations:{readOnly?,destructive?,openWorld?}}]}]}`
//                          returned. A hint is written only when it is true. A server that cannot be started has
//                          status `failed` and no tools; a url server (`arc`) is `connected` with no tools.
//                          FAKE_CLAUDE_MCP_STATUS=fail answers with an error instead; `hang` never answers.
//   (any run)              the repository's own commands are listed too: every `.claude/commands/**/*.md` under the cwd
//                          (nested folders become `folder:name`, the description gets the " (project)" suffix),
//                          like the real CLI lists them.
//   FAKE_CLAUDE_RUN_HOOKS=1  after each {"shell"} step the fake plays the PostToolUse hooks the real CLI would load for
//                          its flags: the user's `$HOME/.claude/settings.json` only when --setting-sources names
//                          `user`, the cwd's `.claude/settings.json` (project), the file named by --settings, and
//                          `hooks/hooks.json` of every plugin folder under --plugin-dir. Each hook command runs with `sh -c`. This stands in for the
//                          real CLI's hook loading (verified by spikes S1 and S2), so a test can assert that a
//                          personal hook did not run.
//   plan check             `--system-prompt "."` together with `--tools ""` (the launch plan check of spec 008): logs
//                          {"argv"}, then writes an assistant line, a rate_limit_event (FAKE_CLAUDE_RATE_LIMIT, else
//                          five_hour 0.05 / seven_day 0.28) and a `result` with usage (like plan-check.jsonl) and exits 0.
//                          FAKE_CLAUDE_PLAN_CHECK=fail exits 1 with no output; `hang` never answers.
//   (session run)          argv assertion: the flags must keep the personal configuration safe (spec 007
//                          section 2.6). `--setting-sources`, if given, is exactly `project`; `--settings`, if
//                          given, names a JSON file whose only key is `hooks`; `--mcp-config` always comes with
//                          `--strict-mcp-config`. A violation is logged as {"argvViolation":[...]}, written to
//                          stderr and ends the run with exit code 2. With ARC_AGENT set, the run also logs
//                          {"arcEnv":{ARC_AGENT,ARC_AGENT_ROLE,ARC_PROVIDER}}.
//   (any run)              the first stdin user message that starts with "/" is echoed at once as a
//                          replayed user event `<command-message>x</command-message>\n<command-name>/x</command-name>
//                          <command-args>…</command-args>`, like the real CLI expanding a command.
//   anything else          a session run: replays a scenario script (see below).
//
// Environment:
//   FAKE_CLAUDE_AUTH        ok | out. Picks the `auth status` answer.
//   FAKE_CLAUDE_COMMANDS_JSON  Path to a JSON array of {name, description, argumentHint?, builtin?} for
//                           `initialize`. Default: one built-in (`compact`) and one repository command
//                           (`awos:spec`, description ending in " (project)").
//   FAKE_CLAUDE_SCRIPT      Path to the NDJSON scenario for a session run.
//   FAKE_CLAUDE_SCRIPT_DIR  If set, `<dir>/<role>.jsonl` wins over FAKE_CLAUDE_SCRIPT when it exists.
//                           The role is FAKE_CLAUDE_ROLE, else the marker `[arc-role:<role>]` found in
//                           the value of `--append-system-prompt`. A worker also tries
//                           `<dir>/worker-<slug>.jsonl` first, with the slug from `[arc-worker:<slug>]`.
//                           A brain started with `--resume` tries `<dir>/brain-resumed-<n>.jsonl` first (n = 1 for
//                           the first resumed brain run in FAKE_CLAUDE_LOG, 2 for the next, and so on), then
//                           `<dir>/brain-resumed.jsonl`, so a restarted brain can behave differently from the first run.
//   FAKE_CLAUDE_RATE_LIMIT  JSON object of plan windows, e.g. '{"five_hour":0.79,"seven_day":0.18}' (key -> utilization
//                           fraction, or {utilization, resetsAt}). Every `result` step is then preceded by a
//                           `rate_limit_event` with `unifiedWindows`, like the real CLI (plan-check.jsonl). A JSON
//                           array of such objects is consumed one per turn of the process (the last one repeats), so a
//                           run can show the numbers rise. The key "status" (e.g. "rejected") sets the event status.
//   FAKE_CLAUDE_RATE_LIMIT_FILE  Path to a file holding the same JSON; when it exists it wins over the variable and is read
//                           on every turn, so a test can change the numbers between turns and across processes.
//   FAKE_CLAUDE_SETUP_PER_ITEM  Tokens of fixed setup each loaded item adds to the first request of a new process (spec 009):
//                           the servers of --mcp-config other than `arc`, the plugin folders of --plugin-dir (the
//                           `user` wrapper not counted) and its user skills. Stands in for the real CLI's growing system prompt, so a test
//                           can see the measured fixed setup fall when the user switches things off. Default 0.
//   FAKE_CLAUDE_LOG         If set, appends one JSON record per line: {"argv":[...]} once at start,
//                           then {"stdin":<parsed JSON, or the raw string if not JSON>} per stdin line.
//
// Scenario lines (one JSON object per line; blank lines and lines starting with # are ignored):
//   {"delay":ms}                    sleep.
//   {"emit":{...}}                  write the object as one stdout JSON line; {"emit":{...},"delay":ms}
//                                   sleeps first. `{{SESSION_ID}}` inside any string is replaced with the
//                                   session id (from --session-id / --resume, else one uuid per run).
//   {"waitForStdin":"text"}         block until a not-yet-consumed stdin line contains "text" ("*" = any
//                                   line). Stdin lines are stream-json user messages or control_requests.
//   {"stderr":"text"}               write text to stderr.
//   {"exit":code}                   exit with that code now.
//   {"hang":true}                   stay alive until killed or stdin closes (then exit 0).
//   {"init":true}                   emit a system/init line ("model":"..." and "mcp":true are optional;
//                                   "mcp":true lists the `arc` server as connected).
//   {"say":"text"}                  emit an assistant text message (one line, like the real CLI).
//   {"rateLimit":{"five_hour":0.5}} emit a `rate_limit_event` with those windows now (same shape as FAKE_CLAUDE_RATE_LIMIT).
//   {"result":true}                 emit a successful `result` line, which ends the turn
//                                   ({"result":"error"} ends it with is_error:true).
//   {"shell":"cmd"}                 run `cmd` with `sh -c` in the current directory and wait. The output is
//                                   written to the log as {"shell":{cmd,code,out}}. A non-zero code does not end the run.
//   {"mcp":{"tool":"x","args":{}}}  call the bridge tool `x` (the MCP server in the --mcp-config file this
//                                   process was given: stateless streamable HTTP, initialize first, then
//                                   tools/call) and emit the assistant tool_use and user tool_result lines the
//                                   real CLI would print. The result is logged as {"mcpResult":{tool,isError,text}}.
//                                   With "saveAs":"k" the call runs in the background; the step returns at once.
//   {"waitForMcpResult":"k"}        wait for a call saved as "k".
//   {"personalTool":{"server":"s","tool":"t","input":{...}}}
//                                   a call of the user's own MCP tool, the way the real CLI runs one that is not on
//                                   --allowedTools: the tool is `mcp__s__t`, and the call goes through the permission
//                                   tool exactly as a "tool" step does. The server must be in the --mcp-config file
//                                   (the merged one holds arc, the user's, the plugins' and the repository's servers),
//                                   otherwise the call fails with "server not configured". Logged as
//                                   {"personalMcp":{server,tool,configured}} before the permission round trip.
//   {"tool":{"name":"Bash","input":{...}}}
//                                   a tool call that needs a permission, the way the real CLI runs it with
//                                   `--permission-prompt-tool mcp__arc__request_permission`: emit the tool_use
//                                   line, call the bridge tool request_permission with
//                                   {tool_name, input, tool_use_id}, then emit the tool_result the CLI would:
//                                   success for {behavior:"allow"} ("(fake) ran: <command>"), is_error with the
//                                   message for {behavior:"deny"}. Logged as {"permission":{tool_name,input,
//                                   behavior,message}}.
//                                   With name "AskUserQuestion" (input {questions:[...]}), the tool_result text is
//                                   the CLI's "Your questions have been answered: ..." (or the deny message), and an
//                                   assistant message follows: "AskUserQuestion answers: <JSON of updatedInput.answers>"
//                                   or "AskUserQuestion declined: <message>". The worker waits on the user meanwhile.
//
//
//   Background helper agents (spike S1 Q5: the real CLI runs subagents in the background, emits its FIRST
//   `result` while they run, then a task_notification, a second turn and a second `result`):
//   {"taskStart":{"id":"h1","description":"Check types"}}
//                                   emit an assistant `Agent` tool_use, system/background_tasks_changed (with
//                                   the helpers now running), system/task_started and the "Async agent
//                                   launched" tool_result, in the order the real CLI writes them.
//   {"taskSay":{"id":"h1","text":"..."}}
//                                   an assistant text event with parent_tool_use_id = the helper's Agent call.
//   {"taskTool":{"id":"h1","name":"Bash","input":{...},"permission":true}}
//                                   a helper tool call: an assistant tool_use with parent_tool_use_id, then (with
//                                   "permission":true) the request_permission round trip as for "tool", then
//                                   the tool_result with parent_tool_use_id.
//   {"taskEnd":{"id":"h1","status":"completed","summary":"..."}}
//                                   emit system/task_updated, system/task_notification and
//                                   system/background_tasks_changed (without that helper).
//   A typical script: init, taskStart h1, taskStart h2, say, result (turn 1 ends, helpers run), taskEnd h1,
//   taskEnd h2, say, result (the follow-up turn). Combine with {"waitForStdin"} and {"delay"} as needed.
//
// `{{REQUEST_ID}}` inside "mcp" args is replaced with the id in the last consumed stdin line that has
// "(request <id>)", which is how Arc's notes name an attention request.
//   {"exitIfMcpError":code}         with a "mcp" step (not saved): exit with that code when the tool returned an error.
//
// A stdin `control_request` with subtype `interrupt` is answered the moment it arrives (even during a
// delay, wait or hang), as the real CLI does (tests/fixtures/claude/2.1.302/interrupt.jsonl): a
// control_response success, an "[Request interrupted by user]" user event, then an
// error_during_execution result with terminal_reason aborted_streaming. The script then continues.
//
// When the script ends the process stays alive until stdin closes, then exits 0 (like the real CLI).
//
import {
  appendFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'

const argv = process.argv.slice(2)
const env = process.env
// FAKE_CLAUDE_VERSION sets the version; FAKE_CLAUDE_VERSION_FILE names a file read on every run, so a
// test can "update" the tool while Arc runs.
const VERSION = (() => {
  const file = env.FAKE_CLAUDE_VERSION_FILE
  if (file && existsSync(file)) return readFileSync(file, 'utf8').trim()
  return env.FAKE_CLAUDE_VERSION ?? '2.1.302'
})()
const VERSION_LINE = `${VERSION} (Claude Code)`

function log(record) {
  if (!env.FAKE_CLAUDE_LOG) return
  appendFileSync(env.FAKE_CLAUDE_LOG, JSON.stringify(record) + '\n')
}

function flagValue(name) {
  const i = argv.indexOf(name)
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1]
  const prefixed = argv.find((a) => a.startsWith(name + '='))
  return prefixed ? prefixed.slice(name.length + 1) : undefined
}

function write(stream, text) {
  return new Promise((resolve) => stream.write(text, () => resolve()))
}

async function exitNow(code) {
  await write(process.stdout, '')
  await write(process.stderr, '')
  process.exit(code)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

if (argv.includes('--version') || argv.includes('-v')) {
  log({ argv })
  await write(process.stdout, VERSION_LINE + '\n')
  await exitNow(0)
}

if (argv[0] === 'auth' && argv[1] === 'status') {
  log({ argv })
  const out = env.FAKE_CLAUDE_AUTH === 'out'
  const body = out
    ? { loggedIn: false, authMethod: 'none' }
    : {
        loggedIn: true,
        authMethod: 'claude.ai',
        apiProvider: 'firstParty',
        email: 'fake@example.com',
        subscriptionType: 'max'
      }
  await write(process.stdout, JSON.stringify(body) + '\n')
  await exitNow(0)
}

if (argv[0] === 'plugin' && argv[1] === 'list') {
  log({ argv })
  // FAKE_CLAUDE_PLUGINS_JSON: path to a file holding the list (an array or { installed: [...] }).
  const file = env.FAKE_CLAUDE_PLUGINS_JSON
  const body = file && existsSync(file) ? readFileSync(file, 'utf8') : '[]'
  await write(process.stdout, body.endsWith('\n') ? body : body + '\n')
  await exitNow(0)
}

if (argv[0] === 'plugin' && ['install', 'update', 'uninstall', 'marketplace'].includes(argv[1])) {
  log({ argv })
  if (env.FAKE_CLAUDE_PLUGIN_DELAY) await sleep(Number(env.FAKE_CLAUDE_PLUGIN_DELAY))
  const fail = async (message) => {
    await write(process.stdout, JSON.stringify({ success: false, error: message }) + '\n')
    await exitNow(1)
  }
  if (env.FAKE_CLAUDE_PLUGIN_FAIL) await fail(env.FAKE_CLAUDE_PLUGIN_FAIL)
  const file = env.FAKE_CLAUDE_PLUGINS_JSON
  if (!file) await fail('FAKE_CLAUDE_PLUGINS_JSON is not set')
  const state = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : []
  const wrapped = !Array.isArray(state)
  const entries = wrapped ? (state.installed ?? []) : state
  const save = () => {
    const body = wrapped ? { ...state, installed: entries } : entries
    writeFileSync(file, JSON.stringify(body))
  }
  const subcommand = argv[1]
  if (subcommand === 'marketplace') {
    await write(
      process.stdout,
      JSON.stringify({ success: true, message: 'Marketplaces updated' }) + '\n'
    )
    await exitNow(0)
  }
  const target = argv[2] ?? ''
  const at = target.indexOf('@')
  const name = at === -1 ? target : target.slice(0, at)
  const marketplace = at === -1 ? 'fake-marketplace' : target.slice(at + 1)
  const id = `${name}@${marketplace}`
  const indexOfId = entries.findIndex((e) => e.id === id)
  const now = new Date().toISOString()
  if (subcommand === 'install') {
    if (indexOfId >= 0) await fail(`Plugin "${id}" is already installed`)
    const cache = env.FAKE_CLAUDE_PLUGIN_CACHE ?? join(dirname(file), 'plugin-cache')
    const installPath = join(cache, marketplace, name, '1.0.0')
    mkdirSync(join(installPath, '.claude-plugin'), { recursive: true })
    mkdirSync(join(installPath, 'commands'), { recursive: true })
    writeFileSync(
      join(installPath, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name, version: '1.0.0', description: `The ${name} plugin` })
    )
    writeFileSync(
      join(installPath, 'commands', 'hello.md'),
      `---\ndescription: Says hello from ${name}\n---\nHello.\n`
    )
    entries.push({
      id,
      version: '1.0.0',
      scope: 'user',
      enabled: true,
      installPath,
      lastUpdated: now
    })
    save()
    await write(
      process.stdout,
      JSON.stringify({
        success: true,
        message: `Successfully installed plugin: ${id} (scope: user)`
      }) + '\n'
    )
    await exitNow(0)
  }
  if (indexOfId < 0) await fail(`Plugin "${id}" is not installed`)
  if (subcommand === 'update') {
    const entry = entries[indexOfId]
    const parts = String(entry.version).split('.').map(Number)
    parts[parts.length - 1] = (parts[parts.length - 1] || 0) + 1
    entry.version = parts.join('.')
    entry.lastUpdated = now
    const manifest = join(entry.installPath, '.claude-plugin', 'plugin.json')
    if (existsSync(manifest)) {
      writeFileSync(
        manifest,
        JSON.stringify({ ...JSON.parse(readFileSync(manifest, 'utf8')), version: entry.version })
      )
    }
    save()
    await write(
      process.stdout,
      JSON.stringify({ success: true, message: `Plugin "${id}" updated to ${entry.version}` }) +
        '\n'
    )
    await exitNow(0)
  }
  // uninstall
  entries.splice(indexOfId, 1)
  save()
  await write(
    process.stdout,
    JSON.stringify({ success: true, message: `Successfully uninstalled plugin: ${id}` }) + '\n'
  )
  await exitNow(0)
}

// ---- plan check run (spec 008) ----

log({ argv })

if (flagValue('--system-prompt') === '.' && flagValue('--tools') === '') {
  const check = env.FAKE_CLAUDE_PLAN_CHECK
  if (check === 'hang') await new Promise(() => {})
  if (check === 'fail') {
    await write(process.stderr, 'fake-claude: plan check failed\n')
    await exitNow(1)
  }
  const model = 'claude-haiku-5-5'
  const sid = '00000000-0000-4000-8000-000000000001'
  const usage = {
    input_tokens: 2,
    cache_creation_input_tokens: 582,
    cache_read_input_tokens: 0,
    output_tokens: 159
  }
  const nowSeconds = Math.floor(Date.now() / 1000)
  let windows = { five_hour: 0.05, seven_day: 0.28 }
  const file = env.FAKE_CLAUDE_RATE_LIMIT_FILE
  const raw = file && existsSync(file) ? readFileSync(file, 'utf8') : env.FAKE_CLAUDE_RATE_LIMIT
  if (raw && raw.trim() !== '') {
    const parsed = JSON.parse(raw)
    windows = Array.isArray(parsed) ? parsed[0] : parsed
  }
  const { status = 'allowed', ...rest } = windows
  const defaults = { five_hour: nowSeconds + 5 * 3600, seven_day: nowSeconds + 7 * 86400 }
  const unifiedWindows = {}
  for (const [key, value] of Object.entries(rest)) {
    const w = typeof value === 'number' ? { utilization: value } : value
    unifiedWindows[key] = { resetsAt: defaults[key] ?? nowSeconds + 3600, ...w }
  }
  const first = Object.keys(unifiedWindows)[0] ?? 'five_hour'
  const lines = [
    {
      type: 'assistant',
      message: {
        model,
        id: 'msg_plan_check',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'What would you like help with?' }],
        stop_reason: null,
        usage
      },
      parent_tool_use_id: null,
      session_id: sid,
      uuid: randomUUID()
    },
    {
      type: 'rate_limit_event',
      rate_limit_info: {
        status,
        resetsAt: unifiedWindows[first]?.resetsAt ?? defaults.five_hour,
        rateLimitType: first,
        overageStatus: 'rejected',
        isUsingOverage: false,
        unifiedWindows
      },
      uuid: randomUUID(),
      session_id: sid
    },
    {
      type: 'result',
      subtype: 'success',
      is_error: false,
      duration_ms: 1,
      duration_api_ms: 1,
      num_turns: 1,
      stop_reason: 'end_turn',
      session_id: sid,
      total_cost_usd: 0,
      usage,
      modelUsage: {
        [model]: {
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: usage.cache_creation_input_tokens,
          contextWindow: 200000
        }
      },
      permission_denials: [],
      terminal_reason: 'completed',
      result: 'What would you like help with?',
      uuid: randomUUID()
    }
  ]
  for (const line of lines) await write(process.stdout, JSON.stringify(line) + '\n')
  await exitNow(0)
}

// ---- session run ----

function assertArgv() {
  const problems = []
  const sources = flagValue('--setting-sources')
  if (sources !== undefined && sources !== 'project') {
    problems.push(`--setting-sources must be "project", got "${sources}"`)
  }
  const settings = flagValue('--settings')
  if (settings !== undefined) {
    try {
      const keys = Object.keys(JSON.parse(readFileSync(settings, 'utf8')))
      if (keys.length !== 1 || keys[0] !== 'hooks') {
        problems.push(`--settings must hold only "hooks", got [${keys.join(', ')}]`)
      }
    } catch (error) {
      problems.push(`--settings is not a readable JSON file: ${error.message}`)
    }
  }
  if (flagValue('--mcp-config') !== undefined && !argv.includes('--strict-mcp-config')) {
    problems.push('--mcp-config needs --strict-mcp-config')
  }
  return problems
}

const argvProblems = assertArgv()
if (argvProblems.length > 0) {
  log({ argvViolation: argvProblems })
  await write(process.stderr, 'fake-claude: ' + argvProblems.join('; ') + '\n')
  await exitNow(2)
}
if (env.ARC_AGENT !== undefined) {
  log({
    arcEnv: {
      ARC_AGENT: env.ARC_AGENT,
      ARC_AGENT_ROLE: env.ARC_AGENT_ROLE,
      ARC_PROVIDER: env.ARC_PROVIDER
    }
  })
}

const sessionId = flagValue('--session-id') ?? flagValue('--resume') ?? randomUUID()

/** How many resumed brain runs the log holds, this one included (it was logged at start). */
function resumedBrainRuns() {
  if (!env.FAKE_CLAUDE_LOG || !existsSync(env.FAKE_CLAUDE_LOG)) return 1
  let runs = 0
  for (const line of readFileSync(env.FAKE_CLAUDE_LOG, 'utf8').split('\n')) {
    if (!line.includes('--resume')) continue
    try {
      const args = JSON.parse(line).argv
      if (Array.isArray(args) && args.some((a) => String(a).includes('[arc-role:brain]'))) runs += 1
    } catch {
      // not a record of ours
    }
  }
  return Math.max(runs, 1)
}

function resolveScriptPath() {
  const dir = env.FAKE_CLAUDE_SCRIPT_DIR
  if (dir) {
    const marker = /\[arc-role:([A-Za-z0-9_-]+)\]/.exec(flagValue('--append-system-prompt') ?? '')
    const role = env.FAKE_CLAUDE_ROLE ?? marker?.[1]
    const worker = /\[arc-worker:([A-Za-z0-9_-]+)\]/.exec(flagValue('--append-system-prompt') ?? '')
    if (role === 'worker' && worker) {
      const specific = join(dir, `worker-${worker[1]}.jsonl`)
      if (existsSync(specific)) return specific
    }
    if (role === 'brain' && flagValue('--resume')) {
      for (const name of [`brain-resumed-${resumedBrainRuns()}.jsonl`, 'brain-resumed.jsonl']) {
        if (existsSync(join(dir, name))) return join(dir, name)
      }
    }
    if (role) {
      const candidate = join(dir, role + '.jsonl')
      if (existsSync(candidate)) return candidate
    }
  }
  return env.FAKE_CLAUDE_SCRIPT
}

function loadScript() {
  const path = resolveScriptPath()
  if (!path) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => JSON.parse(l))
}

function lastRequestId() {
  return /\(request ([0-9A-Za-z_-]+)\)/.exec(lastConsumed)?.[1] ?? '{{REQUEST_ID}}'
}

function substitute(value) {
  if (typeof value === 'string') {
    return value
      .replaceAll('{{SESSION_ID}}', sessionId)
      .replaceAll('{{REQUEST_ID}}', lastRequestId())
  }
  if (Array.isArray(value)) return value.map(substitute)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v)]))
  }
  return value
}

function emit(obj) {
  return write(process.stdout, JSON.stringify(substitute(withUsage(obj))) + '\n')
}

// ---- token usage (deterministic, so tests can assert exact numbers) --------------------------------------
// Every assistant line carries message.model and message.usage; every result line carries usage and modelUsage.
// A top-level request number k of a turn (1-based) uses
//     input_tokens 3, cache_creation_input_tokens 40, cache_read_input_tokens 500 + 100 * k, output_tokens 20.
// A helper request (parent_tool_use_id set) uses 2 / 30 / 200 / 10. A message id repeats across lines with the
// same usage (the real CLI sends one line per content block) and is counted once. `result.usage` is the sum of
// the turn's top-level requests, or of one request when the turn emitted none, and is NOT cumulative across turns.
// `result.modelUsage` IS cumulative over the process and includes helper requests, like the real CLI's.
// An interrupted result (terminal_reason aborted_streaming) reports zero usage and an empty modelUsage.
let fakeModel = 'claude-haiku-5-5'
const turnRequests = new Map() // message id -> usage of the current turn's top-level requests
const seenRequests = new Set() // every id counted into the cumulative figures
const cumulative = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0
}
let helperRequests = 0

// Spec 009: the first request of the process carries a setup that grows with what the agent loaded.
let finishedTurns = 0
function loadedItems() {
  let count = 0
  try {
    const file = flagValue('--mcp-config')
    if (file)
      count += Object.keys(JSON.parse(readFileSync(file, 'utf8')).mcpServers ?? {}).filter(
        (n) => n !== 'arc'
      ).length
  } catch {
    // no readable --mcp-config: no servers
  }
  const view = flagValue('--plugin-dir')
  if (view && existsSync(view)) {
    count += readdirSync(view).filter((n) => !n.startsWith('.') && n !== 'user').length
    const skills = join(view, 'user', 'skills')
    if (existsSync(skills)) count += readdirSync(skills).length
  }
  return count
}

function requestUsage(k, helper) {
  const extra =
    !helper && k === 1 && finishedTurns === 0
      ? Number(env.FAKE_CLAUDE_SETUP_PER_ITEM ?? 0) * loadedItems()
      : 0
  return helper
    ? {
        input_tokens: 2,
        cache_creation_input_tokens: 30,
        cache_read_input_tokens: 200,
        output_tokens: 10
      }
    : {
        input_tokens: 3,
        cache_creation_input_tokens: 40 + extra,
        cache_read_input_tokens: 500 + 100 * k,
        output_tokens: 20
      }
}

function addCumulative(u) {
  cumulative.inputTokens += u.input_tokens
  cumulative.outputTokens += u.output_tokens
  cumulative.cacheReadInputTokens += u.cache_read_input_tokens
  cumulative.cacheCreationInputTokens += u.cache_creation_input_tokens
}

function sumUsage(list) {
  const total = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0
  }
  for (const u of list) for (const key of Object.keys(total)) total[key] += u[key]
  return total
}

function withUsage(obj) {
  if (obj?.type === 'assistant' && typeof obj.message?.id === 'string' && !obj.message.usage) {
    const id = obj.message.id
    const helper = typeof obj.parent_tool_use_id === 'string' && obj.parent_tool_use_id !== ''
    let usage = turnRequests.get(id)
    if (!usage) {
      usage = requestUsage(helper ? ++helperRequests : turnRequests.size + 1, helper)
      if (!helper) turnRequests.set(id, usage)
    }
    if (!seenRequests.has(id)) {
      seenRequests.add(id)
      addCumulative(usage)
    }
    return { ...obj, message: { ...obj.message, model: fakeModel, usage } }
  }
  if (obj?.type === 'result' && !obj.usage) {
    if (obj.terminal_reason === 'aborted_streaming') {
      turnRequests.clear()
      return { ...obj, usage: sumUsage([]), modelUsage: {} }
    }
    if (turnRequests.size === 0) {
      const only = requestUsage(1, false)
      addCumulative(only)
      turnRequests.set('default', only)
    }
    const usage = sumUsage([...turnRequests.values()])
    turnRequests.clear()
    finishedTurns += 1
    return {
      ...obj,
      usage,
      modelUsage: { [fakeModel]: { ...cumulative, webSearchRequests: 0, contextWindow: 1000000 } }
    }
  }
  return obj
}

// stdin: every line is logged; unconsumed lines wait for a `waitForStdin` step.
const pending = []
let stdinClosed = false
let wake = () => {}
const notify = () => {
  const w = wake
  wake = () => {}
  w()
}
const changed = () => new Promise((resolve) => (wake = resolve))

async function answerInterrupt(requestId) {
  await emit({
    type: 'control_response',
    response: { subtype: 'success', request_id: requestId, response: { still_queued: [] } }
  })
  await emit({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] },
    parent_tool_use_id: null,
    session_id: '{{SESSION_ID}}',
    uuid: randomUUID(),
    timestamp: new Date().toISOString()
  })
  await emit({
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    duration_ms: 0,
    duration_api_ms: 0,
    num_turns: 1,
    stop_reason: null,
    session_id: '{{SESSION_ID}}',
    total_cost_usd: 0,
    permission_denials: [],
    terminal_reason: 'aborted_streaming',
    uuid: randomUUID()
  })
}

const DEFAULT_COMMANDS = [
  { name: 'compact', description: 'Clear conversation history but keep a summary', builtin: true },
  {
    name: 'awos:spec',
    description: 'Creates the Functional Spec (project)',
    argumentHint: '[feature, optional]'
  }
]

// Commands of the plugins in the --plugin-dir view (each sub-folder is a plugin; the `user` wrapper holds ~/.claude/commands), like the real CLI lists them.
function viewCommands() {
  const root = flagValue('--plugin-dir')
  if (!root || !existsSync(root)) return []
  const out = []
  for (const plugin of readdirSync(root)) {
    if (plugin.startsWith('.')) continue
    const dir = join(root, plugin, 'commands')
    if (!existsSync(dir) || !statSync(dir).isDirectory()) continue
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.md')) continue
      const text = readFileSync(join(dir, file), 'utf8')
      const description = /^description:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? ''
      out.push({ name: `${plugin}:${file.slice(0, -3)}`, description })
    }
  }
  return out
}

// The repository's own commands: .claude/commands/**/*.md under the cwd, nested folders joined with ":".
function repoCommands() {
  const root = join(process.cwd(), '.claude', 'commands')
  const out = []
  const walk = (dir, prefix) => {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry)
      if (statSync(path).isDirectory()) walk(path, prefix + entry + ':')
      else if (entry.endsWith('.md')) {
        const text = readFileSync(path, 'utf8')
        const description = /^description:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? ''
        out.push({ name: prefix + entry.slice(0, -3), description: description + ' (project)' })
      }
    }
  }
  walk(root, '')
  return out
}

function fakeCommands() {
  const file = env.FAKE_CLAUDE_COMMANDS_JSON
  const base =
    !file || !existsSync(file) ? DEFAULT_COMMANDS : JSON.parse(readFileSync(file, 'utf8'))
  return [...base, ...viewCommands(), ...repoCommands()]
}

async function answerInitialize(requestId) {
  await emit({
    type: 'system',
    subtype: 'hook_started',
    hook_id: randomUUID(),
    hook_name: 'SessionStart:startup',
    hook_event: 'SessionStart',
    uuid: randomUUID(),
    session_id: '{{SESSION_ID}}'
  })
  await emit({
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: requestId,
      response: { commands: fakeCommands(), agents: [], models: [] }
    }
  })
}

async function answerMcpStatus(requestId) {
  if (process.env.FAKE_CLAUDE_MCP_STATUS === 'hang') return
  if (process.env.FAKE_CLAUDE_MCP_STATUS === 'fail') {
    await emit({
      type: 'control_response',
      response: { subtype: 'error', request_id: requestId, error: 'mcp_status failed' }
    })
    return
  }
  let configured = {}
  try {
    configured = JSON.parse(readFileSync(flagValue('--mcp-config'), 'utf8')).mcpServers ?? {}
  } catch {
    // no readable --mcp-config: no servers
  }
  const mcpServers = []
  for (const [name, spec] of Object.entries(configured)) {
    if (typeof spec?.command !== 'string') {
      mcpServers.push({ name, status: 'connected', tools: [] })
      continue
    }
    try {
      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
      const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')
      const client = new Client({ name: 'fake-claude', version: '0.0.1' })
      await client.connect(
        new StdioClientTransport({
          command: spec.command,
          args: spec.args ?? [],
          env: { ...process.env, ...(spec.env ?? {}) },
          stderr: 'ignore'
        })
      )
      const { tools } = await client.listTools()
      await client.close()
      mcpServers.push({
        name,
        status: 'connected',
        tools: tools.map((tool) => {
          const hints = tool.annotations ?? {}
          return {
            name: tool.name,
            annotations: {
              ...(hints.readOnlyHint === true ? { readOnly: true } : {}),
              ...(hints.destructiveHint === true ? { destructive: true } : {}),
              ...(hints.openWorldHint === true ? { openWorld: true } : {})
            }
          }
        })
      })
    } catch {
      mcpServers.push({ name, status: 'failed' })
    }
  }
  await emit({
    type: 'control_response',
    response: { subtype: 'success', request_id: requestId, response: { mcpServers } }
  })
}

// Like the real CLI, the first user message that starts with "/" is replayed as a command event
// (spike S1, q3-awos-product.jsonl): <command-name>/x</command-name><command-args>...</command-args>.
let sawFirstUser = false
function firstUserCommand(parsed) {
  if (!parsed || typeof parsed !== 'object' || parsed.type !== 'user') return null
  if (sawFirstUser) return null
  sawFirstUser = true
  const content = parsed.message?.content
  const text =
    typeof content === 'string' ? content : (content ?? []).find((c) => c?.type === 'text')?.text
  return typeof text === 'string' && /^\/\S/.test(text) ? text : null
}

async function echoCommand(text) {
  const [, name, args] = /^\/(\S+)\s*([\s\S]*)$/.exec(text.trim())
  await emit({
    type: 'user',
    message: {
      role: 'user',
      content: `<command-message>${name}</command-message>\n<command-name>/${name}</command-name>\n<command-args>${args}</command-args>`
    },
    session_id: '{{SESSION_ID}}',
    parent_tool_use_id: null,
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    isReplay: true
  })
}

let interruptChain = Promise.resolve()
const rl = createInterface({ input: process.stdin })
rl.on('line', (raw) => {
  if (!raw.trim()) return
  let parsed = raw
  try {
    parsed = JSON.parse(raw)
  } catch {
    // keep the raw string
  }
  log({ stdin: parsed })
  pending.push(raw)
  if (
    parsed &&
    typeof parsed === 'object' &&
    parsed.type === 'control_request' &&
    parsed.request?.subtype === 'interrupt'
  ) {
    interruptChain = interruptChain.then(() => answerInterrupt(parsed.request_id))
  }
  if (
    parsed &&
    typeof parsed === 'object' &&
    parsed.type === 'control_request' &&
    parsed.request?.subtype === 'initialize'
  ) {
    interruptChain = interruptChain.then(() => answerInitialize(parsed.request_id))
  }
  if (
    parsed &&
    typeof parsed === 'object' &&
    parsed.type === 'control_request' &&
    parsed.request?.subtype === 'mcp_status'
  ) {
    interruptChain = interruptChain.then(() => answerMcpStatus(parsed.request_id))
  }
  const commandText = firstUserCommand(parsed)
  if (commandText !== null) interruptChain = interruptChain.then(() => echoCommand(commandText))
  notify()
})
rl.on('close', () => {
  stdinClosed = true
  notify()
})

let lastConsumed = ''

async function waitForStdin(needle) {
  for (;;) {
    const i = pending.findIndex((l) => needle === '*' || l.includes(needle))
    if (i >= 0) {
      lastConsumed = pending[i]
      pending.splice(0, i + 1)
      return true
    }
    if (stdinClosed) return false
    await changed()
  }
}

// ---- scenario helpers (init, say, result, shell, mcp) ----

let toolCounter = 0
const savedCalls = new Map()
let mcpInitialized = false

function mcpConfig() {
  const file = flagValue('--mcp-config')
  if (!file) throw new Error('fake-claude: an mcp step needs --mcp-config')
  const config = JSON.parse(readFileSync(file, 'utf8'))
  // The merged file holds the user's servers too; the bridge is the one named arc.
  const server = config.mcpServers?.arc ?? Object.values(config.mcpServers ?? {})[0]
  if (!server?.url) throw new Error('fake-claude: no MCP server in ' + file)
  return server
}

async function rpc(server, body, expectResponse = true) {
  const res = await fetch(server.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(server.headers ?? {})
    },
    body: JSON.stringify(body)
  })
  const text = await res.text()
  if (!expectResponse) return null
  if (!res.ok) throw new Error(`fake-claude: bridge answered ${res.status}: ${text}`)
  const type = res.headers.get('content-type') ?? ''
  const messages = type.includes('text/event-stream')
    ? text
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => JSON.parse(l.slice(5).trim()))
    : [JSON.parse(text)]
  const answer = messages.find((m) => m.id === body.id)
  if (!answer) throw new Error('fake-claude: no answer in ' + text)
  if (answer.error) throw new Error('fake-claude: ' + JSON.stringify(answer.error))
  return answer.result
}

async function callMcp(tool, args) {
  const server = mcpConfig()
  if (!mcpInitialized) {
    mcpInitialized = true
    await rpc(server, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'fake-claude', version: '0' }
      }
    })
    await rpc(server, { jsonrpc: '2.0', method: 'notifications/initialized' }, false)
  }
  return rpc(server, {
    jsonrpc: '2.0',
    id: 100 + ++toolCounter,
    method: 'tools/call',
    params: { name: tool, arguments: args ?? {}, _meta: { progressToken: 'p' + toolCounter } }
  })
}

async function runMcpStep(step) {
  const { tool } = step.mcp
  const args = substitute(step.mcp.args)
  const toolUseId = 'toolu_fake_' + ++toolCounter
  const name = 'mcp__arc__' + tool
  await emit({
    type: 'assistant',
    message: {
      id: 'msg_fake_' + toolCounter,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'tool_use', id: toolUseId, name, input: args ?? {} }]
    },
    parent_tool_use_id: null,
    session_id: '{{SESSION_ID}}',
    uuid: randomUUID()
  })
  const run = (async () => {
    let isError
    let text
    try {
      const result = await callMcp(name.replace(/^mcp__arc__/, ''), args)
      isError = result.isError === true
      text = (result.content ?? []).map((c) => c.text ?? '').join('')
    } catch (error) {
      isError = true
      text = String(error?.message ?? error)
    }
    log({ mcpResult: { tool, isError, text } })
    await emit({
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolUseId,
            content: [{ type: 'text', text }],
            is_error: isError
          }
        ]
      },
      parent_tool_use_id: null,
      session_id: '{{SESSION_ID}}',
      uuid: randomUUID()
    })
    return { isError, text }
  })()
  if (step.saveAs) {
    savedCalls.set(step.saveAs, run)
    return
  }
  const outcome = await run
  if (outcome.isError && typeof step.exitIfMcpError === 'number') await exitNow(step.exitIfMcpError)
}

/** A call of the user's own MCP tool: logged, then asked about like any tool the CLI cannot run on its own. */
async function runPersonalToolStep(step) {
  const { server, tool, input = {} } = step.personalTool
  const configFile = flagValue('--mcp-config')
  let configured = false
  try {
    const servers = JSON.parse(readFileSync(configFile, 'utf8')).mcpServers ?? {}
    configured = Object.prototype.hasOwnProperty.call(servers, server)
  } catch {
    // no readable --mcp-config: nothing is configured
  }
  log({ personalMcp: { server, tool, configured } })
  const name = `mcp__${server}__${tool}`
  if (!configured) {
    const toolUseId = 'toolu_fake_' + ++toolCounter
    await emit({
      type: 'assistant',
      message: {
        id: 'msg_fake_' + toolCounter,
        type: 'message',
        role: 'assistant',
        content: [{ type: 'tool_use', id: toolUseId, name, input }]
      },
      parent_tool_use_id: null,
      session_id: '{{SESSION_ID}}',
      uuid: randomUUID()
    })
    await emit({
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolUseId,
            content: [{ type: 'text', text: `server not configured: ${server}` }],
            is_error: true
          }
        ]
      },
      parent_tool_use_id: null,
      session_id: '{{SESSION_ID}}',
      uuid: randomUUID()
    })
    return
  }
  await runToolStep({ tool: { name, input } })
}

async function runToolStep(step, parentToolUseId = null) {
  const { name, input } = step.tool
  const toolUseId = 'toolu_fake_' + ++toolCounter
  await emit({
    type: 'assistant',
    message: {
      id: 'msg_fake_' + toolCounter,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'tool_use', id: toolUseId, name, input }]
    },
    parent_tool_use_id: parentToolUseId,
    session_id: '{{SESSION_ID}}',
    uuid: randomUUID()
  })
  let decision
  try {
    const result = await callMcp('request_permission', {
      tool_name: name,
      input,
      tool_use_id: toolUseId
    })
    const text = (result.content ?? []).map((c) => c.text ?? '').join('')
    decision = result.isError === true ? { behavior: 'deny', message: text } : JSON.parse(text)
  } catch (error) {
    decision = { behavior: 'deny', message: String(error?.message ?? error) }
  }
  log({
    permission: {
      tool_name: name,
      input,
      behavior: decision.behavior,
      ...(decision.message ? { message: decision.message } : {})
    }
  })
  const allowed = decision.behavior === 'allow'
  const ran = decision.updatedInput ?? input
  const asking = name === 'AskUserQuestion'
  const text = asking
    ? allowed
      ? 'Your questions have been answered: ' +
        Object.entries(ran.answers ?? {})
          .map(([q, a]) => '"' + q + '"="' + a + '"')
          .join(', ')
      : decision.message
    : allowed
      ? '(fake) ran: ' + (ran.command ?? JSON.stringify(ran))
      : decision.message
  await emit({
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: [{ type: 'text', text }],
          is_error: !allowed
        }
      ]
    },
    parent_tool_use_id: parentToolUseId,
    session_id: '{{SESSION_ID}}',
    uuid: randomUUID()
  })
  if (asking) {
    // What the worker received, as an assistant message, so a test can assert the answer reached it.
    await emitSay(
      allowed
        ? 'AskUserQuestion answers: ' + JSON.stringify(ran.answers ?? {})
        : 'AskUserQuestion declined: ' + decision.message
    )
  }
}

// ---- background helpers (subagents) ----

const helpers = new Map()

function helperOf(id) {
  const helper = helpers.get(String(id))
  if (!helper) throw new Error('fake-claude: no helper "' + id + '" (use taskStart first)')
  return helper
}

function runningHelpers() {
  return [...helpers.values()]
    .filter((h) => h.running)
    .map((h) => ({
      task_id: h.taskId,
      run_id: 'run-' + h.taskId,
      task_type: 'local_agent',
      subagent_type: 'general-purpose',
      description: h.description
    }))
}

async function emitTasksChanged() {
  await emit({
    type: 'system',
    subtype: 'background_tasks_changed',
    tasks: runningHelpers(),
    uuid: randomUUID(),
    session_id: '{{SESSION_ID}}'
  })
}

async function runTaskStart({ id, description = 'Helper' }) {
  const toolUseId = 'toolu_fake_agent_' + ++toolCounter
  const helper = { taskId: 'task_' + id, toolUseId, description, running: true }
  helpers.set(String(id), helper)
  await emit({
    type: 'assistant',
    message: {
      id: 'msg_fake_' + toolCounter,
      type: 'message',
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: toolUseId,
          name: 'Agent',
          input: { description, subagent_type: 'general-purpose', prompt: description }
        }
      ]
    },
    parent_tool_use_id: null,
    session_id: '{{SESSION_ID}}',
    uuid: randomUUID()
  })
  await emitTasksChanged()
  await emit({
    type: 'system',
    subtype: 'task_started',
    task_id: helper.taskId,
    run_id: 'run-' + helper.taskId,
    tool_use_id: toolUseId,
    description,
    subagent_type: 'general-purpose',
    is_backgrounded: true,
    spawn_depth: 1,
    task_type: 'local_agent',
    prompt: description,
    uuid: randomUUID(),
    session_id: '{{SESSION_ID}}'
  })
  await emit({
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: [{ type: 'text', text: 'Async agent launched successfully.' }]
        }
      ]
    },
    parent_tool_use_id: null,
    session_id: '{{SESSION_ID}}',
    uuid: randomUUID()
  })
}

async function runTaskSay({ id, text }) {
  const helper = helperOf(id)
  await emit({
    type: 'assistant',
    message: {
      id: 'msg_fake_helper_' + ++toolCounter,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: String(text) }]
    },
    parent_tool_use_id: helper.toolUseId,
    agent_id: helper.taskId,
    session_id: '{{SESSION_ID}}',
    uuid: randomUUID()
  })
}

async function runTaskTool({ id, name, input, permission }) {
  const helper = helperOf(id)
  if (permission === true) {
    await runToolStep({ tool: { name, input } }, helper.toolUseId)
    return
  }
  const toolUseId = 'toolu_fake_' + ++toolCounter
  await emit({
    type: 'assistant',
    message: {
      id: 'msg_fake_' + toolCounter,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'tool_use', id: toolUseId, name, input }]
    },
    parent_tool_use_id: helper.toolUseId,
    session_id: '{{SESSION_ID}}',
    uuid: randomUUID()
  })
  await emit({
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: toolUseId, content: '(fake) ok', is_error: false }
      ]
    },
    parent_tool_use_id: helper.toolUseId,
    session_id: '{{SESSION_ID}}',
    uuid: randomUUID()
  })
}

async function runTaskEnd({ id, status = 'completed', summary = 'The helper finished.' }) {
  const helper = helperOf(id)
  helper.running = false
  await emit({
    type: 'system',
    subtype: 'task_updated',
    task_id: helper.taskId,
    run_id: 'run-' + helper.taskId,
    patch: { status, end_time: Date.now() },
    uuid: randomUUID(),
    session_id: '{{SESSION_ID}}'
  })
  await emit({
    type: 'system',
    subtype: 'task_notification',
    task_id: helper.taskId,
    run_id: 'run-' + helper.taskId,
    tool_use_id: helper.toolUseId,
    status,
    summary,
    uuid: randomUUID(),
    session_id: '{{SESSION_ID}}'
  })
  await emitTasksChanged()
}

function runShell(cmd) {
  return new Promise((resolve) => {
    execFile(
      'sh',
      ['-c', cmd],
      { cwd: process.cwd(), env: process.env },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0
        log({ shell: { cmd, code, out: (stdout + stderr).slice(-500) } })
        void runEditHooks().then(resolve)
      }
    )
  })
}

function hookCommands(settingsPath) {
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf8'))
    const root = parsed.hooks && parsed.hooks.hooks ? parsed.hooks : parsed
    const groups = (root.hooks ?? {}).PostToolUse ?? []
    return groups.flatMap((g) => (g.hooks ?? []).map((h) => h.command).filter(Boolean))
  } catch {
    return []
  }
}

// Plays the PostToolUse hooks the real CLI would load for this run's flags (see the header).
function runEditHooks() {
  if (env.FAKE_CLAUDE_RUN_HOOKS !== '1') return Promise.resolve()
  const commands = []
  const sources = (flagValue('--setting-sources') ?? '').split(',')
  if (sources.includes('user') && env.HOME) {
    commands.push(...hookCommands(join(env.HOME, '.claude', 'settings.json')))
  }
  if (sources.includes('project')) {
    commands.push(...hookCommands(join(process.cwd(), '.claude', 'settings.json')))
  }
  const extraSettings = flagValue('--settings')
  if (extraSettings) commands.push(...hookCommands(extraSettings))
  const pluginRoot = flagValue('--plugin-dir')
  if (pluginRoot && existsSync(pluginRoot)) {
    for (const plugin of readdirSync(pluginRoot)) {
      commands.push(...hookCommands(join(pluginRoot, plugin, 'hooks', 'hooks.json')))
    }
  }
  return Promise.all(
    commands.map(
      (cmd) =>
        new Promise((resolve) => {
          execFile('sh', ['-c', cmd], { cwd: process.cwd(), env: process.env }, (error) => {
            log({ hook: { cmd, code: error ? 1 : 0 } })
            resolve()
          })
        })
    )
  )
}

async function emitInit(step) {
  const model = typeof step.model === 'string' ? step.model : 'claude-haiku-5-5'
  fakeModel = model
  await emit({
    type: 'system',
    subtype: 'init',
    cwd: process.cwd(),
    session_id: '{{SESSION_ID}}',
    tools: ['Read'],
    mcp_servers: step.mcp === true ? [{ name: 'arc', status: 'connected' }] : [],
    model,
    permissionMode: 'default',
    uuid: randomUUID()
  })
}

async function emitSay(text) {
  const id = `msg_fake_say_${process.pid}_${++toolCounter}`
  // The real CLI sends one line per content block, all with the same message id: a thinking block first.
  await emit({
    type: 'assistant',
    message: {
      id,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'thinking', thinking: '', signature: 'fake' }]
    },
    parent_tool_use_id: null,
    session_id: '{{SESSION_ID}}',
    uuid: randomUUID()
  })
  await emit({
    type: 'assistant',
    message: { id, type: 'message', role: 'assistant', content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
    session_id: '{{SESSION_ID}}',
    uuid: randomUUID()
  })
}

// ---- plan limits (rate_limit_event) -----------------------------------------------------------------------
let rateLimitTurn = 0

function configuredRateLimit() {
  const file = env.FAKE_CLAUDE_RATE_LIMIT_FILE
  const raw = file && existsSync(file) ? readFileSync(file, 'utf8') : env.FAKE_CLAUDE_RATE_LIMIT
  if (!raw || raw.trim() === '') return undefined
  const parsed = JSON.parse(raw)
  if (!Array.isArray(parsed)) return parsed
  return parsed[Math.min(rateLimitTurn, parsed.length - 1)]
}

async function emitRateLimit(windows) {
  const { status = 'allowed', ...rest } = windows
  const nowSeconds = Math.floor(Date.now() / 1000)
  const defaults = { five_hour: nowSeconds + 5 * 3600, seven_day: nowSeconds + 7 * 86400 }
  const unifiedWindows = {}
  for (const [key, value] of Object.entries(rest)) {
    const w = typeof value === 'number' ? { utilization: value } : value
    unifiedWindows[key] = { resetsAt: defaults[key] ?? nowSeconds + 3600, ...w }
  }
  const first = Object.keys(unifiedWindows)[0] ?? 'five_hour'
  await emit({
    type: 'rate_limit_event',
    rate_limit_info: {
      status,
      resetsAt: unifiedWindows[first]?.resetsAt ?? defaults.five_hour,
      rateLimitType: first,
      overageStatus: 'rejected',
      isUsingOverage: false,
      unifiedWindows
    },
    uuid: randomUUID(),
    session_id: '{{SESSION_ID}}'
  })
}

async function emitResult(kind) {
  const failed = kind === 'error'
  const windows = configuredRateLimit()
  rateLimitTurn += 1
  if (windows) await emitRateLimit(windows)
  await emit({
    type: 'result',
    subtype: failed ? 'error_during_execution' : 'success',
    is_error: failed,
    duration_ms: 1,
    duration_api_ms: 1,
    num_turns: 1,
    stop_reason: 'end_turn',
    session_id: '{{SESSION_ID}}',
    total_cost_usd: 0,
    permission_denials: [],
    terminal_reason: failed ? 'api_error' : 'completed',
    result: failed ? 'The fake run failed' : 'done',
    uuid: randomUUID()
  })
}

// Returns false when the run should end (stdin closed while blocked).
async function runStep(step) {
  await interruptChain // an interrupt answer is always written before the script continues
  if (typeof step.delay === 'number') await sleep(step.delay)
  if ('emit' in step) await emit(step.emit)
  if ('init' in step) await emitInit(step)
  if ('say' in step) await emitSay(String(step.say))
  if ('rateLimit' in step && typeof step.rateLimit === 'object') await emitRateLimit(step.rateLimit)
  if ('result' in step) await emitResult(step.result)
  if ('shell' in step) await runShell(String(step.shell))
  if ('mcp' in step && typeof step.mcp === 'object') await runMcpStep(step)
  if ('tool' in step && typeof step.tool === 'object') await runToolStep(step)
  if ('personalTool' in step && typeof step.personalTool === 'object') {
    await runPersonalToolStep(step)
  }
  if ('taskStart' in step) await runTaskStart(step.taskStart)
  if ('taskSay' in step) await runTaskSay(step.taskSay)
  if ('taskTool' in step) await runTaskTool(step.taskTool)
  if ('taskEnd' in step) await runTaskEnd(step.taskEnd)
  if ('waitForMcpResult' in step) {
    const saved = savedCalls.get(String(step.waitForMcpResult))
    if (saved) await saved
  }
  if ('stderr' in step) await write(process.stderr, String(step.stderr))
  if ('waitForStdin' in step) {
    if (!(await waitForStdin(String(step.waitForStdin)))) return false
  }
  if ('exit' in step) {
    await interruptChain
    await exitNow(Number(step.exit))
  }
  if (step.hang) {
    while (!stdinClosed) await changed()
    return false
  }
  return true
}

for (const step of loadScript()) {
  if (!(await runStep(step))) break
}
while (!stdinClosed) await changed()
await interruptChain
await exitNow(0)
