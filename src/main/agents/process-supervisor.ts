import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import type { PidLedger } from './pid-ledger'

/**
 * Owns child processes for the agent layer: process group, sanitized env, NDJSON line splitting,
 * a stderr ring, the kill ladder and exit classification.
 */

export const MAX_LINE_BYTES = 4 * 1024 * 1024
export const STDERR_RING_BYTES = 64 * 1024
export const DEFAULT_MCP_TOOL_TIMEOUT = '300000'

const ENV_ALLOW = new Set(['HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'SSH_AUTH_SOCK'])
const STDOUT_DRAIN_MS = 250

/**
 * Builds the child env from an allowlist. `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ELECTRON_*`,
 * `NODE_OPTIONS`, `CLAUDECODE`, `CLAUDE_CODE_*` and `HARNESS_*` are never copied because they are
 * not on the list. `FAKE_CLAUDE_*`, `FAKE_CODEX_*` and `FAKE_CURSOR_*` (fake CLI test fixtures) passes only when the parent env has
 * `HARNESS_E2E=1`. `extra` is applied last and is the caller's explicit choice (bridge token, tests).
 */
export function buildAgentEnv(
  base: NodeJS.ProcessEnv,
  path: string,
  extra: Readonly<Record<string, string>> = {}
): Record<string, string> {
  const env: Record<string, string> = {}
  const isE2e = base['HARNESS_E2E'] === '1'
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue
    if (
      ENV_ALLOW.has(key) ||
      key.startsWith('LC_') ||
      (isE2e &&
        (key.startsWith('FAKE_CLAUDE_') ||
          key.startsWith('FAKE_CODEX_') ||
          key.startsWith('FAKE_CURSOR_')))
    )
      env[key] = value
  }
  env['PATH'] = path
  env['TERM'] = 'dumb'
  env['MCP_TOOL_TIMEOUT'] = base['MCP_TOOL_TIMEOUT'] || DEFAULT_MCP_TOOL_TIMEOUT
  return { ...env, ...extra }
}

/** Splits a byte stream into lines. A line over `maxBytes` is dropped and reported once. */
export class LineSplitter {
  private chunks: Buffer[] = []
  private size = 0
  private discarding = false
  private discardedBytes = 0

  constructor(
    private readonly onLine: (line: string) => void,
    private readonly onOverflow: (bytes: number) => void,
    private readonly maxBytes: number = MAX_LINE_BYTES
  ) {}

  push(chunk: Buffer): void {
    let start = 0
    for (;;) {
      const nl = chunk.indexOf(0x0a, start)
      if (nl === -1) {
        this.append(chunk.subarray(start))
        return
      }
      this.append(chunk.subarray(start, nl))
      this.endLine()
      start = nl + 1
    }
  }

  /** Emits a trailing line that had no newline. */
  flush(): void {
    this.endLine()
  }

  private append(part: Buffer): void {
    if (part.length === 0) return
    if (this.discarding) {
      this.discardedBytes += part.length
      return
    }
    if (this.size + part.length > this.maxBytes) {
      this.discarding = true
      this.discardedBytes = this.size + part.length
      this.chunks = []
      this.size = 0
      return
    }
    this.chunks.push(part)
    this.size += part.length
  }

  private endLine(): void {
    if (this.discarding) {
      this.onOverflow(this.discardedBytes)
    } else if (this.size > 0) {
      const line = Buffer.concat(this.chunks, this.size).toString('utf8').replace(/\r$/, '')
      if (line.trim() !== '') this.onLine(line)
    }
    this.chunks = []
    this.size = 0
    this.discarding = false
    this.discardedBytes = 0
  }
}

/** Keeps the last `maxBytes` of a stream. */
export class StderrRing {
  private buf: Buffer = Buffer.alloc(0)

  constructor(private readonly maxBytes: number = STDERR_RING_BYTES) {}

  push(chunk: Buffer): void {
    const joined = Buffer.concat([this.buf, chunk])
    this.buf =
      joined.length > this.maxBytes ? joined.subarray(joined.length - this.maxBytes) : joined
  }

  text(): string {
    return this.buf.toString('utf8')
  }
}

export type ExitKind = 'clean' | 'stopped' | 'crashed'

export interface ExitInfo {
  code: number | null
  signal: NodeJS.Signals | null
  /** `clean`: exit 0. `stopped`: we sent a signal first. `crashed`: anything else. */
  kind: ExitKind
  /** True for `clean` and `stopped`. */
  expected: boolean
  stderrTail: string
  /** Set when the process never started (for example ENOENT for the binary). */
  spawnError?: NodeJS.ErrnoException
}

export function classifyExit(
  code: number | null,
  signal: NodeJS.Signals | null,
  killRequested: boolean
): ExitKind {
  if (killRequested) return 'stopped'
  if (code === 0 && signal === null) return 'clean'
  return 'crashed'
}

/** The slice of a ChildProcess the supervisor uses, so tests can pass a fake. */
export type ChildLike = Pick<ChildProcess, 'pid' | 'stdin' | 'stdout' | 'stderr' | 'on'>
export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildLike
export type KillFn = (pid: number, signal: NodeJS.Signals) => void

/** Signals the whole process group (negative pid). */
const defaultKill: KillFn = (pid, signal) => {
  process.kill(-pid, signal)
}

export interface SupervisorDeps {
  spawn?: SpawnFn
  /** Receives the group leader pid; the default negates it. */
  kill?: KillFn
  maxLineBytes?: number
  stderrBytes?: number
  /** Records live group leaders so a later launch can sweep orphans. */
  ledger?: Pick<PidLedger, 'add' | 'remove'>
}

export interface SpawnRequest {
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
  /** Written to the pid ledger. */
  agentId?: string
}

export interface LadderStep {
  signal: NodeJS.Signals
  /** How long to wait for the process to exit after sending the signal. */
  waitMs: number
}

export interface SupervisedProcess {
  readonly pid: number | undefined
  readonly exited: Promise<ExitInfo>
  onLine(listener: (line: string) => void): void
  onOverflow(listener: (bytes: number) => void): void
  /** Raw stderr text as it arrives (decoded, so a split multi-byte character stays whole). */
  onStderr(listener: (text: string) => void): void
  /** Writes one line (a newline is added). False when stdin is gone. */
  writeLine(line: string): boolean
  endStdin(): void
  /** Signals the process group. Marks the exit as expected. False when it is already gone. */
  kill(signal: NodeJS.Signals): boolean
  /** Marks the coming exit as expected without signalling (we are closing stdin ourselves). */
  expectExit(): void
  /** Sends each signal in turn until the process exits. Resolves with the exit. */
  killLadder(steps: readonly LadderStep[]): Promise<ExitInfo>
  stderrTail(): string
  hasExited(): boolean
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

export class ProcessSupervisor {
  private readonly spawnFn: SpawnFn
  private readonly killFn: KillFn
  private readonly maxLineBytes: number
  private readonly stderrBytes: number
  private readonly ledger: SupervisorDeps['ledger']
  /** Group leader pids of processes that have not exited yet. */
  private readonly livePids = new Set<number>()

  constructor(deps: SupervisorDeps = {}) {
    this.spawnFn = deps.spawn ?? ((c, a, o) => nodeSpawn(c, a, o))
    this.killFn = deps.kill ?? defaultKill
    this.maxLineBytes = deps.maxLineBytes ?? MAX_LINE_BYTES
    this.stderrBytes = deps.stderrBytes ?? STDERR_RING_BYTES
    this.ledger = deps.ledger
  }

  /** How many agent process groups have not exited yet. */
  get liveCount(): number {
    return this.livePids.size
  }

  /**
   * Synchronous, best-effort: signals the group of every live process and ignores ESRCH.
   * For `will-quit`, where nothing can be awaited. Does not mark exits as expected.
   */
  killAllSync(signal: NodeJS.Signals = 'SIGTERM'): void {
    for (const pid of this.livePids) {
      try {
        this.killFn(pid, signal)
      } catch (error: unknown) {
        if (!isErrno(error, 'ESRCH')) throw error
      }
    }
  }

  spawn(request: SpawnRequest): SupervisedProcess {
    const child = this.spawnFn(request.command, request.args, {
      cwd: request.cwd,
      env: request.env,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })

    const lineListeners: ((line: string) => void)[] = []
    const overflowListeners: ((bytes: number) => void)[] = []
    const stderrListeners: ((text: string) => void)[] = []
    const stderrDecoder = new StringDecoder('utf8')
    const splitter = new LineSplitter(
      (line) => lineListeners.forEach((l) => l(line)),
      (bytes) => overflowListeners.forEach((l) => l(bytes)),
      this.maxLineBytes
    )
    const ring = new StderrRing(this.stderrBytes)
    if (child.pid !== undefined) {
      this.livePids.add(child.pid)
      this.ledger?.add(
        child.pid,
        request.agentId ?? '',
        request.args.find((a) => a.startsWith('--mcp-config=')) ?? ''
      )
    }
    let killRequested = false
    let exitInfo: ExitInfo | undefined
    let stdoutEnded = false
    let onStdoutEnd = (): void => undefined

    child.stdout?.on('data', (chunk: Buffer) => splitter.push(chunk))
    child.stdout?.on('end', () => {
      splitter.flush()
      stdoutEnded = true
      onStdoutEnd()
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      ring.push(chunk)
      const text = stderrDecoder.write(chunk)
      if (text !== '') stderrListeners.forEach((l) => l(text))
    })
    child.stdin?.on('error', () => undefined) // EPIPE after the child exits

    const exited = new Promise<ExitInfo>((resolve) => {
      const finish = (
        code: number | null,
        signal: NodeJS.Signals | null,
        spawnError?: NodeJS.ErrnoException
      ): void => {
        if (exitInfo) return
        const kind = spawnError ? 'crashed' : classifyExit(code, signal, killRequested)
        exitInfo = {
          code,
          signal,
          kind,
          expected: kind !== 'crashed',
          stderrTail: ring.text(),
          ...(spawnError ? { spawnError } : {})
        }
        if (child.pid !== undefined) {
          this.livePids.delete(child.pid)
          this.ledger?.remove(child.pid)
        }
        resolve(exitInfo)
      }
      child.on('error', (error: NodeJS.ErrnoException) => finish(null, null, error))
      child.on('exit', (code, signal) => {
        // Let buffered stdout lines arrive before reporting the exit.
        const settle = (): void => finish(code, signal)
        if (stdoutEnded) return settle()
        const timer = setTimeout(settle, STDOUT_DRAIN_MS)
        onStdoutEnd = () => {
          clearTimeout(timer)
          settle()
        }
      })
    })

    const kill = (signal: NodeJS.Signals): boolean => {
      if (exitInfo || child.pid === undefined) return false
      killRequested = true
      try {
        this.killFn(child.pid, signal)
        return true
      } catch (error: unknown) {
        if (isErrno(error, 'ESRCH')) return false
        throw error
      }
    }

    return {
      pid: child.pid,
      exited,
      onLine: (listener) => void lineListeners.push(listener),
      onOverflow: (listener) => void overflowListeners.push(listener),
      onStderr: (listener) => void stderrListeners.push(listener),
      writeLine(line) {
        const stdin = child.stdin
        if (!stdin || exitInfo || stdin.destroyed || !stdin.writable) return false
        stdin.write(`${line}\n`)
        return true
      },
      endStdin() {
        if (child.stdin && !child.stdin.destroyed) child.stdin.end()
      },
      kill,
      expectExit() {
        killRequested = true
      },
      async killLadder(steps) {
        for (const step of steps) {
          if (!kill(step.signal)) break
          let timer: NodeJS.Timeout | undefined
          const winner = await Promise.race([
            exited,
            new Promise<null>((r) => {
              timer = setTimeout(() => r(null), step.waitMs)
            })
          ])
          clearTimeout(timer)
          if (winner) return winner
        }
        return exited
      },
      stderrTail: () => ring.text(),
      hasExited: () => exitInfo !== undefined
    }
  }
}
