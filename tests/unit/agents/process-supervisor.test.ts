import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildAgentEnv,
  LineSplitter,
  ProcessSupervisor,
  StderrRing,
  type ChildLike,
  type SupervisedProcess
} from '../../../src/main/agents/process-supervisor'

const stub = resolve('tests/unit/agents/helpers/stub-child.mjs')
const nodeEnv = { ELECTRON_RUN_AS_NODE: '1' }

function startStub(mode: string, supervisor = new ProcessSupervisor()): SupervisedProcess {
  return supervisor.spawn({
    command: process.execPath,
    args: [stub, mode],
    cwd: process.cwd(),
    env: { ...buildAgentEnv(process.env, process.env['PATH'] ?? ''), ...nodeEnv }
  })
}

function collectLines(proc: SupervisedProcess): string[] {
  const lines: string[] = []
  proc.onLine((l) => lines.push(l))
  return lines
}

async function until(pred: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('buildAgentEnv', () => {
  const base = {
    HOME: '/h',
    USER: 'u',
    LOGNAME: 'u',
    SHELL: '/bin/zsh',
    TMPDIR: '/t',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'C',
    SSH_AUTH_SOCK: '/s',
    PATH: '/old',
    ANTHROPIC_API_KEY: 'k',
    ANTHROPIC_AUTH_TOKEN: 't',
    ELECTRON_RUN_AS_NODE: '1',
    ELECTRON_NO_ATTACH_CONSOLE: '1',
    NODE_OPTIONS: '--x',
    CLAUDECODE: '1',
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    HARNESS_E2E: '1',
    HARNESS_CLAUDE_BIN: '/x',
    SOME_SECRET: 'nope'
  }

  it('keeps the allowlist and merged PATH, forces TERM and the MCP timeout', () => {
    expect(buildAgentEnv(base, '/merged')).toEqual({
      HOME: '/h',
      USER: 'u',
      LOGNAME: 'u',
      SHELL: '/bin/zsh',
      TMPDIR: '/t',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'C',
      SSH_AUTH_SOCK: '/s',
      PATH: '/merged',
      TERM: 'dumb',
      MCP_TOOL_TIMEOUT: '300000'
    })
  })

  it('passes FAKE_CLAUDE_* through only when HARNESS_E2E=1, and never HARNESS_*', () => {
    const fake = { FAKE_CLAUDE_SCRIPT: 's', FAKE_CLAUDE_LOG: 'l', FAKE_CLAUDE_AUTH: 'a' }
    const on = buildAgentEnv({ ...base, ...fake, HARNESS_E2E: '1' }, '/p')
    expect(on).toMatchObject(fake)
    expect(on).not.toHaveProperty('HARNESS_E2E')
    expect(on).not.toHaveProperty('HARNESS_CLAUDE_BIN')
    const off = buildAgentEnv({ ...base, ...fake, HARNESS_E2E: undefined }, '/p')
    expect(Object.keys(off).filter((k) => k.startsWith('FAKE_CLAUDE_'))).toEqual([])
  })

  it('passes FAKE_CODEX_* through only when HARNESS_E2E=1, and never HARNESS_CODEX_BIN', () => {
    const fake = { FAKE_CODEX_AUTH: 'ok', FAKE_CODEX_VERSION: '0.162.1' }
    const on = buildAgentEnv({ ...base, ...fake, HARNESS_E2E: '1', HARNESS_CODEX_BIN: '/x' }, '/p')
    expect(on).toMatchObject(fake)
    expect(on).not.toHaveProperty('HARNESS_CODEX_BIN')
    const off = buildAgentEnv({ ...base, ...fake, HARNESS_E2E: undefined }, '/p')
    expect(Object.keys(off).filter((k) => k.startsWith('FAKE_CODEX_'))).toEqual([])
  })

  it('passes FAKE_CURSOR_* through only when HARNESS_E2E=1, and never HARNESS_CURSOR_BIN', () => {
    const fake = { FAKE_CURSOR_AUTH: 'ok', FAKE_CURSOR_ABOUT_LATEST: '2026.11.01-abc1234' }
    const on = buildAgentEnv({ ...base, ...fake, HARNESS_E2E: '1', HARNESS_CURSOR_BIN: '/x' }, '/p')
    expect(on).toMatchObject(fake)
    expect(on).not.toHaveProperty('HARNESS_CURSOR_BIN')
    const off = buildAgentEnv({ ...base, ...fake, HARNESS_E2E: undefined }, '/p')
    expect(Object.keys(off).filter((k) => k.startsWith('FAKE_CURSOR_'))).toEqual([])
  })

  it('honors an explicit MCP_TOOL_TIMEOUT and applies extra env last', () => {
    const env = buildAgentEnv({ ...base, MCP_TOOL_TIMEOUT: '1000' }, '/p', { FOO: 'bar' })
    expect(env['MCP_TOOL_TIMEOUT']).toBe('1000')
    expect(env['FOO']).toBe('bar')
  })

  it('a spawned child sees only the allowlisted env', async () => {
    const proc = new ProcessSupervisor().spawn({
      command: process.execPath,
      args: [stub, 'env'],
      cwd: process.cwd(),
      env: {
        ...buildAgentEnv(
          { ...process.env, ANTHROPIC_API_KEY: 'k', NODE_OPTIONS: '--max-old-space-size=64' },
          '/merged/path'
        ),
        ...nodeEnv
      }
    })
    const lines = collectLines(proc)
    await until(() => lines.length > 0)
    const seen = (JSON.parse(lines[0] ?? '{}') as { env: Record<string, string> }).env
    expect(seen['PATH']).toBe('/merged/path')
    expect(seen['MCP_TOOL_TIMEOUT']).toBe('300000')
    expect(seen['TERM']).toBe('dumb')
    expect(seen).not.toHaveProperty('ANTHROPIC_API_KEY')
    expect(seen).not.toHaveProperty('NODE_OPTIONS')
    expect(Object.keys(seen).filter((k) => k.startsWith('HARNESS_'))).toEqual([])
    proc.endStdin()
    expect((await proc.exited).kind).toBe('clean')
  })
})

describe('LineSplitter and StderrRing', () => {
  it('splits across chunks, handles CRLF and a trailing line, skips blanks', () => {
    const lines: string[] = []
    const s = new LineSplitter(
      (l) => lines.push(l),
      () => undefined
    )
    s.push(Buffer.from('{"a":'))
    s.push(Buffer.from('1}\r\n\n{"b":2}\n{"c"'))
    s.push(Buffer.from(':3}'))
    expect(lines).toEqual(['{"a":1}', '{"b":2}'])
    s.flush()
    expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}'])
  })

  it('does not split a multibyte character across chunks', () => {
    const lines: string[] = []
    const s = new LineSplitter(
      (l) => lines.push(l),
      () => undefined
    )
    const bytes = Buffer.from('é\n')
    s.push(bytes.subarray(0, 1))
    s.push(bytes.subarray(1))
    expect(lines).toEqual(['é'])
  })

  it('drops a line over the cap, reports it once, and recovers on the next line', () => {
    const lines: string[] = []
    const overflow: number[] = []
    const s = new LineSplitter(
      (l) => lines.push(l),
      (n) => overflow.push(n),
      10
    )
    s.push(Buffer.from('0123456'))
    s.push(Buffer.from('789012345\nok\n'))
    expect(lines).toEqual(['ok'])
    expect(overflow).toEqual([16])
  })

  it('stderr ring keeps the last bytes', () => {
    const ring = new StderrRing(8)
    ring.push(Buffer.from('abcdef'))
    ring.push(Buffer.from('ghijkl'))
    expect(ring.text()).toBe('efghijkl')
  })

  it('a real child line over 4 MB is dropped and the next line still arrives', async () => {
    const proc = startStub('big-line')
    const lines = collectLines(proc)
    const overflow: number[] = []
    proc.onOverflow((n) => overflow.push(n))
    await until(() => lines.length > 0)
    expect(lines).toEqual(['{"after":true}'])
    expect(overflow).toHaveLength(1)
    expect(overflow[0]).toBeGreaterThan(4 * 1024 * 1024)
    proc.endStdin()
    await proc.exited
  })
})

