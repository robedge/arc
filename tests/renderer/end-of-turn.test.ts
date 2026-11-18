// @spec: 016-voice-companion
import { describe, expect, it } from 'vitest'
import { holdMs, judgeEnd } from '../../src/renderer/src/lib/nova/end-of-turn'

describe('judgeEnd', () => {
  it.each([
    'i want to',
    'and',
    'so',
    'um',
    'uh',
    'er',
    'like',
    'I think the',
    'can you',
    'tell me about my',
    'is',
    'maybe',
    'because',
    'i want',
    'what about'
  ])('sounds unfinished after "%s"', (text) => expect(judgeEnd(text)).toBe('unfinished'))
  it('treats empty and punctuation-only text as unfinished', () => {
    expect(judgeEnd('')).toBe('unfinished')
    expect(judgeEnd('  ...  ')).toBe('unfinished')
  })
  it.each(['what time is it', 'open the settings panel', 'stop the workers', 'thanks'])(
    'sounds finished after "%s"',
    (text) => expect(judgeEnd(text)).toBe('finished')
  )
  it('ignores case and trailing punctuation', () => {
    expect(judgeEnd('Do it, AND.')).toBe('unfinished')
    expect(judgeEnd('Show me the diff!')).toBe('finished')
  })
})

describe('holdMs', () => {
  it('is the short hold when finished and three times it when unfinished', () => {
    expect(holdMs('what time is it', 1000)).toBe(1000)
    expect(holdMs('i want to', 1000)).toBe(3000)
    expect(holdMs('', 700)).toBe(2100)
  })
})
