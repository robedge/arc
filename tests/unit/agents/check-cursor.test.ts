import { describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CLI_MESSAGES,
  CliResolver,
  cursorAuthFromJson,
  cursorAuthFromText,
  cursorLatestFromJson,
  cursorLatestFromText,
  cursorTierFromJson,
  isVersionBelow,
  type ExecFn
} from '../../../src/main/agents/cli-resolver'

const FAKE = join(__dirname, '../../e2e/fixtures/fake-cursor.mjs')
const FIXTURES = join(__dirname, '../../fixtures/cursor/2026.10.19-6bbf2c4')
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8')
const e2e = { PATH: '/p', HARNESS_E2E: '1' }
const VERSION = '2026.10.19-6bbf2c4'

function make(exec: ExecFn, env: NodeJS.ProcessEnv = e2e, isPackaged = false): CliResolver {
  return new CliResolver({ exec, env, isPackaged, home: '/h', now: () => 42 })
}

const notFound = (): Error => Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })
const exitError = (code: number, extra: object = {}): Error =>
  Object.assign(new Error(`exit ${code}`), { code, ...extra })

type Handler = (args: string[]) => Promise<{ stdout: string; stderr?: string }>

/** An exec where each binary name maps to a handler; an unlisted binary is not installed. */
function cursorExec(bins: Record<string, Handler>): ReturnType<typeof vi.fn> & ExecFn {
  return vi.fn((file: string, args: string[]) => {
    const handler = bins[file]
    return handler ? handler(args) : Promise.reject(notFound())
  }) as ReturnType<typeof vi.fn> & ExecFn
}

function cursorCli(
  options: {
    version?: string
    statusJson?: () => Promise<{ stdout: string; stderr?: string }>
    statusText?: () => Promise<{ stdout: string; stderr?: string }>
  } = {}
): Handler {
  return (args) => {
    if (args[0] === '--version')
      return Promise.resolve({ stdout: `${options.version ?? VERSION}\n` })
    if (args[0] === 'status' && args.includes('json')) {
      return (options.statusJson ?? (() => Promise.resolve({ stdout: fixture('status.json') })))()
    }
    if (args[0] === 'status') {
      return (
        options.statusText ??
        (() => Promise.resolve({ stdout: '✓ Logged in as user@example.com\n' }))
      )()
    }
    return Promise.reject(new Error(`unexpected ${args.join(' ')}`))
  }
}

describe('cursorBinary', () => {
  it('honors HARNESS_CURSOR_BIN in dev and in e2e, never when packaged', async () => {
    const exec = cursorExec({ '/fake/cursor': cursorCli() })
    const base = { PATH: '/p', HARNESS_CURSOR_BIN: '/fake/cursor' }
    expect(await make(exec, base, false).cursorBinary()).toBe('/fake/cursor')
    expect(await make(exec, { ...base, HARNESS_E2E: '1' }, true).cursorBinary()).toBe(
      '/fake/cursor'
    )
    const packaged = make(cursorExec({ 'cursor-agent': cursorCli() }), base, true)
    expect(await packaged.cursorBinary()).toBe('cursor-agent')
  })

  it('prefers cursor-agent over agent', async () => {
    const exec = cursorExec({ 'cursor-agent': cursorCli(), agent: cursorCli() })
    expect(await make(exec).cursorBinary()).toBe('cursor-agent')
    expect(exec).not.toHaveBeenCalledWith('agent', expect.anything(), expect.anything())
  })

  it('falls back to agent when its version is Cursor-style', async () => {
    const exec = cursorExec({ agent: cursorCli() })
    expect(await make(exec).cursorBinary()).toBe('agent')
  })

  it('rejects an agent whose version is not Cursor-style', async () => {
    const exec = cursorExec({ agent: cursorCli({ version: '1.4.2' }) })
    expect(await make(exec).cursorBinary()).toBeUndefined()
    expect((await make(exec).checkCursor()).state).toBe('missing')
  })

  it('is undefined when neither is installed', async () => {
    expect(await make(cursorExec({})).cursorBinary()).toBeUndefined()
  })
})

