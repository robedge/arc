import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { useTempDir } from '../helpers/temp-dir'
import { makeEngineRig, until } from './engine-rig'
import type { EngineRig } from './engine-rig'

const dir = useTempDir('arc-wterm-')
let e: EngineRig | undefined

afterEach(async () => {
  await e?.close()
  e = undefined
})

describe('worker terminal (workers:open-terminal and worker:terminal)', () => {
  it('streams a live worker, then serves the whole log once it finished, and deletes it with the session', async () => {
    e = await makeEngineRig(dir())
    const sessionId = await e.startSession('autonomous')
    const spawned = await e.call(e.brain(), 'spawn_worker', {
      name: 'one',
      task: 'Do one',
      repos: ['api'],
      model: 'sonnet'
    })
    const workerId = String(spawned.value['workerId'])
    const handle = e.workerHandle()
    const pushedText = (): string =>
      e!.rig
        .of('worker:terminal')
        .filter((p) => p.workerId === workerId)
        .map((p) => p.text)
        .join('')

    handle.emit({ type: 'session', providerSessionId: 'p1', model: 'sonnet', mcpServers: [] })
    handle.emit({ type: 'assistant-message', messageId: 'm1', text: 'Looking around.' })
    handle.emit({ type: 'tool-use', toolUseId: 't1', name: 'Bash', summary: 'Bash: pnpm test' })
    handle.emit({ type: 'stderr', text: 'warn: slow\n' })
    await until(() => pushedText().includes('stderr │ warn: slow'))

    const live = await e.rig.service.openTerminal(workerId)
    expect(live.backlog).toContain('── Working ──')
    expect(live.backlog).toContain('Looking around.\n▸ Bash  pnpm test\nstderr │ warn: slow\n')
    const seqs = e.rig.of('worker:terminal').map((p) => p.seq)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    expect(live.seq).toBe(Math.max(...seqs))
    expect(pushedText()).toBe(live.backlog)

    // Later chunks have a higher seq than the backlog.
    handle.emit({ type: 'assistant-message', messageId: 'm2', text: 'More.' })
    await until(() => pushedText().endsWith('More.\n'))
    expect(e.rig.of('worker:terminal').at(-1)?.seq).toBeGreaterThan(live.seq)

    handle.emit({
      type: 'tool-use',
      toolUseId: 't2',
      name: 'mcp__arc__report_done',
      summary: 'mcp__arc__report_done: All done'
    })
    await e.call(handle, 'report_done', { summary: 'All done' })
    handle.emit({ type: 'turn-result', ok: true, interrupted: false, durationMs: 1 })
    await until(() => e!.rig.deps.workersRepo.get(workerId)?.status === 'done')
    handle.emit({ type: 'exit', code: 0, signal: null, expected: true, stderrTail: '' })
    handle.queue.close()
    await until(() => pushedText().includes('── Done ──'))

    const finished = await e.rig.service.openTerminal(workerId)
    const file = join(e.rig.work, 'userData', 'sessions', sessionId, 'workers', `${workerId}.log`)
    expect(finished.backlog).toBe(readFileSync(file, 'utf8'))
    expect(finished.backlog).toContain('Looking around.')
    expect(finished.backlog).toContain('✓ Done: All done')
    expect(finished.backlog.trimEnd().endsWith('── Done ──')).toBe(true)
    expect(finished.truncated).toBe(false)

    await e.rig.service.delete(sessionId)
    expect(existsSync(file)).toBe(false)
  })
})