describe('stderr stream', () => {
  it('hands stderr text to listeners as it arrives', async () => {
    const proc = startStub('exit1')
    let text = ''
    proc.onStderr((t) => (text += t))
    await proc.exited
    expect(text).toContain('boom from stub')
  })
})

describe('exit classification', () => {
  it('exit 1 that we did not cause is a crash, with the stderr tail', async () => {
    const proc = startStub('exit1')
    const info = await proc.exited
    expect(info).toMatchObject({ code: 1, kind: 'crashed', expected: false })
    expect(info.stderrTail).toContain('boom from stub')
  })

  it('a supervisor-initiated kill is stopped, not a crash', async () => {
    const proc = startStub('ignore-all')
    const lines = collectLines(proc)
    await until(() => lines.length > 0)
    expect(proc.kill('SIGKILL')).toBe(true)
    const info = await proc.exited
    expect(info).toMatchObject({ signal: 'SIGKILL', kind: 'stopped', expected: true })
  })

  it('a missing binary is a spawn error classified as a crash', async () => {
    const info = await new ProcessSupervisor().spawn({
      command: '/definitely/not/here',
      args: [],
      cwd: process.cwd(),
      env: {}
    }).exited
    expect(info.spawnError?.code).toBe('ENOENT')
    expect(info.kind).toBe('crashed')
  })

  it('works with an injected fake spawn and kill, and ESRCH is swallowed', async () => {
    const child = new EventEmitter() as EventEmitter & {
      pid: number
      stdin: PassThrough
      stdout: PassThrough
      stderr: PassThrough
    }
    child.pid = 4242
    child.stdin = new PassThrough()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    const kills: [number, string][] = []
    let spawnOptions: Record<string, unknown> = {}
    const supervisor = new ProcessSupervisor({
      spawn: (_c, _a, options) => {
        spawnOptions = options as Record<string, unknown>
        return child as unknown as ChildLike
      },
      kill: (pid, signal) => {
        kills.push([pid, signal])
        throw Object.assign(new Error('gone'), { code: 'ESRCH' })
      }
    })
    const proc = supervisor.spawn({ command: 'x', args: [], cwd: '/', env: {} })
    expect(spawnOptions['detached']).toBe(true)
    const lines = collectLines(proc)
    child.stdout.write('{"a":1}\n')
    await until(() => lines.length === 1)
    expect(proc.kill('SIGTERM')).toBe(false)
    expect(kills).toEqual([[4242, 'SIGTERM']])
    child.stdout.end()
    child.emit('exit', 1, null)
    expect(await proc.exited).toMatchObject({ code: 1, kind: 'stopped' })
    expect(proc.kill('SIGTERM')).toBe(false) // already exited, no second kill
    expect(kills).toHaveLength(1)
  })
})

