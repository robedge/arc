import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const fake = resolve('tests/e2e/fixtures/fake-claude.mjs')
const interruptFixture = resolve('tests/fixtures/claude/2.1.302/interrupt.jsonl')
const textScenario = resolve('tests/e2e/fixtures/claude-scenarios/text-reply.jsonl')

let dir: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'arc-fake-claude-'))
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

interface Run {
  child: ChildProcessWithoutNullStreams
  stdout: () => string
  lines: () => unknown[]
  stderr: () => string
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  waitForLine: (pred: (o: Record<string, unknown>) => boolean) => Promise<void>
}

function run(args: string[], env: Record<string, string> = {}): Run {
  // process.execPath is Electron under test:unit, so force node mode.
  const child = spawn(process.execPath, [fake, ...args], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...env }
  })
  let out = ''
  let err = ''
  child.stdout.on('data', (d: Buffer) => (out += d.toString()))
  child.stderr.on('data', (d: Buffer) => (err += d.toString()))
  const lines = (): unknown[] =>
    out
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as unknown)
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((res) =>
    child.on('exit', (code, signal) => res({ code, signal }))
  )
  const waitForLine: Run['waitForLine'] = async (pred) => {
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      if (lines().some((o) => pred(o as Record<string, unknown>))) return
      await new Promise((r) => setTimeout(r, 10))
    }
    throw new Error('timed out waiting for line; stdout=' + out)
  }
  return { child, stdout: () => out, lines, stderr: () => err, exited, waitForLine }
}

function script(name: string, steps: unknown[]): string {
  const p = join(dir, name)
  writeFileSync(p, steps.map((s) => JSON.stringify(s)).join('\n') + '\n')
  return p
}

function send(r: Run, obj: unknown): void {
  r.child.stdin.write(JSON.stringify(obj) + '\n')
}

const userMsg = (text: string): unknown => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'text', text }] }
})
const interrupt = {
  type: 'control_request',
  request_id: 'req_int_1',
  request: { subtype: 'interrupt' }
}

