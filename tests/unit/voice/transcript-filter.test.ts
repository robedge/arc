import { describe, expect, it } from 'vitest'
import { cleanTranscript } from '../../../src/main/voice/transcript-filter'

describe('cleanTranscript', () => {
  it.each([
    '[BLANK_AUDIO]',
    ' [Music] ',
    '(silence)',
    '(music)',
    '[ Silence ]',
    '♪',
    '*sighs*',
    ''
  ])('treats %j as nothing said', (raw) => expect(cleanTranscript(raw)).toBe(''))
  it('keeps real speech and drops tags around it', () => {
    expect(cleanTranscript(' Please open the Settings panel. ')).toBe(
      'Please open the Settings panel.'
    )
    expect(cleanTranscript('[BLANK_AUDIO] open the build [Music]')).toBe('open the build')
    expect(cleanTranscript('hello   (laughs)  there')).toBe('hello there')
  })
})
