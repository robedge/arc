import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SuggestInput } from '../../../src/main/knowledge/knowledge-suggestion-service'
import { KnowledgeSuggestionRefused } from '../../../src/main/knowledge/knowledge-suggestion-service'
import { messageRowDto, parsePrompt } from '../../../src/main/sessions/message-prompt'
import { useTempDir } from '../helpers/temp-dir'
import { makeEngineRig, until } from './engine-rig'
import type { EngineRig } from './engine-rig'
import { doneWorker } from './merge-rig'

vi.setConfig({ testTimeout: 30000 })

const dir = useTempDir('arc-suggestions-line-')
let e: EngineRig | undefined

afterEach(async () => {
  await e?.close()
  e = undefined
})

const args = {
  kind: 'new',
  title: 'Orders table is partitioned by month',
  reason: 'Read in the schema dump',
  section: 'Notes',
  name: 'Service map',
  content: 'Checkout calls pricing twice.'
}

const isSummary = (t: string): boolean => t.startsWith('[Arc] All workers finished')

/** The port stores a suggestion unless the test makes it refuse the call with this name. */
function makePort(refuse: Set<string> = new Set()) {
  let n = 0
  return vi.fn((_s: string, _g: string, _r: string, input: SuggestInput) => {
    if (input.kind === 'new' && refuse.has(input.name)) {
      return Promise.reject(new KnowledgeSuggestionRefused('duplicate', 'Already suggested.'))
    }
    n += 1
    return Promise.resolve({ id: `k${n}`, remainingThisRequest: 5 - n })
  })
}

async function start(port = makePort()): Promise<{ rig: EngineRig; sessionId: string }> {
  e = await makeEngineRig(dir(), { knowledgeSuggestions: { suggest: port } })
  return { rig: e, sessionId: await e.startSession('autonomous') }
}

const suggest = (rig: EngineRig, name: string) =>
  rig.call(rig.brain(), 'suggest_knowledge_update', { ...args, name })

function reply(rig: EngineRig, id: string, text: string): void {
  rig.brain().emit({ type: 'assistant-message', messageId: id, text })
}

function endTurn(rig: EngineRig, interrupted = false): void {
  rig.brain().emit({ type: 'turn-result', ok: !interrupted, interrupted, durationMs: 1 })
}

const stored = (rig: EngineRig, sessionId: string) =>
  rig.rig.messagesRepo.latest(sessionId, 50).map((r) => messageRowDto(r))

const tagged = (rig: EngineRig, sessionId: string) =>
  stored(rig, sessionId).filter((m) => m.prompt?.kind === 'knowledge-suggestions')

const suggestionsText = (n: number): string =>
  `I have ${n} suggestion${n === 1 ? '' : 's'} for this group's knowledge.`

