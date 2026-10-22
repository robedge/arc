import { afterEach, beforeEach, expect, it } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/svelte'
import LiveMark from '../../src/renderer/src/lib/components/ui/LiveMark.svelte'
import UsageChip from '../../src/renderer/src/lib/components/sessions/UsageChip.svelte'
import WorkerCard from '../../src/renderer/src/lib/components/sessions/WorkerCard.svelte'
import { usage } from '../../src/renderer/src/lib/stores/usage.svelte'
import type { AgentUsage, SessionUsage, TokenTotals } from '../../src/shared/types/usage'
import type { WorkerView } from '../../src/shared/types/session'
import { mockHarness } from './helpers'

// @spec: 008-plan-usage-and-token-spend (amendment 2: live token counts)

const totals = (total: number): TokenTotals => ({
  input: total,
  cacheWrite: 0,
  cacheRead: 0,
  output: 0,
  total
})

function agent(over: Partial<AgentUsage>): AgentUsage {
  return {
    agentKey: 'brain',
    role: 'brain',
    label: 'Brain',
    provider: 'claude',
    model: 'sonnet',
    recording: 'recorded',
    tokens: totals(1000),
    byModel: [],
    maxCallInput: 0,
    setup: {
      arcAdditionsPerRequest: null,
      fixedSetupPerRequest: null,
      setupTokens: 0,
      arcSetupTokens: 0,
      work: 0
    },
    ...over
  }
}

/** The brain is idle with 1000 saved tokens; worker w1 has 400 saved and 600 in flight. */
const midTurn = (updatedAt = 1): SessionUsage => ({
  sessionId: 's1',
  total: totals(2000),
  setupShare: null,
  arcSetupShare: null,
  byProvider: { claude: totals(1000), codex: totals(1000) },
  partial: false,
  agents: [
    agent({}),
    agent({
      agentKey: 'w1',
      role: 'worker',
      label: 'W1 · api-retry',
      provider: 'codex',
      model: 'gpt-5.5',
      tokens: totals(1000),
      inFlight: totals(600)
    })
  ],
  suggestions: [],
  updatedAt
})

function worker(over: Partial<WorkerView> = {}): WorkerView {
  return {
    id: 'w1',
    sessionId: 's1',
    number: 1,
    slug: 'api-retry',
    role: 'worker',
    task: 'Add retry.',
    projectIds: [],
    model: 'gpt-5.5',
    status: 'working',
    activity: null,
    failureReason: null,
    summary: null,
    stoppedBy: null,
    worktrees: [],
    hasWorkingCopy: true,
    unmergedCommits: 0,
    createdAt: 1,
    ...over
  } as WorkerView
}

const chip = (): HTMLButtonElement =>
  document.querySelector('[data-usage-chip]') as HTMLButtonElement

beforeEach(() => {
  usage.reset()
  mockHarness(() => ({ ok: true, data: midTurn() }))
})
afterEach(cleanup)

it('LiveMark says in plain text that the number is still counting', () => {
  render(LiveMark)
  const mark = document.querySelector('[data-in-progress]') as HTMLElement
  expect(mark.textContent).toContain('still counting')
  expect(mark.title).toBe('still counting')
})

it('WorkerCard marks a mid-turn count and drops the mark once the turn is saved', () => {
  const { unmount } = render(WorkerCard, {
    worker: worker({ tokens: totals(5000), tokensInFlight: true }),
    onopen: () => {}
  })
  const card = document.querySelector('[data-worker-card]') as HTMLElement
  expect(card.querySelector('[data-in-progress]')).not.toBeNull()
  expect(card.querySelector('[data-tokens]')?.getAttribute('data-tokens')).toBe('5000')
  unmount()
  render(WorkerCard, { worker: worker({ tokens: totals(5000) }), onopen: () => {} })
  expect(document.querySelector('[data-worker-card] [data-in-progress]')).toBeNull()
})

it('UsageChip shows the total with the in-flight usage and the mark, and loses the mark when the row lands', async () => {
  usage.applySession(midTurn())
  render(UsageChip, { sessionId: 's1' })
  expect(chip().querySelector('[data-in-progress]')).not.toBeNull()
  expect(chip().querySelector('[data-tokens]')?.getAttribute('data-tokens')).toBe('2000')
  // The row is written: the same 2000 tokens, now saved, so nothing is added or dropped.
  usage.applySession({
    ...midTurn(2),
    agents: [agent({}), { ...midTurn().agents[1]!, inFlight: undefined }]
  })
  await Promise.resolve()
  expect(chip().querySelector('[data-in-progress]')).toBeNull()
  expect(chip().querySelector('[data-tokens]')?.getAttribute('data-tokens')).toBe('2000')
})

it('UsagePanel marks only the agent that is mid-turn, with the session total, and explains the dot', async () => {
  usage.applySession(midTurn())
  render(UsageChip, { sessionId: 's1' })
  await fireEvent.click(chip())
  const brainRow = document.querySelector('[data-usage-row="brain"]') as HTMLElement
  const workerRow = document.querySelector('[data-usage-row="w1"]') as HTMLElement
  expect(brainRow.querySelector('[data-in-progress]')).toBeNull()
  expect(workerRow.querySelector('[data-in-progress]')).not.toBeNull()
  // The row's own figure includes the in-flight part.
  expect(workerRow.querySelector('td [data-tokens]')?.getAttribute('data-tokens')).toBe('1000')
  expect(document.querySelector('[data-usage-total] [data-in-progress]')).not.toBeNull()
  expect(document.querySelector('[data-usage-in-progress]')?.textContent).toContain('mid-turn')
})

it('UsagePanel shows no mark and no note when nothing is in flight', async () => {
  usage.applySession({ ...midTurn(), agents: [agent({})] })
  render(UsageChip, { sessionId: 's1' })
  await fireEvent.click(chip())
  expect(document.querySelector('[data-in-progress]')).toBeNull()
  expect(document.querySelector('[data-usage-in-progress]')).toBeNull()
})

it('the setup split keeps to saved turns: input in all leaves out the in-flight part', async () => {
  const snapshot = midTurn()
  snapshot.agents[1] = {
    ...snapshot.agents[1]!,
    setup: { ...snapshot.agents[1]!.setup, setupTokens: 100, work: 300 }
  }
  usage.applySession(snapshot)
  render(UsageChip, { sessionId: 's1' })
  await fireEvent.click(chip())
  const split = document.querySelector('[data-usage-setup="w1"] [data-setup-input] [data-tokens]')
  // 1000 shown in the row, 600 of it in flight: 400 saved = 100 setup + 300 work.
  expect(split?.getAttribute('data-tokens')).toBe('400')
})
