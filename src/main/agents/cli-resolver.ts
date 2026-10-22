import { execFile } from 'node:child_process'
import { access, constants, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'
import { assertNever } from '@shared/assert-never'
import {
  MIN_CODEX_VERSION,
  MIN_CURSOR_VERSION,
  type ProviderId,
  type ProviderStatus
} from '@shared/types/provider'

const execFileAsync = promisify(execFile)

const SHELL_TIMEOUT_MS = 3000
const VERSION_TIMEOUT_MS = 5000
const AUTH_TIMEOUT_MS = 10000

const PATH_START = '__ARC_PATH_START__'
const PATH_END = '__ARC_PATH_END__'
const STATIC_FALLBACK_DIRS = ['/usr/bin', '/bin', '/usr/sbin', '/sbin']

export const CLI_MESSAGES = {
  claude: {
    missing:
      "Claude Code isn't installed. Install it from claude.com/claude-code, then click Retry.",
    signedOut:
      "Claude Code isn't signed in. Open Terminal, run claude, and sign in, then click Retry.",
    error: "Couldn't check Claude Code. Click Retry. Details are in the logs."
  },
  codex: {
    missing:
      "Codex isn't installed. Install it with npm install -g @openai/codex, then click Check again.",
    signedOut: "Codex isn't signed in. Run codex login in Terminal, then click Check again.",
    unsupported: `This version of Codex is too old. Update Codex to ${MIN_CODEX_VERSION} or newer, then click Check again.`,
    error: "Couldn't check Codex. Click Check again. Details are in the logs."
  },
  cursor: {
    missing:
      "Cursor isn't installed. Install it with curl https://cursor.com/install -fsS | bash, then click Check again.",
    signedOut: "Cursor isn't signed in. Run agent login in Terminal, then click Check again.",
    unsupported: `This version of Cursor is too old. Update Cursor to ${MIN_CURSOR_VERSION} or newer, then click Check again.`,
    error: "Couldn't check Cursor. Click Check again. Details are in the logs."
  }
} as const

export const CLAUDE_LOGIN_COMMAND = 'claude'
export const CODEX_LOGIN_COMMAND = 'codex login'
export const CURSOR_LOGIN_COMMAND = 'agent login'

/** Cursor's version looks like `2026.10.19-6bbf2c4` (date, then a build hash). */
const CURSOR_VERSION_RE = /^\d{4}\.\d+\.\d+(?:-[0-9a-f]+)?/

/** `1.2.3` style version from CLI output such as `codex-cli 0.162.1`. */
function parseVersion(text: string): string | undefined {
  return /\d+\.\d+\.\d+/.exec(text)?.[0]
}

/** True when `version` is older than `min` (both `major.minor.patch`; a `-hash` suffix is ignored). */
export function isVersionBelow(version: string, min: string): boolean {
  const a = (version.split('-')[0] ?? '').split('.').map(Number)
  const b = (min.split('-')[0] ?? '').split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x !== y) return x < y
  }
  return false
}

export interface ExecResult {
  stdout: string
  /** The real exec fills it; the real Codex may print its login state here. */
  stderr?: string
}
export type ExecFn = (
  file: string,
  args: string[],
  options: { timeout: number; env?: NodeJS.ProcessEnv }
) => Promise<ExecResult>

export const defaultExec: ExecFn = async (file, args, options) => {
  const { stdout, stderr } = await execFileAsync(file, args, { ...options, encoding: 'utf8' })
  return { stdout, stderr }
}

export interface CliResolverDeps {
  exec?: ExecFn
  env?: NodeJS.ProcessEnv
  isPackaged: boolean
  home?: string
  now?: () => number
  log?: { warn: (message: string, ...rest: unknown[]) => void }
}