describe('knowledge-suggestions line under the brain reply', () => {
  it('tags the last reply with the count and pushes the updated message', async () => {
    const { rig, sessionId } = await start()
    await suggest(rig, 'One')
    await suggest(rig, 'Two')
    reply(rig, 'a1', 'Done, here is the answer.')
    endTurn(rig)
    await until(() => tagged(rig, sessionId).length > 0)

    const rows = tagged(rig, sessionId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ role: 'brain', content: 'Done, here is the answer.' })
    expect(rows[0]?.prompt).toEqual({ kind: 'knowledge-suggestions', count: 2 })
    const pushes = rig.rig
      .of('session:message')
      .filter((p) => p.message.role === 'brain' && p.message.id === rows[0]?.id)
    expect(pushes.at(-1)?.message.prompt).toEqual({ kind: 'knowledge-suggestions', count: 2 })
    expect(pushes.at(-1)?.message.content).toBe('Done, here is the answer.')
    expect(stored(rig, sessionId).filter((m) => m.role === 'system' && m.prompt)).toHaveLength(0)
  })

  it('tags only the last visible reply of the turn', async () => {
    const { rig, sessionId } = await start()
    reply(rig, 'a1', 'Looking first.')
    await suggest(rig, 'One')
    reply(rig, 'a2', 'Final answer.')
    endTurn(rig)
    await until(() => tagged(rig, sessionId).length > 0)
    expect(tagged(rig, sessionId).map((m) => m.content)).toEqual(['Final answer.'])
  })

  it('changes nothing in a turn with a reply and no suggestion', async () => {
    const { rig, sessionId } = await start()
    reply(rig, 'a1', 'Plain answer.')
    endTurn(rig)
    await until(() => stored(rig, sessionId).some((m) => m.content === 'Plain answer.'))
    await new Promise((r) => setTimeout(r, 50))
    expect(stored(rig, sessionId).filter((m) => m.prompt)).toHaveLength(0)
    expect(stored(rig, sessionId).some((m) => m.content.includes('suggestion'))).toBe(false)
  })

  it('does not count a refused suggestion', async () => {
    const { rig, sessionId } = await start(makePort(new Set(['Dup'])))
    const ok = await suggest(rig, 'One')
    const refused = await suggest(rig, 'Dup')
    expect(ok.isError).toBe(false)
    expect(refused.isError).toBe(true)
    reply(rig, 'a1', 'Answer.')
    endTurn(rig)
    await until(() => tagged(rig, sessionId).length > 0)
    expect(tagged(rig, sessionId)[0]?.prompt).toEqual({ kind: 'knowledge-suggestions', count: 1 })
  })

  it('posts a system message when the turn has suggestions and no visible reply', async () => {
    const { rig, sessionId } = await start()
    await suggest(rig, 'One')
    endTurn(rig)
    await until(() => tagged(rig, sessionId).length > 0)
    const rows = tagged(rig, sessionId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ role: 'system', content: suggestionsText(1) })
    expect(rows[0]?.content).toBe("I have 1 suggestion for this group's knowledge.")
    expect(rows[0]?.prompt).toEqual({ kind: 'knowledge-suggestions', count: 1 })
    const pushed = rig.rig.of('session:message').filter((p) => p.message.role === 'system')
    expect(pushed.at(-1)?.message.prompt).toEqual({ kind: 'knowledge-suggestions', count: 1 })
  })

  it('words the system message in the plural for several suggestions', async () => {
    const { rig, sessionId } = await start()
    await suggest(rig, 'One')
    await suggest(rig, 'Two')
    endTurn(rig)
    await until(() => tagged(rig, sessionId).length > 0)
    expect(tagged(rig, sessionId)[0]?.content).toBe(suggestionsText(2))
  })

  it('keeps review-link on the summary reply and posts the line as a system message', async () => {
    const { rig, sessionId } = await start()
    await doneWorker(rig, 'api-retry', 'api', { 'retry.txt': 'retry\n' })
    // The first turn is over before the summary request begins.
    endTurn(rig)
    await rig.call(rig.brain(), 'merge_worker', { workerId: 'W1' })
    await until(() => rig.brain().sent.some(isSummary))
    await suggest(rig, 'One')
    await suggest(rig, 'Two')
    reply(rig, 'a1', 'Here is the summary.')
    endTurn(rig)
    await until(() => tagged(rig, sessionId).length > 0)

    const review = stored(rig, sessionId).filter((m) => m.prompt?.kind === 'review-link')
    expect(review.map((m) => [m.role, m.content])).toEqual([['brain', 'Here is the summary.']])
    const lines = tagged(rig, sessionId)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ role: 'system', content: suggestionsText(2) })
    expect(lines[0]?.prompt).toEqual({ kind: 'knowledge-suggestions', count: 2 })
  })

  it('does not carry the count into the next turn', async () => {
    const { rig, sessionId } = await start()
    await suggest(rig, 'One')
    reply(rig, 'a1', 'First answer.')
    endTurn(rig)
    await until(() => tagged(rig, sessionId).length > 0)

    await rig.rig.service.sendMessage(sessionId, 'and another thing?')
    reply(rig, 'a2', 'Second answer.')
    endTurn(rig)
    await until(() => stored(rig, sessionId).some((m) => m.content === 'Second answer.'))
    await new Promise((r) => setTimeout(r, 50))

    expect(tagged(rig, sessionId).map((m) => m.content)).toEqual(['First answer.'])
    expect(stored(rig, sessionId).filter((m) => m.prompt)).toHaveLength(1)
  })

  it('gives each turn its own count', async () => {
    const { rig, sessionId } = await start()
    await suggest(rig, 'One')
    await suggest(rig, 'Two')
    reply(rig, 'a1', 'First answer.')
    endTurn(rig)
    await until(() => tagged(rig, sessionId).length > 0)

    await rig.rig.service.sendMessage(sessionId, 'more please')
    await suggest(rig, 'Three')
    reply(rig, 'a2', 'Second answer.')
    endTurn(rig)
    await until(() => tagged(rig, sessionId).length > 1)
    const counts = tagged(rig, sessionId).map((m) => [m.content, m.prompt])
    expect(counts).toContainEqual(['First answer.', { kind: 'knowledge-suggestions', count: 2 }])
    expect(counts).toContainEqual(['Second answer.', { kind: 'knowledge-suggestions', count: 1 }])
  })

  it('still tags a stopped turn, on the partial reply it left', async () => {
    const { rig, sessionId } = await start()
    await suggest(rig, 'One')
    reply(rig, 'a1', 'Half an answer')
    endTurn(rig, true)
    await until(() => tagged(rig, sessionId).length > 0)
    const rows = tagged(rig, sessionId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ role: 'brain', content: 'Half an answer' })
    expect(rows[0]?.prompt).toEqual({ kind: 'knowledge-suggestions', count: 1 })
  })

  it('posts the system message for a stopped turn with no reply text', async () => {
    const { rig, sessionId } = await start()
    await suggest(rig, 'One')
    endTurn(rig, true)
    await until(() => tagged(rig, sessionId).length > 0)
    expect(tagged(rig, sessionId)[0]).toMatchObject({
      role: 'system',
      content: suggestionsText(1)
    })
  })

  it('keeps the tag after the session is read back from the repository', async () => {
    const { rig, sessionId } = await start()
    await suggest(rig, 'One')
    reply(rig, 'a1', 'Answer.')
    endTurn(rig)
    await until(() => tagged(rig, sessionId).length > 0)
    const id = tagged(rig, sessionId)[0]?.id ?? -1
    const row = rig.rig.messagesRepo.get(id)
    expect(row?.promptJson).toBe(JSON.stringify({ kind: 'knowledge-suggestions', count: 1 }))
    expect(row && messageRowDto(row).prompt).toEqual({ kind: 'knowledge-suggestions', count: 1 })
    const snapshot = rig.rig.service.snapshot(sessionId)
    expect(snapshot.messages.find((m) => m.id === id)?.prompt).toEqual({
      kind: 'knowledge-suggestions',
      count: 1
    })
  })
})

describe('parsePrompt for knowledge-suggestions', () => {
  it('accepts a positive integer count', () => {
    expect(parsePrompt('{"kind":"knowledge-suggestions","count":3}')).toEqual({
      kind: 'knowledge-suggestions',
      count: 3
    })
  })

  it.each(['0', '-1', '1.5', '"2"', 'null'])('rejects count %s', (count) => {
    expect(parsePrompt(`{"kind":"knowledge-suggestions","count":${count}}`)).toBeUndefined()
  })

  it('rejects a missing count', () => {
    expect(parsePrompt('{"kind":"knowledge-suggestions"}')).toBeUndefined()
  })
})
