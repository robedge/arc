import { describe, expect, it, vi } from 'vitest'
import {
  CLI_MESSAGES,
  CliResolver,
  parseSentinelPath,
  type ExecFn
} from '../../../src/main/agents/cli-resolver'

const S = '__ARC_PATH_START__'
const E = '__ARC_PATH_END__'

function make(
  exec: ExecFn,
  env: NodeJS.ProcessEnv = { PATH: '/proc/bin', SHELL: '/bin/zsh' },
  isPackaged = false
): CliResolver {
  return new CliResolver({ exec, env, isPackaged, home: '/home/u', now: () => 1000 })
}

/** Routes by argv: shell call, --version, auth status. */
function fakeExec(handlers: {
  shell?: () => Promise<{ stdout: string }>
  version?: () => Promise<{ stdout: string }>
  auth?: () => Promise<{ stdout: string }>
}): ReturnType<typeof vi.fn> & ExecFn {
  return vi.fn((file: string, args: string[]) => {
    if (args[0] === '-ilc') return (handlers.shell ?? (() => Promise.reject(new Error('x'))))()
    if (args[0] === '--version')
      return (handlers.version ?? (() => Promise.resolve({ stdout: '2.1.302 (Claude Code)\n' })))()
    return (handlers.auth ?? (() => Promise.resolve({ stdout: '{"loggedIn":true}' })))()
  }) as ReturnType<typeof vi.fn> & ExecFn
}

describe('parseSentinelPath', () => {
  it('extracts the PATH and ignores rc-file noise', () => {
    expect(parseSentinelPath(`motd\nnvm loaded\n${S}/a:/b${E}\ntrailing`)).toBe('/a:/b')
  })
  it('returns null without sentinels or with an empty value', () => {
    expect(parseSentinelPath('/a:/b')).toBeNull()
    expect(parseSentinelPath(`${S}${E}`)).toBeNull()
    expect(parseSentinelPath(`${S}/a`)).toBeNull()
  })
})

describe('resolvePath', () => {
  it('merges login PATH, process PATH and the extra dirs without duplicates', async () => {
    const exec = fakeExec({
      shell: () => Promise.resolve({ stdout: `noise${S}/login/bin:/proc/bin${E}` })
    })
    const path = await make(exec).resolvePath()
    expect(path.split(':')).toEqual([
      '/login/bin',
      '/proc/bin',
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/home/u/.local/bin'
    ])
    expect(exec.mock.calls[0]?.[2]).toMatchObject({ timeout: 3000 })
    expect(exec.mock.calls[0]?.[1][0]).toBe('-ilc')
  })

  it('falls back to process PATH, extras and static dirs when the shell fails', async () => {
    const exec = fakeExec({ shell: () => Promise.reject(new Error('timed out')) })
    const path = await make(exec).resolvePath()
    expect(path.split(':')).toEqual([
      '/proc/bin',
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/home/u/.local/bin',
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin'
    ])
  })

  it('caches for the process lifetime and re-runs on retry', async () => {
    const exec = fakeExec({ shell: () => Promise.resolve({ stdout: `${S}/x${E}` }) })
    const resolver = make(exec)
    await resolver.resolvePath()
    await resolver.resolvePath()
    const shellCalls = (): number => exec.mock.calls.filter((c) => c[1][0] === '-ilc').length
    expect(shellCalls()).toBe(1)
    await resolver.retry()
    expect(shellCalls()).toBe(2)
  })

  it('skips the login shell under HARNESS_E2E=1 and uses the test PATH', async () => {
    const exec = fakeExec({})
    const path = await make(exec, { PATH: '/test/bin', HARNESS_E2E: '1' }).resolvePath()
    expect(path).toBe('/test/bin')
    expect(exec).not.toHaveBeenCalled()
  })
})

describe('HARNESS_CLAUDE_BIN override', () => {
  const base = { PATH: '/p', HARNESS_CLAUDE_BIN: '/fake/claude' }
  it('is honored in dev', () => {
    expect(make(fakeExec({}), base, false).claudeBinary()).toBe('/fake/claude')
  })
  it('is honored when packaged but HARNESS_E2E=1', () => {
    expect(make(fakeExec({}), { ...base, HARNESS_E2E: '1' }, true).claudeBinary()).toBe(
      '/fake/claude'
    )
  })
  it('is ignored when packaged without HARNESS_E2E', () => {
    expect(make(fakeExec({}), base, true).claudeBinary()).toBe('claude')
  })
})

describe('checkClaude', () => {
  const e2e = { PATH: '/p', HARNESS_E2E: '1' }

  it('ok: includes the version and an empty message', async () => {
    const exec = fakeExec({})
    const status = await make(exec, e2e).checkClaude()
    expect(status).toEqual({
      provider: 'claude',
      state: 'ok',
      version: '2.1.302',
      message: '',
      checkedAt: 1000
    })
    expect(exec).toHaveBeenCalledWith(
      'claude',
      ['--version'],
      expect.objectContaining({ timeout: 5000 })
    )
    expect(exec).toHaveBeenCalledWith(
      'claude',
      ['auth', 'status', '--json'],
      expect.objectContaining({ timeout: 10000 })
    )
  })

  it('missing: binary not found', async () => {
    const exec = fakeExec({
      version: () =>
        Promise.reject(Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }))
    })
    expect(await make(exec, e2e).checkClaude()).toEqual({
      provider: 'claude',
      checkedAt: 1000,
      state: 'missing',
      message: CLI_MESSAGES.claude.missing
    })
  })

  it('error: --version fails', async () => {
    const exec = fakeExec({ version: () => Promise.reject(new Error('exit 1')) })
    expect(await make(exec, e2e).checkClaude()).toEqual({
      provider: 'claude',
      checkedAt: 1000,
      state: 'error',
      message: CLI_MESSAGES.claude.error
    })
  })

  it('signed_out: loggedIn false, even when the exit code is non-zero', async () => {
    const exec = fakeExec({
      auth: () =>
        Promise.reject(Object.assign(new Error('exit 1'), { stdout: '{"loggedIn":false}' }))
    })
    expect(await make(exec, e2e).checkClaude()).toEqual({
      provider: 'claude',
      checkedAt: 1000,
      loginCommand: 'claude',
      state: 'signed_out',
      version: '2.1.302',
      message: CLI_MESSAGES.claude.signedOut
    })
  })

  it('error: unparsable auth JSON, and auth failure without output', async () => {
    const bad = fakeExec({ auth: () => Promise.resolve({ stdout: 'not json' }) })
    expect((await make(bad, e2e).checkClaude()).state).toBe('error')
    const timeout = fakeExec({ auth: () => Promise.reject(new Error('timed out')) })
    expect((await make(timeout, e2e).checkClaude()).state).toBe('error')
  })

  it('passes the merged PATH to the claude calls', async () => {
    const exec = fakeExec({ shell: () => Promise.resolve({ stdout: `${S}/login${E}` }) })
    await make(exec).checkClaude()
    const versionCall = exec.mock.calls.find((c) => c[1][0] === '--version')
    expect(versionCall?.[2].env?.['PATH']).toContain('/login')
  })
})
