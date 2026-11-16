import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import AttentionDock from '../../src/renderer/src/lib/components/sessions/AttentionDock.svelte'
import { permissionView } from './attention-fixtures'
import SessionHeader from '../../src/renderer/src/lib/components/sessions/SessionHeader.svelte'
import { eventStyle } from '../../src/renderer/src/lib/components/sessions/event-kinds'
import { activeSession } from '../../src/renderer/src/lib/stores/active-session.svelte'
import type { SessionHeader as Header } from '../../src/shared/types/session'
import { mockArc } from './helpers'

const header: Header = {
  id: 's1',
  groupId: 'g1',
  name: 'Fix sync',
  mode: 'autonomous',
  workerLimit: 4,
  workers: { mode: 'auto' },
  brainModel: 'sonnet',
  autoApprove: false,
  skipApprovals: false,
  allowRules: [],
  status: 'active',
  createdAt: 1,
  lastActiveAt: 1,
  branches: []
}

let invoke: ReturnType<typeof mockArc>
beforeEach(() => {
  invoke = mockArc(() => ({ ok: true, data: undefined }))
  activeSession.close()
})
afterEach(cleanup)

const show = (over: Partial<Header> = {}) =>
  render(SessionHeader, { header: { ...header, ...over }, groupName: 'Team', onback: vi.fn() })

it('Always allow on the docked panel sends approve with always:true', async () => {
  activeSession.setSnapshot({
    header,
    messages: [],
    events: [],
    workers: [],
    plan: null,
    attention: [permissionView({ id: 'p1', from: 'W1', workerId: 'w1', action: 'mkdir x' })],
    knowledgeSuggestions: [],
    brainState: 'idle',
    changedFileCount: 0,
    seq: 0
  })
  render(AttentionDock)
  await fireEvent.click(
    await screen.findByRole('button', { name: 'Always allow this in this session' })
  )
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith('attention:answer', {
      requestId: 'p1',
      approve: true,
      always: true
    })
  )
})

const openApprovals = async (): Promise<HTMLElement> => {
  const button = screen.getByRole('button', { name: 'Approvals' })
  await fireEvent.click(button)
  return button
}

it('the Approvals menu toggles Auto-approve and explains pushes still ask', async () => {
  show()
  expect(screen.queryByText('Auto-approve on')).toBeNull()
  expect(screen.queryByRole('switch', { name: 'Auto-approve' })).toBeNull()
  await openApprovals()
  expect(screen.getByText('Pushes and merge requests always ask')).toBeTruthy()
  await fireEvent.click(screen.getByRole('switch', { name: 'Auto-approve' }))
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith('sessions:set-config', {
      sessionId: 's1',
      autoApprove: true
    })
  )
})

it('shows the Auto-approve on chip beside the menus when enabled', () => {
  show({ autoApprove: true })
  const chip = screen.getByText('Auto-approve on')
  expect(chip.closest('[data-header-controls]')).toBeTruthy()
})

it('lists allow rules in the Approvals menu and removes one through the channel', async () => {
  show({
    allowRules: [
      { id: 'r1', text: 'git push', category: 'leaves_machine', createdAt: 1 },
      { id: 'r2', text: 'mkdir in /opt/app', category: 'outside_worktree', createdAt: 2 }
    ]
  })
  await openApprovals()
  expect(screen.getByText('Allow rules (2)')).toBeTruthy()
  expect(screen.getByText('mkdir in /opt/app').className).toContain('font-mono')
  await fireEvent.click(screen.getByRole('button', { name: 'Remove rule git push' }))
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith('sessions:remove-allow-rule', {
      sessionId: 's1',
      ruleId: 'r1'
    })
  )
})

it('Escape closes the Approvals menu and returns focus to its button', async () => {
  show({ allowRules: [{ id: 'r1', text: 'git push', category: 'leaves_machine', createdAt: 1 }] })
  const button = await openApprovals()
  await fireEvent.keyDown(screen.getByText('git push'), { key: 'Escape' })
  expect(screen.queryByRole('dialog', { name: 'Approvals' })).toBeNull()
  expect(document.activeElement).toBe(button)
})

it('opening the Approvals menu moves focus inside it', async () => {
  show()
  await openApprovals()
  await waitFor(() =>
    expect(screen.getByRole('dialog', { name: 'Approvals' }).contains(document.activeElement)).toBe(
      true
    )
  )
})

