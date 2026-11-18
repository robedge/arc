/**
 * Whisper writes non-speech as bracketed tags ("[BLANK_AUDIO]", "[Music]", "(silence)") or music
 * notes, and sometimes `*sighs*`. None of that is something the user said.
 */
export function cleanTranscript(raw: string): string {
  return raw
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\*[^*]*\*/g, ' ')
    .replace(/[♪♫]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
