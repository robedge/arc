import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import type { BypassReport } from '../../src/shared/types/provider'
import type { SessionEventEntry, WorkerView } from '../../src/shared/types/session'
import BypassWarning from '../../src/renderer/src/lib/components/settings/BypassWarning.svelte'
import EventLog from '../../src/renderer/src/lib/components/sessions/EventLog.svelte'
import { activeSession } from '../../src/renderer/src/lib/stores/active-session.svelte'

afterEach(cleanup)
beforeEach(() => {
  activeSession.workers = [{ id: 'w3', number: 3 } as WorkerView]
})

const entry = (outcome: string, action: string, kind?: string): SessionEventEntry => ({
  id: 1,
  sessionId: 's',
  at: 0,
  kind: 'cursor-blocked',
  text: 'main text',
  workerId: 'w3',
  dataJson: JSON.stringify({ workerId: 'w3', action, outcome, kind })
})

const row = (): HTMLElement => document.querySelector('[data-event-kind="cursor-blocked"]')!
const flat = (): string => row().textContent!.replace(/\s+/g, ' ').trim()

it.each([
  [
    'blocked',
    'git push',
    "W3 couldn't run `git push`: Arc blocked it because Cursor can't ask. Rerun this step on a Claude or Codex worker."
  ],
  [
    'ran-unasked',
    'npm test',
    'W3 ran `npm test` without asking (allowed by your Cursor settings).'
  ],
  ['outside-edit', '/tmp/x.ts', 'W3 changed /tmp/x.ts outside its working copy.']
])('%s row text', (outcome, action, text) => {
  render(EventLog, { props: { events: [entry(outcome, action)] } })
  expect(flat()).toContain(text)
  expect(row().querySelector('svg')?.getAttribute('aria-label')).toBe('Blocked')
  expect(row().querySelector('[data-event-icon="warning"]')?.className).toContain('text-attention')
})

it('a blocked edit reads as a change, not a command', () => {
  render(EventLog, { props: { events: [entry('blocked', '/repo/a.ts', 'edit')] } })
  expect(flat()).toContain(
    "W3 couldn't change /repo/a.ts: Arc blocked it. Rerun this step on a Claude or Codex worker."
  )
})

it('the W3 chip is a button that focuses the worker card', async () => {
  document.body.insertAdjacentHTML(
    'beforeend',
    '<div data-worker-id="w3" id="card"><button id="open">Open</button></div>'
  )
  const scroll = vi.fn()
  document.getElementById('card')!.scrollIntoView = scroll
  render(EventLog, { props: { events: [entry('blocked', 'git push')] } })
  await fireEvent.click(screen.getByRole('button', { name: 'Show W3' }))
  expect(scroll).toHaveBeenCalled()
  expect(document.activeElement?.id).toBe('open')
  document.getElementById('card')!.remove()
})

const report = (patch: Partial<BypassReport> = {}): BypassReport => ({
  claudeHookEvents: [],
  codexAllowPrefixes: [],
  codexRulesCovered: 0,
  ...patch
})
const heading = "Cursor settings that can skip Arc's approvals"

it('lists cursor allow entries, approval mode and hook events', () => {
  render(BypassWarning, {
    report: report({
      cursor: {
        allowEntries: ['Shell(git)', 'Write(**)'],
        approvalMode: 'unrestricted',
        hookEvents: ['beforeShellExecution']
      }
    }),
    onrefresh: () => {}
  })
  expect(screen.getByRole('heading', { name: heading })).toBeTruthy()
  expect(screen.getByRole('list', { name: 'Cursor allow entries' }).children).toHaveLength(2)
  expect(screen.getByRole('list', { name: 'Cursor hooks that can allow' }).textContent).toContain(
    'beforeShellExecution'
  )
  expect(document.querySelector('[data-bypass-cursor-mode]')!.textContent).toContain('unrestricted')
})

it('no section for an empty or allowlist-only cursor block, and no warning when nothing bypasses', () => {
  render(BypassWarning, {
    report: report({
      claudeHookEvents: ['PreToolUse'],
      cursor: { allowEntries: [], approvalMode: 'allowlist', hookEvents: [] }
    }),
    onrefresh: () => {}
  })
  expect(document.querySelector('[data-bypass-warning]')).not.toBeNull()
  expect(document.querySelector('[data-bypass-cursor]')).toBeNull()
  cleanup()
  render(BypassWarning, {
    report: report({ cursor: { allowEntries: [], hookEvents: [] } }),
    onrefresh: () => {}
  })
  expect(document.querySelector('[data-bypass-warning]')).toBeNull()
})

it('cursor alone is enough to show the warning; absent block shows no section', () => {
  render(BypassWarning, {
    report: report({ cursor: { allowEntries: ['Mcp(x)'], hookEvents: [] } }),
    onrefresh: () => {}
  })
  expect(document.querySelector('[data-bypass-warning]')).not.toBeNull()
  cleanup()
  render(BypassWarning, { report: report({ claudeHookEvents: ['A'] }), onrefresh: () => {} })
  expect(document.querySelector('[data-bypass-cursor]')).toBeNull()
})
