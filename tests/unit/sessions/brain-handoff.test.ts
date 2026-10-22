import { describe, expect, it } from 'vitest'
import {
  buildHandoffPreamble,
  HANDOFF_MAX_CHARS,
  type HandoffMessage
} from '../../../src/main/sessions/brain-handoff'

const msg = (
  role: HandoffMessage['role'],
  content: string,
  over: Partial<HandoffMessage> = {}
): HandoffMessage => ({ role, content, state: 'complete', planId: null, ...over })

describe('buildHandoffPreamble', () => {
  it('lists the user and brain messages oldest first under one explanatory header', () => {
    const text = buildHandoffPreamble([
      msg('user', 'Plan billing'),
      msg('brain', 'Start with invoices')
    ])
    expect(text).toMatch(/^\[Arc\] The user changed the brain model/)
    expect(text).toContain('not new requests')
    expect(text?.indexOf('User: Plan billing')).toBeLessThan(
      text?.indexOf('Brain: Start with invoices') ?? -1
    )
    expect(text).not.toContain('left out')
  })

  it('leaves out system messages, plan cards, empty and still-streaming messages', () => {
    const text = buildHandoffPreamble([
      msg('user', 'keep me'),
      msg('system', 'Continue workers?'),
      msg('brain', 'Proposed plan: 1 worker (api)', { planId: 'p1' }),
      msg('brain', '   '),
      msg('brain', 'half a rep', { state: 'streaming' }),
      msg('brain', 'stopped but kept', { state: 'stopped' })
    ])
    expect(text).toContain('User: keep me')
    expect(text).toContain('Brain: stopped but kept')
    expect(text).not.toContain('Continue workers')
    expect(text).not.toContain('Proposed plan')
    expect(text).not.toContain('half a rep')
  })

  it('is undefined when nothing can be handed over', () => {
    expect(buildHandoffPreamble([])).toBeUndefined()
    expect(buildHandoffPreamble([msg('system', 'x'), msg('brain', '')])).toBeUndefined()
  })

  it('caps the whole text, keeping the newest messages and saying older ones are left out', () => {
    const messages = Array.from({ length: 40 }, (_, i) =>
      msg(i % 2 === 0 ? 'user' : 'brain', `message ${i} ${'x'.repeat(400)}`)
    )
    const text = buildHandoffPreamble(messages) ?? ''
    expect(text.length).toBeLessThanOrEqual(HANDOFF_MAX_CHARS)
    expect(text).toContain('message 39 ')
    expect(text).not.toContain('message 0 ')
    expect(text).toContain('(Earlier messages are left out.)')
    // Still in order.
    expect(text.indexOf('message 38 ')).toBeLessThan(text.indexOf('message 39 '))
  })

  it('clips one very long message so it does not push the rest out', () => {
    const text =
      buildHandoffPreamble([msg('user', 'first question'), msg('brain', 'y'.repeat(20_000))]) ?? ''
    expect(text.length).toBeLessThanOrEqual(HANDOFF_MAX_CHARS)
    expect(text).toContain('User: first question')
    expect(text).toContain('…')
  })

  it('honours a smaller cap', () => {
    const text = buildHandoffPreamble(
      [msg('user', 'a'.repeat(300)), msg('brain', 'b'.repeat(300))],
      700
    )
    expect(text?.length).toBeLessThanOrEqual(700)
  })
})