/** Pulls the PATH out from between the sentinels, ignoring rc-file noise around them. */
export function parseSentinelPath(stdout: string): string | null {
  const start = stdout.lastIndexOf(PATH_START)
  if (start === -1) return null
  const from = start + PATH_START.length
  const end = stdout.indexOf(PATH_END, from)
  if (end === -1) return null
  const value = stdout.slice(from, end).trim()
  return value === '' ? null : value
}

function mergePaths(...lists: (string | undefined)[]): string {
  const seen = new Set<string>()
  for (const list of lists) {
    for (const dir of (list ?? '').split(delimiter)) if (dir) seen.add(dir)
  }
  return [...seen].join(delimiter)
}

function stdoutOf(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'stdout' in error) {
    const out = error.stdout
    if (typeof out === 'string') return out
  }
  return undefined
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

/** `true`/`false` from `status --format json`; undefined when the output is not recognisable JSON. */
export function cursorAuthFromJson(text: string): boolean | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const { isAuthenticated, status } = parsed as { isAuthenticated?: unknown; status?: unknown }
  if (typeof isAuthenticated === 'boolean') return isAuthenticated
  if (typeof status === 'string') return status === 'authenticated'
  return undefined
}

/** `true`/`false` from the text of `status`; undefined when it says neither. */
export function cursorAuthFromText(text: string): boolean | undefined {
  if (/not logged in/i.test(text)) return false
  if (/logged in as/i.test(text)) return true
  return undefined
}

/** The `latestVersion` of `about --format json`. */
export function cursorLatestFromJson(text: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(text)
    const latest =
      typeof parsed === 'object' && parsed !== null
        ? (parsed as { latestVersion?: unknown }).latestVersion
        : undefined
    return typeof latest === 'string' ? CURSOR_VERSION_RE.exec(latest)?.[0] : undefined
  } catch {
    return undefined
  }
}

/** The `subscriptionTier` of `about --format json` ("Free", "Pro"...); undefined when absent. */
export function cursorTierFromJson(text: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(text)
    const tier =
      typeof parsed === 'object' && parsed !== null
        ? (parsed as { subscriptionTier?: unknown }).subscriptionTier
        : undefined
    return typeof tier === 'string' && tier.trim() !== '' ? tier.trim() : undefined
  } catch {
    return undefined
  }
}

/** The `Latest   <version> (up to date)` line of `about`. */
export function cursorLatestFromText(text: string): string | undefined {
  return /^\s*Latest\s+(\S+)/m.exec(text)?.[1]?.match(CURSOR_VERSION_RE)?.[0]
}

export class CliResolver {
  private readonly exec: ExecFn
  private readonly env: NodeJS.ProcessEnv
  private readonly isPackaged: boolean
  private readonly home: string
  private readonly now: () => number
  private readonly log: NonNullable<CliResolverDeps['log']>
  private pathPromise: Promise<string> | undefined

  constructor(deps: CliResolverDeps) {
    this.exec = deps.exec ?? defaultExec
    this.env = deps.env ?? process.env
    this.isPackaged = deps.isPackaged
    this.home = deps.home ?? homedir()
    this.now = deps.now ?? Date.now
    this.log = deps.log ?? { warn: () => undefined }
  }

  private get isE2E(): boolean {
    return this.env['HARNESS_E2E'] === '1'
  }

  /** The override is honored only in e2e runs and in dev, never in a packaged app. */
  claudeBinary(): string {
    const override = this.env['HARNESS_CLAUDE_BIN']
    if (override && (this.isE2E || !this.isPackaged)) return override
    return 'claude'
  }

  /** The binary a provider's check runs; undefined when Cursor is not installed. */
  private async binaryFor(provider: ProviderId): Promise<string | undefined> {
    switch (provider) {
      case 'claude':
        return this.claudeBinary()
      case 'codex':
        return this.codexBinary()
      case 'cursor':
        return this.cursorBinary()
      default:
        return assertNever(provider)
    }
  }