describe('checkCursor', () => {
  it('ok: version from --version, signed in from status --format json', async () => {
    const exec = cursorExec({ 'cursor-agent': cursorCli() })
    expect(await make(exec).checkCursor()).toEqual({
      provider: 'cursor',
      state: 'ok',
      version: VERSION,
      message: '',
      checkedAt: 42
    })
    expect(exec).toHaveBeenCalledWith(
      'cursor-agent',
      ['status', '--format', 'json'],
      expect.objectContaining({ timeout: 10000 })
    )
  })

  it('signed_out from JSON, with the login command', async () => {
    const exec = cursorExec({
      'cursor-agent': cursorCli({
        statusJson: () =>
          Promise.resolve({ stdout: '{"status":"unauthenticated","isAuthenticated":false}' })
      })
    })
    expect(await make(exec).checkCursor()).toEqual({
      provider: 'cursor',
      state: 'signed_out',
      version: VERSION,
      message: CLI_MESSAGES.cursor.signedOut,
      loginCommand: 'agent login',
      checkedAt: 42
    })
  })

  it('falls back to the text form when the JSON form stops at the workspace-trust prompt', async () => {
    const exec = cursorExec({
      'cursor-agent': cursorCli({
        statusJson: () =>
          Promise.reject(exitError(1, { stdout: '\n⚠ Workspace Trust Required\n' })),
        statusText: () => Promise.resolve({ stdout: 'Not logged in\n' })
      })
    })
    const status = await make(exec).checkCursor()
    expect(status.state).toBe('signed_out')
    expect(exec).toHaveBeenCalledWith('cursor-agent', ['status'], expect.anything())
  })

  it('reads a signed-out CLI that exits non-zero but prints its state', async () => {
    const exec = cursorExec({
      'cursor-agent': cursorCli({
        statusJson: () => Promise.reject(exitError(1, { stdout: '{"isAuthenticated":false}' }))
      })
    })
    expect((await make(exec).checkCursor()).state).toBe('signed_out')
  })

  it('missing: neither binary exists, with the install hint', async () => {
    expect(await make(cursorExec({})).checkCursor()).toEqual({
      provider: 'cursor',
      state: 'missing',
      message: CLI_MESSAGES.cursor.missing,
      checkedAt: 42
    })
    expect(CLI_MESSAGES.cursor.missing).toContain('curl https://cursor.com/install -fsS | bash')
  })

  it('unsupported: a version below the minimum, compared by date', async () => {
    const exec = cursorExec({ 'cursor-agent': cursorCli({ version: '2026.06.30-abcdef0' }) })
    const status = await make(exec).checkCursor()
    expect(status).toMatchObject({ state: 'unsupported', version: '2026.06.30-abcdef0' })
    expect(status.message).toBe(CLI_MESSAGES.cursor.unsupported)
    expect(exec).not.toHaveBeenCalledWith('cursor-agent', ['status'], expect.anything())
  })

  it('accepts the minimum itself and a later month', async () => {
    for (const version of ['2026.07.06-abcdef0', '2026.9.1-abcdef0']) {
      const exec = cursorExec({ 'cursor-agent': cursorCli({ version }) })
      expect((await make(exec).checkCursor()).state).toBe('ok')
    }
  })

  it('error: a timeout on --version or on status', async () => {
    const timedOut = Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM' })
    const onVersion = cursorExec({ 'cursor-agent': () => Promise.reject(timedOut) })
    expect((await make(onVersion).checkCursor()).state).toBe('error')

    const onStatus = cursorExec({
      'cursor-agent': cursorCli({
        statusJson: () => Promise.reject(timedOut),
        statusText: () => Promise.reject(timedOut)
      })
    })
    expect(await make(onStatus).checkCursor()).toMatchObject({
      state: 'error',
      version: VERSION,
      message: CLI_MESSAGES.cursor.error
    })
  })

  it('error: status output that says neither', async () => {
    const exec = cursorExec({
      'cursor-agent': cursorCli({
        statusJson: () => Promise.resolve({ stdout: 'garbage' }),
        statusText: () => Promise.resolve({ stdout: 'garbage' })
      })
    })
    expect((await make(exec).checkCursor()).state).toBe('error')
  })
})

describe('parsers over the recorded output', () => {
  it('reads the signed-in status.json', () => {
    expect(cursorAuthFromJson(fixture('status.json'))).toBe(true)
    expect(cursorAuthFromText('✓ Logged in as user@example.com')).toBe(true)
    expect(cursorAuthFromText('Not logged in')).toBe(false)
    expect(cursorAuthFromText('')).toBeUndefined()
    expect(cursorAuthFromJson('not json')).toBeUndefined()
    expect(cursorAuthFromJson('{"status":"unauthenticated"}')).toBe(false)
  })

  it('reads the latest version from the recorded about.json and the text form', () => {
    expect(cursorLatestFromJson(fixture('about.json'))).toBe(VERSION)
    expect(cursorLatestFromJson('{"latestVersion":"2026.11.01-abc1234"}')).toBe(
      '2026.11.01-abc1234'
    )
    expect(cursorLatestFromJson('{}')).toBeUndefined()
    expect(
      cursorLatestFromText(`CLI Version   ${VERSION}\nLatest   2026.11.01-abc1234 (update)\n`)
    ).toBe('2026.11.01-abc1234')
    expect(cursorLatestFromText('nothing')).toBeUndefined()
  })

  it('compares Cursor versions by date', () => {
    expect(isVersionBelow('2026.10.19-6bbf2c4', '2026.07.06')).toBe(false)
    expect(isVersionBelow('2026.06.30-abc', '2026.07.06')).toBe(true)
  })
})