describe('fake-claude', () => {
  it('prints the version line', async () => {
    const r = run(['--version'])
    expect(await r.exited).toEqual({ code: 0, signal: null })
    expect(r.stdout()).toBe('2.1.302 (Claude Code)\n')
  })

  it('auth status --json defaults to logged in', async () => {
    const r = run(['auth', 'status', '--json'])
    await r.exited
    expect((JSON.parse(r.stdout()) as { loggedIn: boolean }).loggedIn).toBe(true)
  })

  it('auth status --json reports signed out with FAKE_CLAUDE_AUTH=out', async () => {
    const r = run(['auth', 'status', '--json'], { FAKE_CLAUDE_AUTH: 'out' })
    await r.exited
    expect(JSON.parse(r.stdout())).toEqual({ loggedIn: false, authMethod: 'none' })
  })

  it('replays emit, delay and stderr in order, substituting the session id', async () => {
    const s = script('order.jsonl', [
      { emit: { n: 1, id: '{{SESSION_ID}}' } },
      { delay: 150 },
      { emit: { n: 2 } },
      { stderr: 'oops' },
      { emit: { n: 3 }, delay: 100 }
    ])
    const t0 = Date.now()
    const r = run(['--session-id', 'sid-123'], { FAKE_CLAUDE_SCRIPT: s })
    await r.waitForLine((o) => o.n === 3)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(240)
    expect(r.lines()).toEqual([{ n: 1, id: 'sid-123' }, { n: 2 }, { n: 3 }])
    expect(r.stderr()).toBe('oops')
    r.child.stdin.end()
    expect((await r.exited).code).toBe(0)
  })

  it('uses a generated uuid for {{SESSION_ID}} when no session flag is given', async () => {
    const s = script('uuid.jsonl', [{ emit: { id: '{{SESSION_ID}}' } }])
    const r = run([], { FAKE_CLAUDE_SCRIPT: s })
    await r.waitForLine((o) => typeof o.id === 'string')
    expect((r.lines()[0] as { id: string }).id).toMatch(/^[0-9a-f-]{36}$/)
    r.child.stdin.end()
    await r.exited
  })

  it('blocks on waitForStdin until a matching line arrives', async () => {
    const s = script('wait.jsonl', [
      { emit: { n: 1 } },
      { waitForStdin: 'go-now' },
      { emit: { n: 2 } }
    ])
    const r = run([], { FAKE_CLAUDE_SCRIPT: s })
    await r.waitForLine((o) => o.n === 1)
    send(r, userMsg('not it'))
    await new Promise((res) => setTimeout(res, 150))
    expect(r.lines()).toEqual([{ n: 1 }])
    send(r, userMsg('please go-now'))
    await r.waitForLine((o) => o.n === 2)
    r.child.stdin.end()
    expect((await r.exited).code).toBe(0)
  })

  it('waitForStdin "*" accepts any line', async () => {
    const s = script('any.jsonl', [{ waitForStdin: '*' }, { emit: { n: 1 } }])
    const r = run([], { FAKE_CLAUDE_SCRIPT: s })
    send(r, userMsg('anything'))
    await r.waitForLine((o) => o.n === 1)
    r.child.stdin.end()
    await r.exited
  })

  it('answers an interrupt like the real CLI and then continues the script', async () => {
    const s = script('interrupt.jsonl', [{ waitForStdin: 'interrupt' }, { emit: { after: true } }])
    const r = run(['--session-id', 'sid-int'], { FAKE_CLAUDE_SCRIPT: s })
    send(r, interrupt)
    await r.waitForLine((o) => o.after === true)
    const got = r.lines() as Array<Record<string, unknown>>
    const real = readFileSync(interruptFixture, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>)

    const cr = got[0]
    const realCr = real.find((o) => o.type === 'control_response')
    expect(cr).toEqual({
      ...realCr,
      response: { ...(realCr?.response as object), request_id: 'req_int_1' }
    })

    const keys = (o: Record<string, unknown> | undefined): string[] => Object.keys(o ?? {}).sort()
    const user = got[1]
    const realUser = real.find(
      (o) => o.type === 'user' && JSON.stringify(o).includes('Request interrupted')
    )
    expect(user?.message).toEqual(realUser?.message)
    expect(keys(user)).toEqual(keys(realUser))

    const result = got[2]
    const realResult = real.find((o) => o.type === 'result')
    expect(result).toMatchObject({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      terminal_reason: 'aborted_streaming',
      session_id: 'sid-int'
    })
    expect(result?.type).toBe(realResult?.type)
    expect(result?.subtype).toBe(realResult?.subtype)
    expect(result?.terminal_reason).toBe(realResult?.terminal_reason)
    expect(got[3]).toEqual({ after: true })
    r.child.stdin.end()
    await r.exited
  })

  it('logs argv and every stdin line to FAKE_CLAUDE_LOG', async () => {
    const log = join(dir, 'log.jsonl')
    const s = script('log.jsonl.script', [{ waitForStdin: '*' }])
    const r = run(['-p', '--model', 'haiku'], { FAKE_CLAUDE_SCRIPT: s, FAKE_CLAUDE_LOG: log })
    send(r, userMsg('hi'))
    r.child.stdin.write('not json\n')
    r.child.stdin.end()
    await r.exited
    const recs = readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as unknown)
    expect(recs).toEqual([
      { argv: ['-p', '--model', 'haiku'] },
      { stdin: userMsg('hi') },
      { stdin: 'not json' }
    ])
  })

  it('exits 0 when stdin closes after the script ends', async () => {
    const r = run([], { FAKE_CLAUDE_SCRIPT: script('end.jsonl', [{ emit: { done: 1 } }]) })
    await r.waitForLine((o) => o.done === 1)
    r.child.stdin.end()
    expect(await r.exited).toEqual({ code: 0, signal: null })
  })

  it('exit step exits with the given code', async () => {
    const r = run([], {
      FAKE_CLAUDE_SCRIPT: script('exit.jsonl', [{ emit: { a: 1 } }, { exit: 3 }])
    })
    expect((await r.exited).code).toBe(3)
    expect(r.lines()).toEqual([{ a: 1 }])
  })

  it('hang stays alive until SIGTERM', async () => {
    const r = run([], {
      FAKE_CLAUDE_SCRIPT: script('hang.jsonl', [
        { emit: { a: 1 } },
        { hang: true },
        { emit: { never: 1 } }
      ])
    })
    await r.waitForLine((o) => o.a === 1)
    await new Promise((res) => setTimeout(res, 200))
    expect(r.child.exitCode).toBeNull()
    r.child.kill('SIGTERM')
    expect((await r.exited).signal).toBe('SIGTERM')
    expect(r.lines()).toEqual([{ a: 1 }])
  })

  it('hang ends with exit 0 when stdin closes', async () => {
    const r = run([], { FAKE_CLAUDE_SCRIPT: script('hang2.jsonl', [{ hang: true }]) })
    await new Promise((res) => setTimeout(res, 100))
    r.child.stdin.end()
    expect((await r.exited).code).toBe(0)
  })

  it('picks <dir>/<role>.jsonl from FAKE_CLAUDE_ROLE or the append-system-prompt marker', async () => {
    const d = join(dir, 'roles')
    mkdirSync(d)
    writeFileSync(join(d, 'brain.jsonl'), JSON.stringify({ emit: { role: 'brain' } }) + '\n')
    writeFileSync(join(d, 'worker.jsonl'), JSON.stringify({ emit: { role: 'worker' } }) + '\n')
    const fallback = script('fallback.jsonl', [{ emit: { role: 'fallback' } }])
    const base = { FAKE_CLAUDE_SCRIPT_DIR: d, FAKE_CLAUDE_SCRIPT: fallback }

    const byEnv = run([], { ...base, FAKE_CLAUDE_ROLE: 'brain' })
    await byEnv.waitForLine((o) => o.role === 'brain')
    byEnv.child.stdin.end()
    await byEnv.exited

    const byMarker = run(['--append-system-prompt', 'You are X. [arc-role:worker]'], base)
    await byMarker.waitForLine((o) => o.role === 'worker')
    byMarker.child.stdin.end()
    await byMarker.exited

    const none = run([], base)
    await none.waitForLine((o) => o.role === 'fallback')
    none.child.stdin.end()
    await none.exited
  })

  it('plays the shipped text-reply scenario', async () => {
    const r = run(['--session-id', 'sid-text'], { FAKE_CLAUDE_SCRIPT: textScenario })
    send(r, userMsg('ping'))
    await r.waitForLine((o) => o.type === 'result')
    const got = r.lines() as Array<Record<string, unknown>>
    expect(got[0]).toMatchObject({ type: 'system', subtype: 'init', session_id: 'sid-text' })
    expect(got.at(-1)).toMatchObject({ type: 'result', subtype: 'success', result: 'pong' })
    r.child.stdin.end()
    expect((await r.exited).code).toBe(0)
  })

  it('picks <dir>/worker-<slug>.jsonl from the [arc-worker:<slug>] marker before worker.jsonl', async () => {
    const d = join(dir, 'slugs')
    mkdirSync(d)
    writeFileSync(join(d, 'worker.jsonl'), JSON.stringify({ emit: { who: 'any' } }) + '\n')
    writeFileSync(join(d, 'worker-api.jsonl'), JSON.stringify({ emit: { who: 'api' } }) + '\n')
    const prompt = '[arc-role:worker] [arc-worker:api]'
    const named = run(['--append-system-prompt', prompt], { FAKE_CLAUDE_SCRIPT_DIR: d })
    await named.waitForLine((o) => o.who === 'api')
    named.child.stdin.end()
    await named.exited
    const other = run(['--append-system-prompt', '[arc-role:worker] [arc-worker:web]'], {
      FAKE_CLAUDE_SCRIPT_DIR: d
    })
    await other.waitForLine((o) => o.who === 'any')
    other.child.stdin.end()
    await other.exited
  })

  it('a brain started with --resume picks brain-resumed-<n>.jsonl by its place among the resumed runs', async () => {
    const d = join(dir, 'resumed')
    mkdirSync(d)
    const logPath = join(d, 'log.jsonl')
    writeFileSync(join(d, 'brain.jsonl'), JSON.stringify({ emit: { run: 'first' } }) + '\n')
    writeFileSync(join(d, 'brain-resumed-1.jsonl'), JSON.stringify({ emit: { run: 'one' } }) + '\n')
    writeFileSync(join(d, 'brain-resumed-2.jsonl'), JSON.stringify({ emit: { run: 'two' } }) + '\n')
    const prompt = '[arc-role:brain]'
    const env = { FAKE_CLAUDE_SCRIPT_DIR: d, FAKE_CLAUDE_LOG: logPath }
    for (const [args, expected] of [
      [['--session-id', 'a', '--append-system-prompt', prompt], 'first'],
      [['--resume', 'a', '--append-system-prompt', prompt], 'one'],
      [['--resume', 'a', '--append-system-prompt', prompt], 'two']
    ] as const) {
      const r = run([...args], env)
      await r.waitForLine((o) => o.run === expected)
      r.child.stdin.end()
      await r.exited
    }
  })

  it('init, say and result steps print the lines a turn is made of', async () => {
    const s = script('turn.jsonl', [
      { init: true, mcp: true, model: 'claude-sonnet-5-5' },
      { say: 'hello there' },
      { result: true },
      { result: 'error' }
    ])
    const r = run(['--session-id', 'sid-turn'], { FAKE_CLAUDE_SCRIPT: s })
    await r.waitForLine((o) => o.type === 'result' && o.is_error === true)
    const got = r.lines() as Array<Record<string, unknown>>
    expect(got[0]).toMatchObject({
      type: 'system',
      subtype: 'init',
      session_id: 'sid-turn',
      model: 'claude-sonnet-5-5',
      mcp_servers: [{ name: 'arc', status: 'connected' }]
    })
    // Like the real CLI, one line per content block with the same message id: a thinking block, then the text.
    expect(got[1]).toMatchObject({
      type: 'assistant',
      message: { content: [{ type: 'thinking' }] }
    })
    expect(got[2]).toMatchObject({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'hello there' }] }
    })
    expect((got[2] as { message: { id: string } }).message.id).toBe(
      (got[1] as { message: { id: string } }).message.id
    )
    expect(got[3]).toMatchObject({ type: 'result', subtype: 'success', is_error: false })
    expect(got[4]).toMatchObject({ type: 'result', is_error: true })
    r.child.stdin.end()
    await r.exited
  })

  it('shell step runs in the working directory and logs the outcome', async () => {
    const cwd = join(dir, 'shell-cwd')
    mkdirSync(cwd)
    const logPath = join(dir, 'shell.log')
    const s = script('shell.jsonl', [
      { shell: 'echo made > made.txt' },
      { shell: 'exit 3' },
      { emit: { after: true } }
    ])
    const child = spawn(process.execPath, [fake], {
      cwd,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        FAKE_CLAUDE_SCRIPT: s,
        FAKE_CLAUDE_LOG: logPath
      }
    })
    let out = ''
    child.stdout.on('data', (d: Buffer) => (out += d.toString()))
    const deadline = Date.now() + 5000
    while (!out.includes('after') && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 20))
    child.stdin.end()
    await new Promise((r) => child.on('exit', r))
    expect(readFileSync(join(cwd, 'made.txt'), 'utf8')).toBe('made\n')
    const shells = readFileSync(logPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { shell?: { cmd: string; code: number } })
      .flatMap((r) => (r.shell ? [r.shell] : []))
    expect(shells.map((x) => [x.cmd, x.code])).toEqual([
      ['echo made > made.txt', 0],
      ['exit 3', 3]
    ])
  })
})

