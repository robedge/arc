import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CommandCatalogue } from '../../../src/main/agents/command-probe'
import type { CommandInfo } from '../../../src/shared/types/commands'
import { useTempDir } from '../helpers/temp-dir'
import { makeEngineRig, until } from './engine-rig'
import type { EngineRig } from './engine-rig'

const dir = useTempDir('arc-plugin-note-')
let e: EngineRig | undefined

afterEach(async () => {
  await e?.close()
  e = undefined
})

const hello: CommandInfo = {
  id: 'claude:' + 'extras:hello',
  provider: 'claude' as const,
  kind: 'command' as const,
  name: 'extras:hello',
  description: 'Says hello',
  source: 'plugin:extras'
}
const bye: CommandInfo = {
  id: 'claude:' + 'extras:bye',
  provider: 'claude',
  kind: 'command',
  name: 'extras:bye',
  description: 'Says bye',
  source: 'plugin:extras'
}

describe('plugin changes and the brain', () => {
  it('queues one combined note for the open session and delivers it once, in front of the next message', async () => {
    let current: CommandInfo[] = []
    const list = vi.fn<CommandCatalogue['list']>(() => Promise.resolve(current))
    e = await makeEngineRig(dir(), { commands: { list } })
    const sessionId = await e.startSession('autonomous')

    current = [hello]
    await e.rig.service.pluginsChanged()
    current = [hello, bye]
    await e.rig.service.pluginsChanged()

    const brain = e.brain()
    const before = brain.sent.length
    await e.rig.service.sendMessage(sessionId, 'what can you do now?')
    await until(() => brain.sent.length > before)
    const message = brain.sent.at(-1) ?? ''
    expect(message).toContain('[Arc] The user changed their plugins')
    expect(message.match(/\[Arc\] The user changed their plugins/g)).toHaveLength(1)
    expect(message).toContain('- /extras:hello')
    expect(message).toContain('- /extras:bye')
    expect(message.endsWith('what can you do now?')).toBe(true)

    // Delivered once: the next message is plain.
    brain.emit({ type: 'turn-result', ok: true, interrupted: false, durationMs: 1 })
    await until(() => e!.rig.service.snapshot(sessionId).brainState === 'idle')
    await e.rig.service.sendMessage(sessionId, 'thanks')
    await until(() => brain.sent.at(-1) === 'thanks')
  })
})
