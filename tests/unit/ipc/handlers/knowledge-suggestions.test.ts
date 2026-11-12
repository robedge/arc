import { beforeEach, describe, expect, it, vi } from 'vitest'
import { channelSchemas } from '../../../../src/shared/ipc/contract'
import { call, type Captured } from './capture'
import type { AppServices } from '../../../../src/main/app/app-services'

const captured = vi.hoisted<Captured>(() => new Map())
vi.mock('../../../../src/main/ipc/register', async () => {
  const { registerMock } = await import('./capture')
  return registerMock(captured)
})

async function register(knowledgeSuggestions: unknown): Promise<void> {
  const { registerKnowledgeSuggestionHandlers } =
    await import('../../../../src/main/ipc/handlers/knowledge-suggestions')
  registerKnowledgeSuggestionHandlers({ knowledgeSuggestions } as unknown as AppServices)
}

describe('knowledge-suggestions handlers', () => {
  beforeEach(() => captured.clear())

  it('list returns the waiting suggestions of the session', async () => {
    const listWaiting = vi.fn(() => ['view'])
    await register({ listWaiting, discard: vi.fn() })
    expect(await call(captured, 'knowledge-suggestions:list', { sessionId: 's1' })).toEqual([
      'view'
    ])
    expect(listWaiting).toHaveBeenCalledWith('s1')
  })

  it('discard discards the suggestion', async () => {
    const discard = vi.fn()
    await register({ listWaiting: vi.fn(), discard })
    await call(captured, 'knowledge-suggestions:discard', { id: 'k1' })
    expect(discard).toHaveBeenCalledWith('k1')
  })

  it('accept returns the outcome', async () => {
    const outcome = {
      groupId: 'g',
      sectionId: 's',
      sectionName: 'Notes',
      itemId: 'i',
      name: 'a.md',
      edited: false
    }
    const accept = vi.fn(async () => outcome)
    await register({ accept })
    expect(await call(captured, 'knowledge-suggestions:accept', { id: 'k1' })).toEqual(outcome)
    expect(accept).toHaveBeenCalledWith('k1', undefined)
  })

  it('accept passes edits through and rejects unknown fields', async () => {
    const accept = vi.fn(async () => ({}))
    await register({ accept })
    await call(captured, 'knowledge-suggestions:accept', {
      id: 'k1',
      edits: { text: 't', name: 'n' }
    })
    expect(accept).toHaveBeenCalledWith('k1', { text: 't', name: 'n' })
    const schema = channelSchemas['knowledge-suggestions:accept']
    expect(schema.safeParse({}).success).toBe(false)
    expect(schema.safeParse({ id: 'k', x: 1 }).success).toBe(false)
    expect(schema.safeParse({ id: 'k', edits: { text: 1 } }).success).toBe(false)
    expect(schema.safeParse({ id: 'k', edits: { y: 'a' } }).success).toBe(false)
  })

  it('the request schemas are strict', () => {
    expect(
      channelSchemas['knowledge-suggestions:list'].safeParse({ sessionId: 's', x: 1 }).success
    ).toBe(false)
    expect(channelSchemas['knowledge-suggestions:list'].safeParse({}).success).toBe(false)
    expect(channelSchemas['knowledge-suggestions:discard'].safeParse({ id: 'k' }).success).toBe(
      true
    )
    expect(
      channelSchemas['knowledge-suggestions:discard'].safeParse({ id: 'k', y: 1 }).success
    ).toBe(false)
  })

  it('current returns the target text and its request is strict', async () => {
    const current = vi.fn(async () => ({ text: 'now' }))
    await register({ current })
    expect(await call(captured, 'knowledge-suggestions:current', { id: 'k1' })).toEqual({
      text: 'now'
    })
    expect(current).toHaveBeenCalledWith('k1')
    const schema = channelSchemas['knowledge-suggestions:current']
    expect(schema.safeParse({ id: 'k' }).success).toBe(true)
    expect(schema.safeParse({}).success).toBe(false)
    expect(schema.safeParse({ id: 'k', x: 1 }).success).toBe(false)
  })

  it('result-text returns the full proposed text and its request is strict', async () => {
    const resultText = vi.fn(async () => ({ text: 'full' }))
    await register({ resultText })
    expect(await call(captured, 'knowledge-suggestions:result-text', { id: 'k1' })).toEqual({
      text: 'full'
    })
    expect(resultText).toHaveBeenCalledWith('k1')
    const schema = channelSchemas['knowledge-suggestions:result-text']
    expect(schema.safeParse({ id: 'k' }).success).toBe(true)
    expect(schema.safeParse({}).success).toBe(false)
    expect(schema.safeParse({ id: 'k', x: 1 }).success).toBe(false)
  })

  it('accept edits are bounded', () => {
    const schema = channelSchemas['knowledge-suggestions:accept']
    expect(schema.safeParse({ id: 'k', edits: { name: 'n'.repeat(80) } }).success).toBe(true)
    expect(schema.safeParse({ id: 'k', edits: { name: 'n'.repeat(81) } }).success).toBe(false)
    expect(schema.safeParse({ id: 'k', edits: { name: '' } }).success).toBe(false)
    expect(
      schema.safeParse({ id: 'k', edits: { text: 't'.repeat(20 * 1024 * 1024) } }).success
    ).toBe(true)
    expect(
      schema.safeParse({ id: 'k', edits: { text: 't'.repeat(20 * 1024 * 1024 + 1) } }).success
    ).toBe(false)
    expect(schema.safeParse({ id: 'k', edits: { sectionId: '' } }).success).toBe(false)
  })

  it('accept-all returns per-item outcomes and serialised errors', async () => {
    const outcome = {
      groupId: 'g',
      sectionId: 's',
      sectionName: 'Notes',
      itemId: 'i',
      name: 'a.md',
      edited: false
    }
    const results = [
      { id: 'k1', outcome },
      { id: 'k2', error: { code: 'ITEM_NAME_TAKEN' } }
    ]
    const acceptAll = vi.fn(async () => ({ results }))
    await register({ acceptAll })
    expect(await call(captured, 'knowledge-suggestions:accept-all', { sessionId: 's1' })).toEqual({
      results
    })
    expect(acceptAll).toHaveBeenCalledWith('s1')
  })

  it('discard-all discards the session and answers void', async () => {
    const discardAll = vi.fn(() => [{ id: 'k1', title: 't' }])
    await register({ discardAll })
    expect(
      await call(captured, 'knowledge-suggestions:discard-all', { sessionId: 's1' })
    ).toBeUndefined()
    expect(discardAll).toHaveBeenCalledWith('s1')
  })

  it('the accept-all and discard-all requests are strict', () => {
    for (const channel of [
      'knowledge-suggestions:accept-all',
      'knowledge-suggestions:discard-all'
    ] as const) {
      const schema = channelSchemas[channel]
      expect(schema.safeParse({ sessionId: 's' }).success).toBe(true)
      expect(schema.safeParse({}).success).toBe(false)
      expect(schema.safeParse({ sessionId: 's', x: 1 }).success).toBe(false)
    }
  })
})
