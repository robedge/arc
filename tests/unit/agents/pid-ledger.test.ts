import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  hashCommand,
  isSameProcess,
  parsePsLine,
  PidLedger,
  readLedgerFile,
  sweepOrphans
} from '../../../src/main/agents/pid-ledger'
import { buildAgentEnv, ProcessSupervisor } from '../../../src/main/agents/process-supervisor'
import { useTempDir } from '../helpers/temp-dir'

const dir = useTempDir()
const stub = resolve('tests/unit/agents/helpers/stub-child.mjs')

function startOrphanCandidate(supervisor: ProcessSupervisor, agentId: string) {
  return supervisor.spawn({
    command: process.execPath,
    args: [stub, 'ignore-all'],
    cwd: process.cwd(),
    env: { ...buildAgentEnv(process.env, process.env['PATH'] ?? ''), ELECTRON_RUN_AS_NODE: '1' },
    agentId
  })
}

describe('parsePsLine', () => {
  it('splits the start time from the command', () => {
    expect(parsePsLine('Sat Oct 17 10:00:00 2026 node /x/y.mjs --flag a b\n')).toEqual({
      startedAt: 'Sat Oct 17 10:00:00 2026',
      command: 'node /x/y.mjs --flag a b'
    })
    expect(parsePsLine('Sat Oct  7 10:00:00 2026 node')?.startedAt).toBe('Sat Oct 7 10:00:00 2026')
    expect(parsePsLine('')).toBeNull()
  })
})

describe('PidLedger', () => {
  it('writes an entry on spawn and removes it on exit', async () => {
    const path = join(dir(), 'run', 'pids.json')
    const ledger = new PidLedger(path)
    const supervisor = new ProcessSupervisor({ ledger })
    const proc = startOrphanCandidate(supervisor, 'agent-1')
    expect(readLedgerFile(path)).toMatchObject([
      { pid: proc.pid, agentId: 'agent-1', startedAt: '' }
    ])
    await ledger.settled()
    const entries = readLedgerFile(path)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      pid: proc.pid,
      pgid: proc.pid,
      agentId: 'agent-1',
      startedAt: expect.stringMatching(/^\w{3} \w{3} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/)
    })
    expect(entries[0]?.cmdHash).toMatch(/^[0-9a-f]{32}$/)
    proc.kill('SIGKILL')
    await proc.exited
    expect(readLedgerFile(path)).toEqual([])
    expect(existsSync(`${path}.${process.pid}.tmp`)).toBe(false)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual([])
  })
})

describe('sweepOrphans', () => {
  it('kills a matching orphan whose owner is gone, then clears the ledger', async () => {
    const path = join(dir(), 'pids.json')
    // "Arc" spawns and records the agent; the new launch below only has the file.
    const ledger = new PidLedger(path)
    const owner = new ProcessSupervisor({ ledger })
    const proc = startOrphanCandidate(owner, 'orphan')
    await ledger.settled() // the stub ignores SIGTERM once it is set up
    const swept = await sweepOrphans(path, { termWaitMs: 300 })
    expect(swept).toEqual([proc.pid])
    const info = await proc.exited
    expect(info.signal).toBe('SIGKILL')
    expect(readLedgerFile(path)).toEqual([])
  })

  it('leaves a recycled pid alone: same pid, different start time or command', async () => {
    const path = join(dir(), 'pids.json')
    const ledger = new PidLedger(path)
    const owner = new ProcessSupervisor({ ledger })
    const decoy = startOrphanCandidate(owner, 'decoy')
    await ledger.settled()
    const real = readLedgerFile(path)[0]!
    // The ledger remembers an older process that had this pid.
    for (const tampered of [
      { ...real, startedAt: 'Mon Jan  1 00:00:00 2001' },
      { ...real, cmdHash: hashCommand('/bin/some-other-program') },
      { ...real, identity: '--mcp-config=/elsewhere/other-agent.json' }
    ]) {
      const fresh = join(
        dir(),
        `tampered-${tampered.startedAt.length}-${tampered.cmdHash}-${tampered.identity.length}.json`
      )
      new PidLedger(fresh)
      await import('node:fs/promises').then((fs) => fs.writeFile(fresh, JSON.stringify([tampered])))
      expect(await sweepOrphans(fresh, { termWaitMs: 100 })).toEqual([])
      await new Promise((r) => setTimeout(r, 500)) // a wrong kill would have landed by now
      expect(decoy.hasExited()).toBe(false)
      expect(() => process.kill(decoy.pid!, 0)).not.toThrow()
      expect(readLedgerFile(fresh)).toEqual([])
    }
    decoy.kill('SIGKILL')
    await decoy.exited
  })

  // A shell that execs node after a pause: ps shows the shell's command line first, then node's.
  function spawnReexec(mcpArg: string): number {
    const child = spawn(
      'sh',
      ['-c', 'sleep 0.6; exec "$0" "$1" ignore-all "$MCP_ARG"', process.execPath, stub],
      {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', MCP_ARG: mcpArg }
      }
    )
    child.unref()
    return child.pid!
  }

  it('still sweeps a child whose command line changed after exec', async () => {
    const path = join(dir(), 'pids.json')
    const ledger = new PidLedger(path, undefined, { intervalMs: 50 })
    const mcpArg = `--mcp-config=${dir()}/mcp/reexec-agent.json`
    const pid = spawnReexec(mcpArg)
    ledger.add(pid, 'reexec-agent', mcpArg)
    await ledger.settled()
    await new Promise((r) => setTimeout(r, 900)) // exec has certainly happened
    // Arc "dies": a new launch has only the file.
    try {
      expect(readLedgerFile(path)[0]?.cmdHash).not.toBe('')
      const swept = await sweepOrphans(path, { termWaitMs: 300 })
      expect(swept).toEqual([pid])
      await new Promise((r) => setTimeout(r, 200))
      expect(() => process.kill(pid, 0)).toThrow()
    } finally {
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {
        // already gone
      }
    }
  })

  it('sweeps an entry that was never fingerprinted by start time and mcp-config argument', async () => {
    const path = join(dir(), 'pids.json')
    const mcpArg = `--mcp-config=${dir()}/mcp/unfilled.json`
    const pid = spawnReexec(mcpArg)
    await new Promise((r) => setTimeout(r, 900)) // exec has happened
    const entry = {
      pid,
      pgid: pid,
      startedAt: '',
      agentId: 'unfilled',
      cmdHash: '',
      spawnedAt: Date.now(),
      identity: mcpArg
    }
    await import('node:fs/promises').then((fs) => fs.writeFile(path, JSON.stringify([entry])))
    try {
      expect(await sweepOrphans(path, { termWaitMs: 300 })).toEqual([pid])
    } finally {
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {
        // already gone
      }
    }
  })

  it('spares an unfilled entry whose pid was recycled (spawn time far from start time)', () => {
    const info = { startedAt: 'Mon Jan 1 00:00:00 2001', command: 'node x --mcp-config=/a.json' }
    const entry = {
      pid: 1,
      pgid: 1,
      startedAt: '',
      agentId: 'a',
      cmdHash: '',
      spawnedAt: Date.now(),
      identity: '--mcp-config=/a.json'
    }
    expect(isSameProcess(entry, info)).toBe(false)
    expect(isSameProcess({ ...entry, spawnedAt: Date.parse(info.startedAt) }, info)).toBe(true)
  })

  it('does nothing with a missing or corrupt ledger', async () => {
    expect(await sweepOrphans(join(dir(), 'nope.json'))).toEqual([])
  })
})