describe('fake-claude plugin changes', () => {
  function state(name: string, initial: unknown): { file: string; cache: string } {
    const file = join(dir, `${name}.json`)
    writeFileSync(file, JSON.stringify(initial))
    return { file, cache: join(dir, `${name}-cache`) }
  }
  const envOf = (st: { file: string; cache: string }, extra: Record<string, string> = {}) => ({
    FAKE_CLAUDE_PLUGINS_JSON: st.file,
    FAKE_CLAUDE_PLUGIN_CACHE: st.cache,
    ...extra
  })
  const entries = (file: string): { id: string; version: string; installPath: string }[] =>
    JSON.parse(readFileSync(file, 'utf8')) as { id: string; version: string; installPath: string }[]

  it('install adds the entry and a plugin folder with one command', async () => {
    const st = state('install', [])
    const r = run(['plugin', 'install', 'extras@mkt', '-s', 'user', '--json', '-y'], envOf(st))
    expect((await r.exited).code).toBe(0)
    expect(JSON.parse(r.stdout())).toMatchObject({ success: true })
    const [entry] = entries(st.file)
    expect(entry).toMatchObject({ id: 'extras@mkt', version: '1.0.0' })
    const manifest = JSON.parse(
      readFileSync(join(entry!.installPath, '.claude-plugin', 'plugin.json'), 'utf8')
    ) as { name: string }
    expect(manifest.name).toBe('extras')
    expect(readFileSync(join(entry!.installPath, 'commands', 'hello.md'), 'utf8')).toContain(
      'description:'
    )
  })

  it('update raises the version and uninstall removes the entry', async () => {
    const st = state('upd', [
      { id: 'a@m', version: '1.2.3', scope: 'user', enabled: true, installPath: join(dir, 'nope') }
    ])
    const up = run(['plugin', 'update', 'a@m', '-s', 'user', '--json', '-y'], envOf(st))
    await up.exited
    expect(entries(st.file)[0]?.version).toBe('1.2.4')
    const rm = run(['plugin', 'uninstall', 'a@m', '-s', 'user', '--json', '-y'], envOf(st))
    expect((await rm.exited).code).toBe(0)
    expect(entries(st.file)).toEqual([])
  })

  it('FAKE_CLAUDE_PLUGIN_FAIL fails with a JSON error and leaves the state alone', async () => {
    const st = state('fail', [])
    const r = run(
      ['plugin', 'install', 'x@m', '--json', '-y'],
      envOf(st, { FAKE_CLAUDE_PLUGIN_FAIL: 'Marketplace unreachable' })
    )
    expect((await r.exited).code).toBe(1)
    expect(JSON.parse(r.stdout())).toEqual({ success: false, error: 'Marketplace unreachable' })
    expect(entries(st.file)).toEqual([])
  })

  it('FAKE_CLAUDE_PLUGIN_DELAY waits first', async () => {
    const st = state('delay', [])
    const t0 = Date.now()
    const r = run(
      ['plugin', 'marketplace', 'update', '--json'],
      envOf(st, { FAKE_CLAUDE_PLUGIN_DELAY: '250' })
    )
    expect((await r.exited).code).toBe(0)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(240)
  })

  it('the initialize answer lists the commands of plugins in the --plugin-dir view', async () => {
    const view = join(dir, 'view')
    mkdirSync(join(view, 'extras', 'commands'), { recursive: true })
    mkdirSync(join(view, 'user'), { recursive: true })
    writeFileSync(
      join(view, 'extras', 'commands', 'hello.md'),
      '---\ndescription: Says hello\n---\nHi\n'
    )
    const r = run(['-p', '--input-format', 'stream-json', '--plugin-dir', view], {})
    send(r, {
      type: 'control_request',
      request_id: 'r1',
      request: { subtype: 'initialize' }
    })
    await r.waitForLine((o) => o.type === 'control_response')
    const response = r
      .lines()
      .find((o) => (o as { type?: string }).type === 'control_response') as {
      response: { response: { commands: { name: string; description: string }[] } }
    }
    expect(response.response.response.commands).toContainEqual({
      name: 'extras:hello',
      description: 'Says hello'
    })
    r.child.stdin.end()
    await r.exited
  })
})