  /** `HARNESS_CURSOR_BIN` mirrors the others: e2e runs and dev only. */
  private cursorOverride(): string | undefined {
    const override = this.env['HARNESS_CURSOR_BIN']
    return override && (this.isE2E || !this.isPackaged) ? override : undefined
  }

  /**
   * Finds Cursor's CLI: the override, else `cursor-agent`, else `agent` when its `--version` is
   * Cursor-style (the name is generic). Undefined when neither exists. A failure other than "not
   * found" is thrown.
   */
  private async detectCursor(): Promise<{ bin: string; version: string } | undefined> {
    const path = await this.resolvePath()
    const env = { ...this.env, PATH: path }
    const override = this.cursorOverride()
    for (const bin of override ? [override] : ['cursor-agent', 'agent']) {
      let stdout: string
      try {
        ;({ stdout } = await this.exec(bin, ['--version'], { timeout: VERSION_TIMEOUT_MS, env }))
      } catch (error: unknown) {
        if (isNotFound(error)) continue
        throw error
      }
      const version = CURSOR_VERSION_RE.exec(stdout.trim())?.[0]
      if (version !== undefined) return { bin, version }
      // A bare `agent` that is not Cursor's is somebody else's tool.
      if (bin === 'agent') return undefined
      throw new Error(`${bin} --version had no Cursor version: ${stdout.trim()}`)
    }
    return undefined
  }

  /** The Cursor CLI to run, or undefined when it is not installed (see `detectCursor`). */
  async cursorBinary(): Promise<string | undefined> {
    try {
      return (await this.detectCursor())?.bin
    } catch {
      return this.cursorOverride() ?? 'cursor-agent'
    }
  }

  /** `HARNESS_CODEX_BIN` mirrors `HARNESS_CLAUDE_BIN`: e2e runs and dev only. */
  codexBinary(): string {
    const override = this.env['HARNESS_CODEX_BIN']
    if (override && (this.isE2E || !this.isPackaged)) return override
    return 'codex'
  }

  /** Cached for the process lifetime; `retry()` clears it. Safe to call early and not await. */
  resolvePath(): Promise<string> {
    this.pathPromise ??= this.computePath()
    return this.pathPromise
  }

  private async computePath(): Promise<string> {
    const processPath = this.env['PATH']
    if (this.isE2E) return processPath ?? ''
    const extras = ['/opt/homebrew/bin', '/usr/local/bin', join(this.home, '.local', 'bin')]
    let loginPath: string | null = null
    try {
      const shell = this.env['SHELL'] || '/bin/zsh'
      const script = `printf '%s%s%s' '${PATH_START}' "$PATH" '${PATH_END}'`
      const { stdout } = await this.exec(shell, ['-ilc', script], { timeout: SHELL_TIMEOUT_MS })
      loginPath = parseSentinelPath(stdout)
      if (!loginPath) this.log.warn('login shell printed no PATH between the sentinels')
    } catch (error: unknown) {
      this.log.warn('login shell PATH resolution failed', error)
    }
    return mergePaths(
      loginPath ?? undefined,
      processPath,
      extras.join(delimiter),
      loginPath ? undefined : STATIC_FALLBACK_DIRS.join(delimiter)
    )
  }

