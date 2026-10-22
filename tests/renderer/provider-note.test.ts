import { afterEach, beforeEach, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import SessionScreen from '../../src/renderer/src/lib/components/sessions/SessionScreen.svelte'
import { activeSession } from '../../src/renderer/src/lib/stores/active-session.svelte'
import { providers } from '../../src/renderer/src/lib/stores/providers.svelte'
import { ui } from '../../src/renderer/src/lib/stores/ui.svelte'
import type { ProviderState } from '../../src/shared/types/provider'
import type { SessionHeader, WorkerView } from '../../src/shared/types/session'
import { mockHarness } from './helpers'

const base: SessionHeader = {
  id: 's1',
  groupId: 'g1',
  name: 'Fix sync',
  mode: 'autonomous',
  workerLimit: 4,
  model: 'auto',
  workers: { mode: 'auto' },
  brainModel: 'sonnet',
  brainRunningOn: { provider: 'claude', model: 'sonnet' },
  autoApprove: false,
  allowRules: [],
  status: 'active',
  createdAt: 1,
  lastActiveAt: 1,
  branches: []
}

function open(header: SessionHeader, workers: WorkerView[] = []): void {
  activeSession.setSnapshot({
    header,
    messages: [],
    events: [],
    workers,
    plan: null,
    attention: [],
    brainState: 'idle',
    changedFileCount: 0,
    seq: 0
  })
}

function setStatus(
  provider: 'claude' | 'codex' | 'cursor',
  state: ProviderState,
  message = ''
): void {
  providers.set({
    [provider]: {
      provider,
      state,
      message,
      checkedAt: 1,
      ...(state === 'signed_out' ? { loginCommand: `${provider} login` } : {})
    }
  })
}

const note = (): HTMLElement | null => document.querySelector('[data-kind="info"]')
const notes = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('[data-kind="info"]')]

let invoke: ReturnType<typeof mockHarness>
beforeEach(() => {
  providers.reset()
  activeSession.close()
  ui.closeSettings()
  setStatus('claude', 'ok')
  invoke = mockHarness(() => ({ ok: true, data: [] }))
})
afterEach(cleanup)

it('shows nothing in a Claude-only session even when Codex is down', () => {
  setStatus('codex', 'signed_out', 'Run codex login in Terminal.')
  open(base)
  render(SessionScreen)
  expect(note()).toBeNull()
})

it.each([
  ['the Workers pref is Codex', { ...base, workers: { mode: 'provider', provider: 'codex' } }],
  [
    'the Workers pref is a Codex model',
    { ...base, workers: { mode: 'model', model: { provider: 'codex', model: 'gpt-5.5' } } }
  ],
  [
    'the brain requested Codex and fell back',
    {
      ...base,
      brainRunningOn: {
        provider: 'claude',
        model: 'sonnet',
        requestedProvider: 'codex',
        fallbackReason: "Codex isn't signed in."
      }
    }
  ]
] as const)('shows the note when %s', (_name, header) => {
  setStatus('codex', 'signed_out', 'Run codex login in Terminal.')
  open(header as SessionHeader)
  render(SessionScreen)
  expect(note()?.getAttribute('role')).toBe('status')
  expect(note()?.textContent).toContain("Codex isn't signed in, so Codex work runs on Claude")
  expect(note()?.textContent).toContain('Run codex login in Terminal.')
})

it('shows the note when a worker requested Codex', () => {
  setStatus('codex', 'missing', 'Codex is not installed.')
  const worker = {
    id: 'w1',
    number: 1,
    title: 'T',
    status: 'working',
    model: 'sonnet',
    runningOn: { provider: 'claude', model: 'sonnet', requestedProvider: 'codex' }
  } as unknown as WorkerView
  open(base, [worker])
  render(SessionScreen)
  expect(note()?.textContent).toContain("Codex isn't installed")
})

it('hides once Codex is ok, and shows nothing before the first check', async () => {
  open({ ...base, workers: { mode: 'provider', provider: 'codex' } })
  render(SessionScreen)
  expect(note()).toBeNull()
  setStatus('codex', 'signed_out', 'x')
  await waitFor(() => expect(note()).not.toBeNull())
  setStatus('codex', 'ok')
  await waitFor(() => expect(note()).toBeNull())
})