describe('process group', () => {
  it('killing the group also kills grandchildren', async () => {
    const proc = startStub('grandchild')
    const lines = collectLines(proc)
    await until(() => lines.length > 0)
    const gpid = (JSON.parse(lines[0] ?? '{}') as { gpid: number }).gpid
    expect(alive(gpid)).toBe(true)
    proc.kill('SIGKILL')
    await proc.exited
    await until(() => !alive(gpid))
    expect(alive(gpid)).toBe(false)
  })

  it('killLadder escalates past an ignored SIGTERM to SIGKILL', async () => {
    const proc = startStub('ignore-all')
    const lines = collectLines(proc)
    await until(() => lines.length > 0)
    const info = await proc.killLadder([
      { signal: 'SIGTERM', waitMs: 200 },
      { signal: 'SIGKILL', waitMs: 2000 }
    ])
    expect(info).toMatchObject({ signal: 'SIGKILL', kind: 'stopped' })
  })
})

describe('killAllSync', () => {
  it('signals the whole group of every live process and ignores finished ones', async () => {
    const supervisor = new ProcessSupervisor()
    const proc = startStub('grandchild', supervisor)
    const lines = collectLines(proc)
    await until(() => lines.length > 0)
    const gpid = (JSON.parse(lines[0] ?? '{}') as { gpid: number }).gpid
    expect(alive(gpid)).toBe(true)
    supervisor.killAllSync('SIGTERM')
    await proc.exited
    await until(() => !alive(gpid))
    expect(alive(gpid)).toBe(false)
    expect(() => supervisor.killAllSync('SIGTERM')).not.toThrow()
  })
})
