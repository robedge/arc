// @spec: 013-session-branches-on-demand
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte'
import NewSessionDialog from '../../src/renderer/src/lib/components/sessions/NewSessionDialog.svelte'
import { settings } from '../../src/renderer/src/lib/stores/settings.svelte'
import { mockArc } from './helpers'

afterEach(cleanup)

it('shows the required message and creates nothing when the request is empty', async () => {
  const invoke = mockArc(() => ({ ok: true, data: { sessionId: 's1' } }))
  render(NewSessionDialog, { groupId: 'g1', onclose: vi.fn(), oncreated: vi.fn() })
  await fireEvent.click(screen.getByRole('button', { name: 'Start' }))
  expect(screen.getByText('Enter a request for the brain.')).toBeTruthy()
  expect(invoke).not.toHaveBeenCalled()
})

it('defaults to Plan-first and a limit of 3, and sends the payload', async () => {
  const invoke = mockArc(() => ({ ok: true, data: { sessionId: 's1' } }))
  const oncreated = vi.fn()
  render(NewSessionDialog, { groupId: 'g1', onclose: vi.fn(), oncreated })
  expect((screen.getByLabelText(/Plan-first/) as HTMLInputElement).checked).toBe(true)
  expect((screen.getByLabelText('Worker limit') as HTMLSelectElement).value).toBe('3')
  await fireEvent.input(screen.getByLabelText('Request'), { target: { value: 'Fix the bug' } })
  await fireEvent.click(screen.getByRole('button', { name: 'Start' }))
  await waitFor(() => expect(oncreated).toHaveBeenCalledWith('s1'))
  expect(invoke).toHaveBeenCalledWith('sessions:create', {
    groupId: 'g1',
    request: 'Fix the bug',
    mode: 'plan_first',
    workerLimit: 3,
    skipApprovals: false
  })
})

it('creates straight through with no unsaved-changes question', async () => {
  const invoke = mockArc(() => ({ ok: true, data: { sessionId: 's1' } }))
  const oncreated = vi.fn()
  render(NewSessionDialog, { groupId: 'g1', onclose: vi.fn(), oncreated })
  await fireEvent.input(screen.getByLabelText('Request'), { target: { value: 'Fix it' } })
  await fireEvent.click(screen.getByRole('button', { name: 'Start' }))
  await waitFor(() => expect(oncreated).toHaveBeenCalledWith('s1'))
  expect(screen.queryByText('Unsaved changes')).toBeNull()
  expect(invoke).not.toHaveBeenCalledWith('sessions:resolve-dirty', expect.anything())
})

it('shows the Settings brain default and sends a changed brain with the create call', async () => {
  settings.apply({
    'providers.brain': { provider: 'claude', model: 'opus' },
    'providers.workers': { mode: 'auto' },
    'usage.checkClaudePlanOnLaunch': false,
    'agents.loadOff': { brain: [], workers: [] }
  } as never)
  const invoke = mockArc(() => ({ ok: true, data: { sessionId: 's1' } }))
  const oncreated = vi.fn()
  render(NewSessionDialog, { groupId: 'g1', onclose: vi.fn(), oncreated })
  const brain = screen.getByLabelText('Brain') as HTMLSelectElement
  expect(brain.value).toBe('claude:opus')
  await fireEvent.change(brain, { target: { value: 'claude:haiku' } })
  await fireEvent.input(screen.getByLabelText('Request'), { target: { value: 'Fix it' } })
  await fireEvent.click(screen.getByRole('button', { name: 'Start' }))
  await waitFor(() => expect(oncreated).toHaveBeenCalled())
  expect(invoke).toHaveBeenCalledWith('sessions:create', {
    groupId: 'g1',
    request: 'Fix it',
    mode: 'plan_first',
    workerLimit: 3,
    skipApprovals: false,
    brainModel: { provider: 'claude', model: 'haiku' }
  })
  settings.reset()
})

const withDefault = (on: boolean): void =>
  settings.apply({ 'approvals.skipAllByDefault': on } as never)

