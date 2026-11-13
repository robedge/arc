import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { messageWorkerTool } from '../../../src/main/bridge/tools/message-worker'
import { spawnWorkerTool } from '../../../src/main/bridge/tools/spawn-worker'
import type {
  BridgeCallContext,
  BridgeServices,
  SpawnWorkerResult
} from '../../../src/main/bridge/types'

const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `att${i}`)
const schemaOf = (tool: { inputShape: z.ZodRawShape }) => z.object(tool.inputShape)

const spawnBase = { name: 'w', task: 't', repos: ['api'] }
const messageBase = { workerId: 'W1', text: 'hi' }

describe.each([
  ['spawn_worker', spawnWorkerTool, spawnBase],
  ['message_worker', messageWorkerTool, messageBase]
])('%s attachments field', (_name, tool, base) => {
  const schema = schemaOf(tool)

  it('is optional', () => {
    expect(schema.safeParse(base).success).toBe(true)
  })

  it('takes up to 10 ids', () => {
    expect(schema.safeParse({ ...base, attachments: ids(10) }).success).toBe(true)
  })

  it('rejects 11 ids', () => {
    expect(schema.safeParse({ ...base, attachments: ids(11) }).success).toBe(false)
  })

  it('rejects duplicate ids', () => {
    expect(schema.safeParse({ ...base, attachments: ['a', 'a'] }).success).toBe(false)
  })

  it('rejects an empty id', () => {
    expect(schema.safeParse({ ...base, attachments: [''] }).success).toBe(false)
  })

  it('is described in plain words, with where the ids come from', () => {
    const description = (schema.shape as Record<string, z.ZodType>)['attachments']?.description
    expect(description).toContain('[Attachments for this message]')
    expect(description).toContain('At most 10')
  })
})

describe('the tools pass the ids on', () => {
  const ctxWith = (services: Partial<BridgeServices>): BridgeCallContext => ({
    agent: { sessionId: 's', agentId: 'brain', role: 'brain' },
    services: services as BridgeServices,
    signal: new AbortController().signal
  })

  it('spawn_worker hands attachments to the service', async () => {
    const spawnWorker = vi.fn(() => Promise.resolve({} as SpawnWorkerResult))
    await spawnWorkerTool.run({ ...spawnBase, attachments: ['a', 'b'] }, ctxWith({ spawnWorker }))
    expect(spawnWorker).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ attachments: ['a', 'b'] })
    )
  })

  it('message_worker hands attachments to the service', async () => {
    const messageWorker = vi.fn(() => Promise.resolve({ delivered: true }))
    await messageWorkerTool.run({ ...messageBase, attachments: ['a'] }, ctxWith({ messageWorker }))
    expect(messageWorker).toHaveBeenCalledWith(expect.anything(), {
      workerId: 'W1',
      text: 'hi',
      attachments: ['a']
    })
  })
})