  async checkClaude(): Promise<ProviderStatus> {
    const messages = CLI_MESSAGES.claude
    const bin = this.claudeBinary()
    const path = await this.resolvePath()
    const env = { ...this.env, PATH: path }
    const status = (
      state: ProviderStatus['state'],
      message: string,
      version?: string
    ): ProviderStatus => ({
      provider: 'claude',
      state,
      ...(version === undefined ? {} : { version }),
      message,
      ...(state === 'signed_out' ? { loginCommand: CLAUDE_LOGIN_COMMAND } : {}),
      checkedAt: this.now()
    })

    let version: string
    try {
      const { stdout } = await this.exec(bin, ['--version'], { timeout: VERSION_TIMEOUT_MS, env })
      version = stdout.trim().split(/\s+/)[0] ?? ''
    } catch (error: unknown) {
      if (isNotFound(error)) return status('missing', messages.missing)
      this.log.warn('claude --version failed', error)
      return status('error', messages.error)
    }

    let raw: string | undefined
    try {
      raw = (await this.exec(bin, ['auth', 'status', '--json'], { timeout: AUTH_TIMEOUT_MS, env }))
        .stdout
    } catch (error: unknown) {
      // The exit code is not reliable here; a non-zero exit may still carry the JSON.
      raw = stdoutOf(error)
      if (raw === undefined || raw.trim() === '') {
        this.log.warn('claude auth status failed', error)
        return status('error', messages.error, version)
      }
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error: unknown) {
      this.log.warn('claude auth status output was not JSON', error)
      return status('error', messages.error, version)
    }
    const loggedIn =
      typeof parsed === 'object' && parsed !== null && 'loggedIn' in parsed
        ? parsed.loggedIn
        : undefined
    if (loggedIn === true) return status('ok', '', version)
    return status('signed_out', messages.signedOut, version)
  }

