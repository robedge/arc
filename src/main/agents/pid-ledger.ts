import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * `userData/run/pids.json`: one entry per live agent process, so a launch after a crash or a
 * SIGKILL of Arc can find and stop what was left behind. An entry is only ever acted on after
 * `ps` confirms the pid still has the same start time and command line (a reused pid never matches).
 */

export interface LedgerEntry {
  pid: number
  pgid: number
  /**
   * `ps -o lstart=` text, for example "Sat Oct 17 10:00:00 2026". Empty until the process has
   * settled after exec (see `PidLedger.add`); then `spawnedAt` stands in for it.
   */
  startedAt: string
  agentId: string
  /** Hash of the settled command line. Empty until the process has settled. */
  cmdHash: string
  /** Wall-clock ms when Arc spawned the process. */
  spawnedAt: number
  /**
   * The agent's `--mcp-config=<userData>/mcp/<agentId>.json` argument: unique to Arc and the agent,
   * and present on the command line before and after exec. Empty when the agent has none.
   */
  identity: string
}

export interface ProcessInfo {
  startedAt: string
  command: string
}

/** Returns the process's start time and command line, or null when the pid does not exist. */
export type PsFn = (pid: number) => ProcessInfo | null

const PS_LINE = /^\s*(\w{3} \w{3}\s+\d{1,2} \d{2}:\d{2}:\d{2} \d{4})\s+(.+?)\s*$/

export function parsePsLine(text: string): ProcessInfo | null {
  const match = PS_LINE.exec(text.split('\n')[0] ?? '')
  const startedAt = match?.[1]
  const command = match?.[2]
  return startedAt && command ? { startedAt: startedAt.replace(/\s+/g, ' '), command } : null
}

export const defaultPs: PsFn = (pid) => {
  try {
    const out = execFileSync('ps', ['-o', 'lstart=,command=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 2000,
      env: { ...process.env, LC_ALL: 'C' },
      stdio: ['ignore', 'pipe', 'ignore']
    })
    return parsePsLine(out)
  } catch {
    return null
  }
}

export function hashCommand(command: string): string {
  return createHash('sha256').update(command).digest('hex').slice(0, 32)
}

function isEntry(value: unknown): value is LedgerEntry {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    Number.isInteger(v['pid']) &&
    Number.isInteger(v['pgid']) &&
    typeof v['startedAt'] === 'string' &&
    typeof v['agentId'] === 'string' &&
    typeof v['cmdHash'] === 'string' &&
    typeof v['spawnedAt'] === 'number' &&
    typeof v['identity'] === 'string'
  )
}

export function readLedgerFile(path: string): LedgerEntry[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return Array.isArray(parsed) ? parsed.filter(isEntry) : []
  } catch {
    return []
  }
}

function writeAtomic(path: string, entries: readonly LedgerEntry[]): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(entries))
  renameSync(tmp, path)
}

/** How a settling process is re-read: every `intervalMs`, at most `maxReads` times. */
export interface SettleOptions {
  intervalMs?: number
  maxReads?: number
}

export class PidLedger {
  private readonly entries = new Map<number, LedgerEntry>()
  private readonly timers = new Map<number, NodeJS.Timeout>()
  private readonly pending = new Set<Promise<void>>()
  private readonly intervalMs: number
  private readonly maxReads: number

  constructor(
    private readonly path: string,
    private readonly ps: PsFn = defaultPs,
    settle: SettleOptions = {}
  ) {
    this.intervalMs = settle.intervalMs ?? 100
    this.maxReads = settle.maxReads ?? 20
  }

  /**
   * Records a freshly spawned group leader at once (pid, pgid, agent, spawn time, identity), then
   * fills `startedAt` and `cmdHash` when the process has settled: right after spawn the child may
   * still show its pre-exec command line, so `ps` is re-read until the command contains `identity`
   * and stops changing. Best effort: the ledger never blocks a spawn.
   */
  add(pid: number, agentId: string, identity = ''): void {
    try {
      this.entries.set(pid, {
        pid,
        pgid: pid,
        startedAt: '',
        agentId,
        cmdHash: '',
        spawnedAt: Date.now(),
        identity
      })
      this.save()
      this.pending.add(this.settle(pid, identity))
    } catch {
      // A failed write only costs the orphan sweep for this process.
    }
  }

