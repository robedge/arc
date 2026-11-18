import { tick } from 'svelte'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import SessionScreen from '../../src/renderer/src/lib/components/sessions/SessionScreen.svelte'
import { activeSession } from '../../src/renderer/src/lib/stores/active-session.svelte'
import { nova } from '../../src/renderer/src/lib/stores/nova.svelte'
import type { SessionHeader as Header, SessionSnapshot } from '../../src/shared/types/session'
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

const snapshot = (h: Header): SessionSnapshot => ({
  header: h,
  messages: [],
  events: [],
  workers: [],
  plan: null,
  attention: [],
  knowledgeSuggestions: [],
  brainState: 'idle',
  changedFileCount: 0,
  seq: 0
})

beforeEach(() => {
  nova.close()
  mockArc((channel, request) => {
    if (channel === 'sessions:open') {
      const id = (request as { sessionId: string }).sessionId
      return { ok: true, data: snapshot({ ...header, id }) }
    }
    return { ok: true, data: {} }
  })
})
afterEach(() => {
  cleanup()
  activeSession.close()
  nova.close()
})

async function openScreen(): Promise<void> {
  await activeSession.open('s1')
  render(SessionScreen)
  await tick()
}

it('opens from the header button with the portrait, name and Idle', async () => {
  await openScreen()
  expect(document.querySelector('[data-nova-panel]')).toBeNull()
  await fireEvent.click(screen.getByRole('button', { name: 'Nova' }))
  const panel = document.querySelector('[data-nova-panel]') as HTMLElement
  expect(panel).toBeTruthy()
  expect(panel.tagName).toBe('ASIDE')
  expect(panel.querySelector('img')).toBeTruthy()
  expect(panel.querySelector('h2')?.textContent).toBe('Nova')
  expect(panel.querySelector('[data-nova-state]')?.getAttribute('data-nova-state')).toBe('idle')
  expect(panel.querySelector('[data-nova-state]')?.textContent?.trim()).toBe('Idle')
  expect(document.querySelector('[data-session-body]')?.className).toContain(
    'minmax(480px,1fr)_minmax(240px,340px)'
  )
})

it('closes with Close and returns to the two-column layout', async () => {
  await openScreen()
  await fireEvent.click(screen.getByRole('button', { name: 'Nova' }))
  await fireEvent.click(screen.getByRole('button', { name: 'Close' }))
  expect(document.querySelector('[data-nova-panel]')).toBeNull()
  expect(screen.getByRole('button', { name: 'Nova' }).getAttribute('aria-pressed')).toBe('false')
  expect(document.querySelector('[data-session-body]')?.className).not.toContain('240px')
})

it('closes when the session changes', async () => {
  await openScreen()
  await fireEvent.click(screen.getByRole('button', { name: 'Nova' }))
  expect(nova.open).toBe(true)
  await activeSession.open('s2')
  await tick()
  expect(nova.open).toBe(false)
  expect(document.querySelector('[data-nova-panel]')).toBeNull()
})

it('shows the voice download prompt in the panel when a model is missing', async () => {
  mockArc((channel, request) => {
    if (channel === 'sessions:open') {
      return {
        ok: true,
        data: snapshot({ ...header, id: (request as { sessionId: string }).sessionId })
      }
    }
    return channel === 'voice:models-status'
      ? {
          ok: true,
          data: {
            models: [{ id: 'a', kind: 'tts', state: 'missing', bytes: 0, totalBytes: 520_000_000 }]
          }
        }
      : { ok: true, data: {} }
  })
  nova.toggle()
  await openScreen()
  expect(
    await screen.findByRole('button', { name: 'Download voice models (about 520 MB)' })
  ).toBeTruthy()
  expect(document.querySelector('[data-nova-state="idle"]')).toBeTruthy()
})
