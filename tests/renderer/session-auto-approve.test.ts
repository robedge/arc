import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import SessionHeader from '../../src/renderer/src/lib/components/sessions/SessionHeader.svelte'
import { eventStyle } from '../../src/renderer/src/lib/components/sessions/event-kinds'
import { activeSession } from '../../src/renderer/src/lib/stores/active-session.svelte'
import type { SessionHeader as Header } from '../../src/shared/types/session'
import { mockHarness } from './helpers'

const header: Header = {
  id: 's1',
  groupId: 'g1',
  name: 'Fix sync',
  mode: 'autonomous',
  workerLimit: 4,
  model: 'auto',
  brainModel: 'sonnet',
  autoApprove: false,
  allowRules: [],
  status: 'active',
  createdAt: 1,
  lastActiveAt: 1,
  branches: []
}

let invoke: ReturnType<typeof mockHarness>
beforeEach(() => {
  invoke = mockHarness(() => ({ ok: true, data: undefined }))
  activeSession.close()
})
afterEach(cleanup)

const show = (over: Partial<Header> = {}) =>
  render(SessionHeader, { header: { ...header, ...over }, groupName: 'Team', onback: vi.fn() })

it('Always allow in the attention dialog sends approve with always:true', async () => {
  activeSession.setSnapshot({
    header,
    messages: [],
    events: [],
    workers: [],
    plan: null,
    attention: [
      {
        id: 'p1',
        route: 'queue',
        kind: 'permission',
        from: 'W1',
        workerId: 'w1',
        action: 'mkdir x'
      }
    ],
    brainState: 'idle',
    changedFileCount: 0,
    seq: 0
  })
  show()
  activeSession.openAttention()
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