  private settle(pid: number, identity: string): Promise<void> {
    return new Promise<void>((resolve) => {
      let reads = 0
      let last: ProcessInfo | null = null
      const finish = (): void => {
        this.timers.delete(pid)
        resolve()
      }
      const step = (): void => {
        reads += 1
        try {
          const info = this.ps(pid)
          if (!info || !this.entries.has(pid)) return finish()
          const stable = last !== null && last.command === info.command
          const ready = identity === '' || info.command.includes(identity)
          last = info
          if ((stable && ready) || reads >= this.maxReads) {
            const entry = this.entries.get(pid)
            if (entry) {
              this.entries.set(pid, {
                ...entry,
                startedAt: info.startedAt,
                cmdHash: hashCommand(info.command)
              })
              this.save()
            }
            return finish()
          }
        } catch {
          return finish()
        }
        const timer = setTimeout(step, this.intervalMs)
        timer.unref()
        this.timers.set(pid, timer)
      }
      const first = setTimeout(step, 0)
      first.unref()
      this.timers.set(pid, first)
    })
  }

  /** Resolves when every process added so far has been fingerprinted or has gone. */
  async settled(): Promise<void> {
    await Promise.all([...this.pending])
  }

  remove(pid: number): void {
    const timer = this.timers.get(pid)
    if (timer) {
      clearTimeout(timer)
      this.timers.delete(pid)
    }
    if (!this.entries.delete(pid)) return
    try {
      this.save()
    } catch {
      // Same as add.
    }
  }

  private save(): void {
    writeAtomic(this.path, [...this.entries.values()])
  }

  get size(): number {
    return this.entries.size
  }
}

export interface SweepDeps {
  ps?: PsFn
  kill?: (pgid: number, signal: NodeJS.Signals) => void
  /** How long to wait after SIGTERM before SIGKILL. */
  termWaitMs?: number
  pollMs?: number
  warn?: (message: string) => void
}

/** Allowed gap between Arc's spawn time and `ps` start time for an entry never fingerprinted. */
const SPAWN_TOLERANCE_MS = 5000

/**
 * Whether the live process is the one the entry recorded. The start time must agree (a recycled pid
 * starts later), then the identity: the agent's `--mcp-config` argument when it has one, else the
 * settled command hash. An unfilled entry compares `ps` start time with the spawn time instead.
 */
export function isSameProcess(entry: LedgerEntry, info: ProcessInfo): boolean {
  if (entry.startedAt !== '') {
    if (info.startedAt !== entry.startedAt) return false
  } else {
    const started = Date.parse(info.startedAt)
    if (Number.isNaN(started) || Math.abs(started - entry.spawnedAt) > SPAWN_TOLERANCE_MS) {
      return false
    }
  }
  if (entry.identity !== '') return info.command.includes(entry.identity)
  return entry.cmdHash !== '' && hashCommand(info.command) === entry.cmdHash
}

/**
 * Launch-time sweep. Kills the group of each ledger entry whose process still has the recorded
 * start time and command (SIGTERM, then SIGKILL), never one that does not match, then empties the
 * ledger. Returns the pids it killed.
 */
export async function sweepOrphans(path: string, deps: SweepDeps = {}): Promise<number[]> {
  const ps = deps.ps ?? defaultPs
  const kill = deps.kill ?? ((pgid, signal) => process.kill(-pgid, signal))
  const termWaitMs = deps.termWaitMs ?? 2000
  const pollMs = deps.pollMs ?? 25
  const entries = readLedgerFile(path)
  const killed: number[] = []

  const matches = (entry: LedgerEntry): boolean => {
    const info = ps(entry.pid)
    return info !== null && isSameProcess(entry, info)
  }
  const send = (entry: LedgerEntry, signal: NodeJS.Signals): void => {
    try {
      kill(entry.pgid, signal)
    } catch (error: unknown) {
      deps.warn?.(`orphan sweep: could not signal ${entry.pgid}: ${String(error)}`)
    }
  }

  const targets = entries.filter(matches)
  for (const entry of targets) send(entry, 'SIGTERM')
  const deadline = Date.now() + termWaitMs
  let remaining = targets
  while (remaining.length > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs))
    remaining = remaining.filter(matches)
  }
  for (const entry of remaining) send(entry, 'SIGKILL')
  for (const entry of targets) killed.push(entry.pid)

  try {
    writeAtomic(path, [])
  } catch (error: unknown) {
    deps.warn?.(`orphan sweep: could not clear the ledger: ${String(error)}`)
  }
  return killed
}