  /** `codex --version`, the minimum-version gate, then `codex login status`. Never a model call. */
  async checkCodex(): Promise<ProviderStatus> {
    const messages = CLI_MESSAGES.codex
    const bin = this.codexBinary()
    const path = await this.resolvePath()
    const env = { ...this.env, PATH: path }
    const status = (
      state: ProviderStatus['state'],
      message: string,
      extra: Partial<Pick<ProviderStatus, 'version' | 'account'>> = {}
    ): ProviderStatus => ({
      provider: 'codex',
      state,
      ...extra,
      message,
      ...(state === 'signed_out' ? { loginCommand: CODEX_LOGIN_COMMAND } : {}),
      checkedAt: this.now()
    })

    let version: string
    try {
      const { stdout } = await this.exec(bin, ['--version'], { timeout: VERSION_TIMEOUT_MS, env })
      const parsed = parseVersion(stdout)
      if (!parsed) {
        this.log.warn('codex --version output had no version', stdout)
        return status('error', messages.error)
      }
      version = parsed
    } catch (error: unknown) {
      if (isNotFound(error)) return status('missing', messages.missing)
      this.log.warn('codex --version failed', error)
      return status('error', messages.error)
    }
    if (isVersionBelow(version, MIN_CODEX_VERSION)) {
      return status('unsupported', messages.unsupported, { version })
    }

    try {
      const { stdout, stderr } = await this.exec(bin, ['login', 'status'], {
        timeout: AUTH_TIMEOUT_MS,
        env
      })
      const text = `${stdout}\n${stderr ?? ''}`.toLowerCase()
      const kind = text.includes('api key')
        ? 'api_key'
        : text.includes('chatgpt')
          ? 'chatgpt'
          : 'unknown'
      return status('ok', '', { version, account: { kind } })
    } catch (error: unknown) {
      // Exit 1 is "not logged in"; a timeout or a crash is an error, not a sign-out.
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 1) {
        return status('signed_out', messages.signedOut, { version })
      }
      this.log.warn('codex login status failed', error)
      return status('error', messages.error, { version })
    }
  }

  /** `--version`, the minimum-version gate, then `status --format json` (text as the fallback). No model call. */
  async checkCursor(): Promise<ProviderStatus> {
    const messages = CLI_MESSAGES.cursor
    const status = (
      state: ProviderStatus['state'],
      message: string,
      version?: string
    ): ProviderStatus => ({
      provider: 'cursor',
      state,
      ...(version === undefined ? {} : { version }),
      message,
      ...(state === 'signed_out' ? { loginCommand: CURSOR_LOGIN_COMMAND } : {}),
      checkedAt: this.now()
    })

    let found: { bin: string; version: string } | undefined
    try {
      found = await this.detectCursor()
    } catch (error: unknown) {
      this.log.warn('cursor --version failed', error)
      return status('error', messages.error)
    }
    if (!found) return status('missing', messages.missing)
    const { bin, version } = found
    if (isVersionBelow(version, MIN_CURSOR_VERSION)) {
      return status('unsupported', messages.unsupported, version)
    }

    const env = { ...this.env, PATH: await this.resolvePath() }
    const run = async (args: string[]): Promise<string | undefined> => {
      try {
        const { stdout, stderr } = await this.exec(bin, args, { timeout: AUTH_TIMEOUT_MS, env })
        return `${stdout}\n${stderr ?? ''}`
      } catch (error: unknown) {
        // A signed-out CLI may exit non-zero and still print its state.
        const out = stdoutOf(error)
        if (out !== undefined && out.trim() !== '') return out
        this.log.warn(`cursor ${args.join(' ')} failed`, error)
        return undefined
      }
    }
    // The JSON form can stop at a workspace-trust prompt when run in an untrusted folder; the text form never does.
    const json = await run(['status', '--format', 'json'])
    const fromJson = json === undefined ? undefined : cursorAuthFromJson(json)
    const signedIn = fromJson ?? cursorAuthFromText((await run(['status'])) ?? '')
    if (signedIn === undefined) return status('error', messages.error, version)
    return signedIn ? status('ok', '', version) : status('signed_out', messages.signedOut, version)
  }

  /** The newest Cursor version, from `about --format json` (text as the fallback); undefined when unknown. */
  async cursorLatestVersion(): Promise<string | undefined> {
    try {
      const found = await this.detectCursor()
      if (!found) return undefined
      const env = { ...this.env, PATH: await this.resolvePath() }
      const run = async (args: string[]): Promise<string> => {
        try {
          return (await this.exec(found.bin, args, { timeout: VERSION_TIMEOUT_MS, env })).stdout
        } catch (error: unknown) {
          return stdoutOf(error) ?? ''
        }
      }
      return (
        cursorLatestFromJson(await run(['about', '--format', 'json'])) ??
        cursorLatestFromText(await run(['about']))
      )
    } catch (error: unknown) {
      this.log.warn('cursor about failed', error)
      return undefined
    }
  }

  /** The Cursor subscription tier, from `about --format json`; undefined when unknown. */
  async cursorSubscriptionTier(): Promise<string | undefined> {
    try {
      const found = await this.detectCursor()
      if (!found) return undefined
      const env = { ...this.env, PATH: await this.resolvePath() }
      const { stdout } = await this.exec(found.bin, ['about', '--format', 'json'], {
        timeout: VERSION_TIMEOUT_MS,
        env
      })
      return cursorTierFromJson(stdout)
    } catch (error: unknown) {
      const out = stdoutOf(error)
      if (out !== undefined) return cursorTierFromJson(out)
      this.log.warn('cursor about failed', error)
      return undefined
    }
  }

  /**
   * Where the provider's binary really is (symlinks resolved), searching the login-shell PATH, or
   * undefined when it is not found. Used to tell a Homebrew install from the tool's own installer.
   */
  async locateBinary(provider: ProviderId): Promise<string | undefined> {
    const bin = await this.binaryFor(provider)
    if (bin === undefined) return undefined
    const candidates = bin.includes('/')
      ? [bin]
      : (await this.resolvePath()).split(delimiter).map((dir) => join(dir, bin))
    for (const candidate of candidates) {
      try {
        await access(candidate, constants.X_OK)
        return await realpath(candidate)
      } catch {
        // Not here; try the next directory.
      }
    }
    return undefined
  }

  /** Forget the cached login-shell PATH so the next check resolves it again. */
  resetPath(): void {
    this.pathPromise = undefined
  }

  /** Forget the cached PATH and check Claude again. */
  retry(): Promise<ProviderStatus> {
    this.resetPath()
    return this.checkClaude()
  }
}