describe('cursorLatestVersion', () => {
  it('asks about --format json', async () => {
    const exec = cursorExec({
      'cursor-agent': (args) =>
        args[0] === 'about' ? Promise.resolve({ stdout: fixture('about.json') }) : cursorCli()(args)
    })
    expect(await make(exec).cursorLatestVersion()).toBe(VERSION)
    expect(exec).toHaveBeenCalledWith(
      'cursor-agent',
      ['about', '--format', 'json'],
      expect.objectContaining({ timeout: 5000 })
    )
  })

  it('is undefined without Cursor or when about fails', async () => {
    expect(await make(cursorExec({})).cursorLatestVersion()).toBeUndefined()
    const exec = cursorExec({
      'cursor-agent': (args) =>
        args[0] === 'about' ? Promise.reject(new Error('boom')) : cursorCli()(args)
    })
    expect(await make(exec).cursorLatestVersion()).toBeUndefined()
  })
})

describe('cursorSubscriptionTier', () => {
  it('reads the subscriptionTier of the recorded about --format json', async () => {
    expect(cursorTierFromJson(fixture('about.json'))).toBe('Free')
    expect(cursorTierFromJson('{"subscriptionTier":"  Pro "}')).toBe('Pro')
    expect(cursorTierFromJson('{"subscriptionTier":""}')).toBeUndefined()
    expect(cursorTierFromJson('{}')).toBeUndefined()
    expect(cursorTierFromJson('not json')).toBeUndefined()
  })

  it('asks about --format json and answers the tier', async () => {
    const exec = cursorExec({
      'cursor-agent': (args) =>
        args[0] === 'about' ? Promise.resolve({ stdout: fixture('about.json') }) : cursorCli()(args)
    })
    expect(await make(exec).cursorSubscriptionTier()).toBe('Free')
    expect(exec).toHaveBeenCalledWith(
      'cursor-agent',
      ['about', '--format', 'json'],
      expect.objectContaining({ timeout: 5000 })
    )
  })

  it('is undefined without Cursor or when about fails', async () => {
    expect(await make(cursorExec({})).cursorSubscriptionTier()).toBeUndefined()
    const exec = cursorExec({
      'cursor-agent': (args) =>
        args[0] === 'about' ? Promise.reject(new Error('boom')) : cursorCli()(args)
    })
    expect(await make(exec).cursorSubscriptionTier()).toBeUndefined()
  })
})

describe('against fake-cursor.mjs', () => {
  const run = async (env: NodeJS.ProcessEnv): Promise<CliResolver> => {
    const exec: ExecFn = (file, args, options) => {
      try {
        const stdout = execFileSync(process.execPath, [file, ...args], {
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...options.env, ...env },
          encoding: 'utf8',
          timeout: 10000
        })
        return Promise.resolve({ stdout })
      } catch (error: unknown) {
        return Promise.reject(error as Error)
      }
    }
    return new CliResolver({
      exec,
      env: { ...e2e, HARNESS_CURSOR_BIN: FAKE },
      isPackaged: true,
      now: () => 42
    })
  }

  it('ok, signed_out, unsupported and an update notice source', async () => {
    expect(await (await run({})).checkCursor()).toMatchObject({ state: 'ok', version: VERSION })
    expect(await (await run({ FAKE_CURSOR_AUTH: 'signed_out' })).checkCursor()).toMatchObject({
      state: 'signed_out',
      loginCommand: 'agent login'
    })
    expect(
      await (await run({ FAKE_CURSOR_VERSION: '2026.01.01-abcdef0' })).checkCursor()
    ).toMatchObject({ state: 'unsupported' })
    expect(
      await (await run({ FAKE_CURSOR_ABOUT_LATEST: '2026.11.01-abc1234' })).cursorLatestVersion()
    ).toBe('2026.11.01-abc1234')
  })

  it('missing when HARNESS_CURSOR_BIN points nowhere', async () => {
    const resolver = new CliResolver({
      exec: () => Promise.reject(notFound()),
      env: { ...e2e, HARNESS_CURSOR_BIN: '/no/such/cursor' },
      isPackaged: true,
      now: () => 42
    })
    expect((await resolver.checkCursor()).state).toBe('missing')
  })
})
