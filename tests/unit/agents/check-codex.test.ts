import { describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import {
  CLI_MESSAGES,
  CliResolver,
  isVersionBelow,
  type ExecFn
} from '../../../src/main/agents/cli-resolver'

const FAKE = join(__dirname, '../../e2e/fixtures/fake-codex.mjs')
const e2e = { PATH: '/p', HARNESS_E2E: '1' }

function make(exec: ExecFn, env: NodeJS.ProcessEnv = e2e, isPackaged = false): CliResolver {
  return new CliResolver({ exec, env, isPackaged, home: '/h', now: () => 42 })
}

function codexExec(handlers: {
  version?: () => Promise<{ stdout: string }>
  login?: () => Promise<{ stdout: string; stderr?: string }>
}): ReturnType<typeof vi.fn> & ExecFn {
  return vi.fn((_file: string, args: string[]) => {
    if (args[0] === '--version')
      return (handlers.version ?? (() => Promise.resolve({ stdout: 'codex-cli 0.162.1\n' })))()
    return (handlers.login ?? (() => Promise.resolve({ stdout: 'Logged in using ChatGPT\n' })))()
  }) as ReturnType<typeof vi.fn> & ExecFn
}

const exitError = (code: number | string, extra: object = {}): Error =>
  Object.assign(new Error(`exit ${code}`), { code, ...extra })

describe('codexBinary', () => {
  const base = { PATH: '/p', HARNESS_CODEX_BIN: '/fake/codex' }
  it('honors HARNESS_CODEX_BIN in dev and in e2e', () => {
    expect(make(codexExec({}), base, false).codexBinary()).toBe('/fake/codex')
    expect(make(codexExec({}), { ...base, HARNESS_E2E: '1' }, true).codexBinary()).toBe(
      '/fake/codex'
    )
  })
  it('ignores it when packaged without HARNESS_E2E', () => {
    expect(make(codexExec({}), base, true).codexBinary()).toBe('codex')
  })
})

describe('isVersionBelow', () => {
  it('compares major, minor and patch numerically', () => {
    expect(isVersionBelow('0.161.9', '0.162.0')).toBe(true)
    expect(isVersionBelow('0.162.0', '0.162.0')).toBe(false)
    expect(isVersionBelow('0.162.1', '0.162.0')).toBe(false)
    expect(isVersionBelow('0.9.0', '0.162.0')).toBe(true)
    expect(isVersionBelow('1.0.0', '0.162.0')).toBe(false)
  })
})

describe('checkCodex', () => {
  it('ok with a ChatGPT login', async () => {
    const exec = codexExec({})
    expect(await make(exec).checkCodex()).toEqual({
      provider: 'codex',
      state: 'ok',
      version: '0.162.1',
      account: { kind: 'chatgpt' },
      message: '',
      checkedAt: 42
    })
    expect(exec).toHaveBeenCalledWith('codex', ['--version'], expect.anything())
    expect(exec).toHaveBeenCalledWith('codex', ['login', 'status'], expect.anything())
  })

  it('ok with an API key keeps the account kind, reading stderr too', async () => {
    const exec = codexExec({
      login: () => Promise.resolve({ stdout: '', stderr: 'Logged in using an API key\n' })
    })
    const status = await make(exec).checkCodex()
    expect(status.state).toBe('ok')
    expect(status.account).toEqual({ kind: 'api_key' })
  })

  it('ok with an unrecognised login text has account kind unknown', async () => {
    const exec = codexExec({ login: () => Promise.resolve({ stdout: 'Logged in\n' }) })
    expect((await make(exec).checkCodex()).account).toEqual({ kind: 'unknown' })
  })

  it('missing: the binary is not found', async () => {
    const exec = codexExec({ version: () => Promise.reject(exitError('ENOENT')) })
    expect(await make(exec).checkCodex()).toEqual({
      provider: 'codex',
      state: 'missing',
      message: CLI_MESSAGES.codex.missing,
      checkedAt: 42
    })
  })

  it('unsupported: below 0.162.0, without asking for the login', async () => {
    const exec = codexExec({ version: () => Promise.resolve({ stdout: 'codex-cli 0.161.9\n' }) })
    expect(await make(exec).checkCodex()).toEqual({
      provider: 'codex',
      state: 'unsupported',
      version: '0.161.9',
      message: CLI_MESSAGES.codex.unsupported,
      checkedAt: 42
    })
    expect(exec).toHaveBeenCalledTimes(1)
  })

  it('signed_out: login status exits 1, with the login command', async () => {
    const exec = codexExec({
      login: () => Promise.reject(exitError(1, { stdout: 'Not logged in' }))
    })
    expect(await make(exec).checkCodex()).toEqual({
      provider: 'codex',
      state: 'signed_out',
      version: '0.162.1',
      message: CLI_MESSAGES.codex.signedOut,
      loginCommand: 'codex login',
      checkedAt: 42
    })
    expect(CLI_MESSAGES.codex.signedOut).toBe(
      "Codex isn't signed in. Run codex login in Terminal, then click Check again."
    )
  })

  it('error: --version fails or prints no version', async () => {
    const fails = codexExec({ version: () => Promise.reject(exitError(2)) })
    expect((await make(fails).checkCodex()).state).toBe('error')
    const garbage = codexExec({ version: () => Promise.resolve({ stdout: 'hello' }) })
    expect((await make(garbage).checkCodex()).state).toBe('error')
  })

  it('error: login status times out or crashes (not exit 1)', async () => {
    const timeout = codexExec({ login: () => Promise.reject(exitError('ETIMEDOUT')) })
    const status = await make(timeout).checkCodex()
    expect(status).toMatchObject({ state: 'error', version: '0.162.1' })
    const crash = codexExec({ login: () => Promise.reject(exitError(137)) })
    expect((await make(crash).checkCodex()).state).toBe('error')
  })
})

describe('fake-codex.mjs', () => {
  function run(args: string[], env: Record<string, string> = {}): { out: string; code: number } {
    try {
      const out = execFileSync(process.execPath, [FAKE, ...args], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...env },
        encoding: 'utf8'
      })
      return { out, code: 0 }
    } catch (error: unknown) {
      const e = error as { stdout?: string; status?: number }
      return { out: e.stdout ?? '', code: e.status ?? -1 }
    }
  }
  it('prints the version, defaulting to 0.162.1', () => {
    expect(run(['--version']).out).toBe('codex-cli 0.162.1\n')
    expect(run(['--version'], { FAKE_CODEX_VERSION: '0.150.0' }).out).toBe('codex-cli 0.150.0\n')
  })
  it('login status follows FAKE_CODEX_AUTH', () => {
    expect(run(['login', 'status'])).toEqual({ out: 'Logged in using ChatGPT\n', code: 0 })
    expect(run(['login', 'status'], { FAKE_CODEX_AUTH: 'api_key' })).toEqual({
      out: 'Logged in using an API key\n',
      code: 0
    })
    expect(run(['login', 'status'], { FAKE_CODEX_AUTH: 'signed_out' })).toEqual({
      out: 'Not logged in\n',
      code: 1
    })
  })
})