it('yields to the blocking Claude banner when Claude is down too', () => {
  setStatus('claude', 'missing', 'Claude Code is not installed.')
  setStatus('codex', 'signed_out', 'x')
  open({ ...base, workers: { mode: 'provider', provider: 'codex' } })
  render(SessionScreen)
  expect(note()).toBeNull()
})

it('never disables the Composer', () => {
  setStatus('codex', 'signed_out', 'x')
  open({ ...base, workers: { mode: 'provider', provider: 'codex' } })
  render(SessionScreen)
  expect(note()).not.toBeNull()
  const input = screen.getByRole('combobox', {
    name: 'Message to the brain'
  }) as HTMLTextAreaElement
  expect(input.disabled).toBe(false)
  for (let el: HTMLElement | null = input; el; el = el.parentElement) {
    expect((el as HTMLElement & { inert?: boolean }).inert ?? false).toBe(false)
    expect(el.hasAttribute('inert')).toBe(false)
  }
})

it('Check again calls providers:check for Codex only', async () => {
  setStatus('codex', 'signed_out', 'x')
  open({ ...base, workers: { mode: 'provider', provider: 'codex' } })
  render(SessionScreen)
  await fireEvent.click(screen.getByRole('button', { name: 'Check Codex again' }))
  expect(invoke).toHaveBeenCalledWith('providers:check', { provider: 'codex' })
})

it('Open Settings opens the Settings view', async () => {
  setStatus('codex', 'signed_out', 'x')
  open({ ...base, workers: { mode: 'provider', provider: 'codex' } })
  render(SessionScreen)
  await fireEvent.click(screen.getByRole('button', { name: 'Open Settings on the Providers page' }))
  expect(ui.view).toBe('settings')
})

it('Dismiss hides it for this session until the state changes', async () => {
  setStatus('codex', 'signed_out', 'x')
  const header: SessionHeader = { ...base, workers: { mode: 'provider', provider: 'codex' } }
  open(header)
  render(SessionScreen)
  await fireEvent.click(screen.getByRole('button', { name: 'Dismiss the Codex note' }))
  expect(note()).toBeNull()
  setStatus('codex', 'missing', 'gone')
  await waitFor(() => expect(note()).not.toBeNull())
})

it('shows the Cursor note when the Workers pref is Cursor and Cursor is signed out', () => {
  setStatus('cursor', 'signed_out', 'Run agent login in Terminal to use Cursor.')
  open({ ...base, workers: { mode: 'provider', provider: 'cursor' } })
  render(SessionScreen)
  expect(note()?.textContent).toContain("Cursor isn't signed in, so Cursor work runs on Claude")
  expect(note()?.textContent).toContain('Run agent login in Terminal')
})

it('shows the Cursor note for a worker that requested Cursor, and checks Cursor only', async () => {
  setStatus('cursor', 'missing', 'Cursor is not installed.')
  const worker = {
    id: 'w1',
    number: 1,
    title: 'T',
    status: 'working',
    model: 'sonnet',
    runningOn: { provider: 'claude', model: 'sonnet', requestedProvider: 'cursor' }
  } as unknown as WorkerView
  open(base, [worker])
  render(SessionScreen)
  expect(note()?.textContent).toContain("Cursor isn't installed")
  await fireEvent.click(screen.getByRole('button', { name: 'Check Cursor again' }))
  expect(invoke).toHaveBeenCalledWith('providers:check', { provider: 'cursor' })
})

it('dismisses per provider: dismissing Cursor leaves Codex, and another session is unaffected', async () => {
  setStatus('codex', 'signed_out', 'x')
  setStatus('cursor', 'signed_out', 'y')
  const header: SessionHeader = {
    ...base,
    workers: { mode: 'model', model: { provider: 'codex', model: 'gpt-5.5' } },
    brainRunningOn: {
      provider: 'claude',
      model: 'sonnet',
      requestedProvider: 'cursor',
      fallbackReason: 'z'
    }
  }
  open(header)
  render(SessionScreen)
  expect(notes()).toHaveLength(2)
  await fireEvent.click(screen.getByRole('button', { name: 'Dismiss the Cursor note' }))
  expect(notes()).toHaveLength(1)
  expect(notes()[0]?.textContent).toContain("Codex isn't signed in")
  expect(providers.providerNoteDismissed).toEqual({ 's1:cursor': 'signed_out' })
  cleanup()
  open({ ...header, id: 's2' })
  render(SessionScreen)
  expect(notes()).toHaveLength(2)
})
