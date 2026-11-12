import { afterEach, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/svelte'
import EventLog from '../../src/renderer/src/lib/components/sessions/EventLog.svelte'
import type { SessionEventEntry } from '../../src/shared/types/session'

afterEach(cleanup)

const entry = (id: number, kind: string, text: string): SessionEventEntry => ({
  id,
  sessionId: 's',
  at: 0,
  kind,
  text,
  workerId: null,
  dataJson: null
})

it.each([
  ['knowledge-suggested', 'Knowledge suggested', 'info', 'text-accent'],
  ['knowledge-accepted', 'Knowledge accepted', 'success', 'text-success'],
  ['knowledge-discarded', 'Knowledge discarded', 'info', 'text-text-faint']
])('%s gets its label and icon', (kind, label, icon, tone) => {
  render(EventLog, { props: { events: [entry(1, kind, 'Service map')] } })
  const row = document.querySelector(`[data-event-kind="${kind}"]`)!
  expect(row.querySelector('svg')?.getAttribute('aria-label')).toBe(label)
  const mark = row.querySelector(`[data-event-icon="${icon}"]`)
  expect(mark?.className).toContain(tone)
  expect(row.textContent).toContain('Service map')
})
