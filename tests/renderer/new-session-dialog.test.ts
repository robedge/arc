// @spec: 013-session-branches-on-demand
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
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
    workerLimit: 3
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
    brainModel: { provider: 'claude', model: 'haiku' }
  })
  settings.reset()
})