it('maps the new event kinds to icons and tones', () => {
  expect(eventStyle('allow-rule')).toMatchObject({ icon: 'check', tone: 'success' })
  expect(eventStyle('auto-approved')).toMatchObject({ icon: 'check', tone: 'accent' })
  expect(eventStyle('auto-approve')).toMatchObject({ icon: 'info', tone: 'accent' })
})

const lastSetConfig = (): unknown =>
  invoke.mock.calls.filter((c) => c[0] === 'sessions:set-config').at(-1)?.[1]

it('turning Skip all approvals on opens the dialog and the switch stays off until confirmed', async () => {
  show()
  await openApprovals()
  const skip = screen.getByRole('switch', { name: 'Skip all approvals' }) as HTMLInputElement
  await fireEvent.click(skip)
  expect(screen.getByRole('heading', { name: 'Skip all approvals?' })).toBeTruthy()
  // The menu closes so it never sits on top of the warning.
  expect(screen.queryByRole('dialog', { name: 'Approvals' })).toBeNull()
  expect(invoke.mock.calls.some((c) => c[0] === 'sessions:set-config')).toBe(false)
  await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(screen.queryByRole('heading', { name: 'Skip all approvals?' })).toBeNull()
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /^Approvals/ }))
  )
  await openApprovals()
  expect(
    (screen.getByRole('switch', { name: 'Skip all approvals' }) as HTMLInputElement).checked
  ).toBe(false)
  expect(invoke.mock.calls.some((c) => c[0] === 'sessions:set-config')).toBe(false)
})

it('confirming the dialog sends set-config skipApprovals true and never touches autoApprove', async () => {
  show()
  await openApprovals()
  await fireEvent.click(screen.getByRole('switch', { name: 'Skip all approvals' }))
  await fireEvent.click(screen.getByRole('button', { name: 'Skip all approvals' }))
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith('sessions:set-config', {
      sessionId: 's1',
      skipApprovals: true
    })
  )
  expect(lastSetConfig()).not.toHaveProperty('autoApprove')
})

it('turning Skip all approvals off sends set-config false with no dialog', async () => {
  show({ skipApprovals: true })
  await openApprovals()
  const skip = screen.getByRole('switch', { name: 'Skip all approvals' }) as HTMLInputElement
  expect(skip.checked).toBe(true)
  await fireEvent.click(skip)
  expect(screen.queryByRole('heading', { name: 'Skip all approvals?' })).toBeNull()
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith('sessions:set-config', {
      sessionId: 's1',
      skipApprovals: false
    })
  )
})

it('Auto-approve shows on and locked while skip is on, and the user value returns after', async () => {
  const view = show({ autoApprove: false, skipApprovals: true })
  await openApprovals()
  const auto = screen.getByRole('switch', { name: 'Auto-approve' }) as HTMLInputElement
  expect(auto.checked).toBe(true)
  expect(auto.disabled).toBe(true)
  const wrapper = auto.closest('[title]') as HTMLElement
  expect(wrapper.getAttribute('title')).toBe('Covered by Skip all approvals')
  const describedBy = wrapper.getAttribute('aria-describedby') as string
  expect(document.getElementById(describedBy)?.textContent).toBe('Covered by Skip all approvals')

  await view.rerender({
    header: { ...header, autoApprove: false, skipApprovals: false },
    groupName: 'Team',
    onback: vi.fn()
  })
  const after = screen.getByRole('switch', { name: 'Auto-approve' }) as HTMLInputElement
  expect(after.checked).toBe(false)
  expect(after.disabled).toBe(false)
})

it('a user Auto-approve of on is still on after skip turns off', async () => {
  const view = show({ autoApprove: true, skipApprovals: true })
  await openApprovals()
  await view.rerender({
    header: { ...header, autoApprove: true, skipApprovals: false },
    groupName: 'Team',
    onback: vi.fn()
  })
  expect((screen.getByRole('switch', { name: 'Auto-approve' }) as HTMLInputElement).checked).toBe(
    true
  )
})

it('maps the skip event kinds', () => {
  expect(eventStyle('skip-approvals')).toMatchObject({ tone: 'danger' })
  expect(eventStyle('skip-approved')).toMatchObject({ icon: 'check' })
})
