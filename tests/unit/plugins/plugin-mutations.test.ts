import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { PluginService, QUIT_MESSAGE } from '../../../src/main/plugins/plugin-service'
import type { PluginKind, PluginProgress } from '../../../src/shared/types/plugins'
import { useTempDir } from '../helpers/temp-dir'

const dir = useTempDir('arc-plugin-mutations-')

interface Setup {
  service: PluginService
  progress: PluginProgress[]
  changed: PluginKind[]
  /** Writes the fake `claude`; every call appends its arguments to `calls`. */
  script: (body: string) => void
  calls: () => string[]
}

function setup(
  options: {
    onChanged?: (kind: PluginKind) => Promise<void>
    timeouts?: { install?: number; uninstall?: number }
  } = {}
): Setup {
  const root = dir()
  const home = join(root, 'home')
  mkdirSync(join(home, '.claude', 'plugins'), { recursive: true })
  const bin = join(root, 'claude')
  const log = join(root, 'calls.log')
  writeFileSync(log, '')
  const progress: PluginProgress[] = []
  const changed: PluginKind[] = []
  const service = new PluginService({
    resolver: {
      claudeBinary: () => bin,
      resolvePath: () => Promise.resolve(process.env['PATH'] ?? '')
    },
    env: { HOME: home, PATH: process.env['PATH'] ?? '' },
    onProgress: (event) => progress.push(event),
    onChanged: async (kind) => {
      changed.push(kind)
      await options.onChanged?.(kind)
    },
    ...(options.timeouts ? { timeouts: options.timeouts } : {})
  })
  return {
    service,
    progress,
    changed,
    script: (body) => {
      writeFileSync(bin, `#!/bin/sh\necho "$*" >> '${log}'\n${body}\n`)
      chmodSync(bin, 0o755)
    },
    calls: () => readFileSync(log, 'utf8').split('\n').filter(Boolean)
  }
}

async function finished(s: Setup, opId: string): Promise<PluginProgress> {
  await vi.waitFor(() => {
    expect(s.progress.some((p) => p.opId === opId && p.state !== 'running')).toBe(true)
  })
  return s.progress.filter((p) => p.opId === opId).at(-1)!
}

describe('mutation arguments', () => {
  it('builds the CLI command for each change', async () => {
    const s = setup()
    s.script('echo \'{"success":true}\'')
    await finished(s, s.service.install('superpowers', 'official').opId)
    await finished(s, s.service.install('plain').opId)
    await finished(s, s.service.update('a@m').opId)
    await finished(s, s.service.uninstall('a@m').opId)
    await finished(s, s.service.checkUpdates().opId)
    expect(s.calls()).toEqual([
      'plugin install superpowers@official -s user --json -y',
      'plugin install plain -s user --json -y',
      'plugin update a@m -s user --json -y',
      'plugin uninstall a@m -s user --json -y',
      'plugin marketplace update --json'
    ])
  })

  it('reports running, then done, with the kind and target', async () => {
    const s = setup()
    s.script('echo ok')
    const { opId } = s.service.update('a@m')
    await finished(s, opId)
    expect(s.progress).toEqual([
      { opId, kind: 'update', target: 'a@m', state: 'running' },
      { opId, kind: 'update', target: 'a@m', state: 'done' }
    ])
  })
})

describe('one change at a time', () => {
  it('refuses a second change with PLUGIN_BUSY while one runs', async () => {
    const s = setup()
    s.script('sleep 0.3')
    const first = s.service.install('one')
    expect(() => s.service.uninstall('two@m')).toThrowError(
      expect.objectContaining({ code: 'PLUGIN_BUSY' }) as Error
    )
    await finished(s, first.opId)
    // Free again afterwards.
    s.script('echo ok')
    const next = s.service.update('x@m')
    expect((await finished(s, next.opId)).state).toBe('done')
  })

  it('makes list wait for a running change', async () => {
    const s = setup()
    s.script(
      'if [ "$2" = "list" ] || [ "$1 $2" = "plugin list" ]; then echo "[]"; else sleep 0.4; fi'
    )
    const { opId } = s.service.install('slow')
    let listed = false
    const list = s.service.list().then((rows) => {
      listed = true
      return rows
    })
    await new Promise((r) => setTimeout(r, 150))
    expect(listed).toBe(false)
    expect(await list).toEqual([])
    expect(s.progress.some((p) => p.opId === opId && p.state === 'done')).toBe(true)
  })
})

describe('failures', () => {
  it('passes the CLI reason on verbatim', async () => {
    const s = setup()
    s.script(
      'echo \'{"success":false,"error":"Plugin \\"zzz\\" not found in any marketplace"}\'; exit 1'
    )
    const { opId } = s.service.install('zzz')
    const last = await finished(s, opId)
    expect(last).toMatchObject({
      state: 'failed',
      message: 'Plugin "zzz" not found in any marketplace'
    })
    expect(s.changed).toEqual([])
  })

  it('falls back to stderr', async () => {
    const s = setup()
    s.script('echo "network is down" >&2; exit 2')
    expect((await finished(s, s.service.update('a@m').opId)).message).toBe('network is down')
  })

  it('kills the process group on a timeout', async () => {
    const s = setup({ timeouts: { uninstall: 200 } })
    s.script('sleep 30')
    const started = Date.now()
    const last = await finished(s, s.service.uninstall('a@m').opId)
    expect(last.state).toBe('failed')
    expect(last.message).toMatch(/did not finish within/)
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it('cancels the running change on quit and says why', async () => {
    const s = setup()
    s.script('sleep 30')
    const { opId } = s.service.install('long')
    await vi.waitFor(() => expect(s.calls()).toHaveLength(1))
    const started = Date.now()
    await s.service.cancelForQuit()
    expect(Date.now() - started).toBeLessThan(5000)
    expect(s.progress.at(-1)).toMatchObject({ opId, state: 'failed', message: QUIT_MESSAGE })
    expect(s.changed).toEqual([])
    // Nothing left to cancel.
    await s.service.cancelForQuit()
  })
})

describe('after a successful change', () => {
  it('runs onChanged before reporting done, and a failing hook does not fail the change', async () => {
    const order: string[] = []
    const s = setup({
      onChanged: async (kind) => {
        order.push(`changed:${kind}`)
        throw new Error('rebuild broke')
      }
    })
    s.script('echo ok')
    const { opId } = s.service.install('good')
    const last = await finished(s, opId)
    expect(last.state).toBe('done')
    expect(s.changed).toEqual(['install'])
    expect(order).toEqual(['changed:install'])
  })
})