const skipSwitch = (): HTMLInputElement =>
  screen.getByRole('switch', { name: 'Skip all approvals' }) as HTMLInputElement

it('starts the Skip all approvals switch from the default, on or off', () => {
  mockArc(() => ({ ok: true, data: { sessionId: 's1' } }))
  withDefault(true)
  render(NewSessionDialog, { groupId: 'g1', onclose: vi.fn(), oncreated: vi.fn() })
  expect(skipSwitch().checked).toBe(true)
  cleanup()
  withDefault(false)
  render(NewSessionDialog, { groupId: 'g1', onclose: vi.fn(), oncreated: vi.fn() })
  expect(skipSwitch().checked).toBe(false)
  settings.reset()
})

it('turning the switch on asks first, then sends skipApprovals true and leaves the default alone', async () => {
  const invoke = mockArc(() => ({ ok: true, data: { sessionId: 's1' } }))
  withDefault(false)
  const oncreated = vi.fn()
  render(NewSessionDialog, { groupId: 'g1', onclose: vi.fn(), oncreated })
  await fireEvent.click(skipSwitch())
  expect(screen.getByRole('heading', { name: 'Skip all approvals?' })).toBeTruthy()
  expect(skipSwitch().checked).toBe(false)
  await fireEvent.click(screen.getByRole('button', { name: 'Skip all approvals' }))
  expect(screen.queryByRole('heading', { name: 'Skip all approvals?' })).toBeNull()
  expect(skipSwitch().checked).toBe(true)
  await fireEvent.input(screen.getByLabelText('Request'), { target: { value: 'Go' } })
  await fireEvent.click(screen.getByRole('button', { name: 'Start' }))
  await waitFor(() => expect(oncreated).toHaveBeenCalled())
  expect(invoke).toHaveBeenCalledWith(
    'sessions:create',
    expect.objectContaining({ skipApprovals: true })
  )
  expect(invoke).not.toHaveBeenCalledWith('settings:set', expect.anything())
  expect(settings.values?.['approvals.skipAllByDefault']).toBe(false)
  settings.reset()
})

it('turning the switch off sends false without a dialog or a settings write', async () => {
  const invoke = mockArc(() => ({ ok: true, data: { sessionId: 's1' } }))
  withDefault(true)
  const oncreated = vi.fn()
  render(NewSessionDialog, { groupId: 'g1', onclose: vi.fn(), oncreated })
  await fireEvent.click(skipSwitch())
  expect(screen.queryByRole('heading', { name: 'Skip all approvals?' })).toBeNull()
  await fireEvent.input(screen.getByLabelText('Request'), { target: { value: 'Go' } })
  await fireEvent.click(screen.getByRole('button', { name: 'Start' }))
  await waitFor(() => expect(oncreated).toHaveBeenCalled())
  expect(invoke).toHaveBeenCalledWith(
    'sessions:create',
    expect.objectContaining({ skipApprovals: false })
  )
  expect(invoke).not.toHaveBeenCalledWith('settings:set', expect.anything())
  expect(settings.values?.['approvals.skipAllByDefault']).toBe(true)
  settings.reset()
})

it('Escape in the confirm dialog closes only it and returns focus to the switch', async () => {
  mockArc(() => ({ ok: true, data: { sessionId: 's1' } }))
  withDefault(false)
  const onclose = vi.fn()
  render(NewSessionDialog, { groupId: 'g1', onclose, oncreated: vi.fn() })
  skipSwitch().focus()
  await fireEvent.click(skipSwitch())
  const confirm = screen.getByRole('heading', { name: 'Skip all approvals?' })
  expect(confirm).toBeTruthy()
  await fireEvent.keyDown(
    within(screen.getAllByRole('dialog')[1] as HTMLElement).getByRole('button', { name: 'Cancel' }),
    {
      key: 'Escape'
    }
  )
  expect(screen.queryByRole('heading', { name: 'Skip all approvals?' })).toBeNull()
  expect(screen.getByRole('heading', { name: 'New session' })).toBeTruthy()
  expect(onclose).not.toHaveBeenCalled()
  expect(document.activeElement).toBe(skipSwitch())
  settings.reset()
})
