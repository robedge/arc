import { describe, expect, it, vi } from 'vitest'
import { createSpeechCore, ModelLoadError } from '../../../src/main/voice/speech-core'
import type { SpeechEngine } from '../../../src/main/voice/speech-core'
import type { FromWorker } from '../../../src/main/voice/speech-protocol'

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function core(engine: SpeechEngine) {
  const posted: FromWorker[] = []
  const exit = vi.fn()
  const c = createSpeechCore({ engine, post: (m) => posted.push(m), exit })
  return { ...c, posted, exit }
}

const engineOf = (over: Partial<SpeechEngine> = {}): SpeechEngine => ({
  load: () => Promise.resolve(),
  transcribe: () => Promise.resolve(' hello '),
  release: () => Promise.resolve(),
  ...over
})

describe('speech core', () => {
  it('joins the chunks of an utterance in order and filters the text', async () => {
    const seen: number[][] = []
    const c = core(
      engineOf({
        transcribe: (pcm) => {
          seen.push([...pcm])
          return Promise.resolve('[BLANK_AUDIO] hi there')
        }
      })
    )
    c.receive({ type: 'init', modelPaths: { whisper: '/m' } })
    c.receive({ type: 'begin', utteranceId: 'u' })
    c.receive({
      type: 'pcm',
      utteranceId: 'u',
      seq: 0,
      samples: new Int16Array([1000, 2000]).buffer
    })
    c.receive({ type: 'pcm', utteranceId: 'u', seq: 1, samples: new Int16Array([3000]).buffer })
    c.receive({ type: 'end', utteranceId: 'u' })
    await tick()
    expect(seen).toEqual([[1000, 2000, 3000]])
    expect(c.posted).toEqual([
      { type: 'ready' },
      { type: 'final', utteranceId: 'u', text: 'hi there' }
    ])
  })

  it('answers digital silence without asking the engine, which would invent words for it', async () => {
    const transcribe = vi.fn(() => Promise.resolve('you'))
    const c = core(engineOf({ transcribe }))
    c.receive({ type: 'init', modelPaths: { whisper: '/m' } })
    c.receive({ type: 'begin', utteranceId: 'u' })
    c.receive({ type: 'pcm', utteranceId: 'u', seq: 0, samples: new Int16Array(1600).buffer })
    c.receive({ type: 'end', utteranceId: 'u' })
    await tick()
    expect(transcribe).not.toHaveBeenCalled()
    expect(c.posted[1]).toEqual({ type: 'final', utteranceId: 'u', text: '' })
  })

  it('names a model that will not load, and any other load failure as a crash', async () => {
    const bad = core(engineOf({ load: () => Promise.reject(new ModelLoadError('x')) }))
    bad.receive({ type: 'init', modelPaths: { whisper: '/m' } })
    const other = core(engineOf({ load: () => Promise.reject(new Error('boom')) }))
    other.receive({ type: 'init', modelPaths: { whisper: '/m' } })
    await tick()
    expect(bad.posted).toEqual([{ type: 'error', code: 'model-corrupt' }])
    expect(other.posted).toEqual([{ type: 'error', code: 'engine-crashed' }])
  })

  it('answers a failing transcription with an error for that utterance and carries on', async () => {
    let calls = 0
    const c = core(
      engineOf({
        transcribe: () =>
          ++calls === 1 ? Promise.reject(new Error('SECRET words')) : Promise.resolve('ok')
      })
    )
    c.receive({ type: 'init', modelPaths: { whisper: '/m' } })
    for (const id of ['a', 'b']) {
      c.receive({ type: 'begin', utteranceId: id })
      c.receive({
        type: 'pcm',
        utteranceId: id,
        seq: 0,
        samples: new Int16Array(4).fill(500).buffer
      })
      c.receive({ type: 'end', utteranceId: id })
    }
    await tick()
    expect(c.posted.slice(1)).toEqual([
      { type: 'error', utteranceId: 'a', code: 'engine-crashed' },
      { type: 'final', utteranceId: 'b', text: 'ok' }
    ])
    expect(JSON.stringify(c.posted)).not.toContain('SECRET')
  })

  it('ignores invalid messages and audio for an utterance that was never begun, and exits on shutdown', async () => {
    const c = core(engineOf())
    c.receive({ type: 'nonsense' })
    c.receive({ type: 'pcm', utteranceId: 'x', seq: 0, samples: new Int16Array(2).buffer })
    c.receive({ type: 'end', utteranceId: 'x' })
    c.receive({ type: 'shutdown' })
    await tick()
    expect(c.posted).toEqual([])
    expect(c.exit).toHaveBeenCalledWith(0)
  })
})

describe('speech core partials', () => {
  /** An engine whose stream "hears" one word per chunk of 1000 samples. */
  function streaming(words: string[]): SpeechEngine & { resets: number } {
    let heard = 0
    const e: SpeechEngine & { resets: number } = {
      resets: 0,
      load: () => Promise.resolve(),
      transcribe: () => Promise.resolve('final text'),
      release: () => Promise.resolve(),
      streamReset: () => {
        e.resets += 1
        heard = 0
      },
      streamPcm: () => words.slice(0, ++heard).join(' ')
    }
    return e
  }
  const pcm = (utteranceId: string, seq: number) =>
    ({ type: 'pcm', utteranceId, seq, samples: new Int16Array(1600).fill(500).buffer }) as const

  function partialCore(engine: SpeechEngine, now: () => number, minGapMs = 150) {
    const posted: FromWorker[] = []
    const c = createSpeechCore({
      engine,
      post: (m) => posted.push(m),
      exit: vi.fn(),
      now,
      partialGapMs: minGapMs
    })
    return { ...c, posted }
  }
  const partialsOf = (posted: FromWorker[]) =>
    posted.filter((m) => m.type === 'partial').map((m) => (m as { text: string }).text)

  it('posts changed partials in order, trimmed and with spaces collapsed, then the final', async () => {
    let t = 0
    const c = partialCore(streaming(['  open ', '', 'the', 'panel']), () => (t += 200))
    c.receive({ type: 'init', modelPaths: { whisper: '/m' } })
    c.receive({ type: 'begin', utteranceId: 'u' })
    for (let i = 0; i < 4; i++) c.receive(pcm('u', i))
    c.receive({ type: 'end', utteranceId: 'u' })
    await tick()
    expect(partialsOf(c.posted)).toEqual(['open', 'open the', 'open the panel'])
    expect(c.posted.at(-1)).toEqual({ type: 'final', utteranceId: 'u', text: 'final text' })
  })

  it('posts at most one partial per gap', async () => {
    let t = 0
    const c = partialCore(streaming(['a', 'b', 'c', 'd', 'e', 'f']), () => (t += 50))
    c.receive({ type: 'init', modelPaths: { whisper: '/m' } })
    c.receive({ type: 'begin', utteranceId: 'u' })
    for (let i = 0; i < 6; i++) c.receive(pcm('u', i))
    await tick()
    // 50 ms per chunk, 150 ms gap: the 1st chunk, then every third.
    expect(partialsOf(c.posted)).toEqual(['a', 'a b c d'])
  })

  it('posts no partial after end or cancel, and resets the stream at begin, end and cancel', async () => {
    const engine = streaming(['a', 'b', 'c'])
    const c = partialCore(engine, () => 1000)
    c.receive({ type: 'init', modelPaths: { whisper: '/m' } })
    c.receive({ type: 'begin', utteranceId: 'u' })
    c.receive({ type: 'end', utteranceId: 'u' })
    c.receive(pcm('u', 0))
    c.receive({ type: 'begin', utteranceId: 'v' })
    c.receive({ type: 'cancel', utteranceId: 'v' })
    c.receive(pcm('v', 0))
    await tick()
    expect(partialsOf(c.posted)).toEqual([])
    expect(engine.resets).toBe(4)
  })

  it('keeps going without partials when the stream throws', async () => {
    const engine = streaming(['a'])
    engine.streamPcm = () => {
      throw new Error('MARKER')
    }
    const c = partialCore(engine, () => 1000)
    c.receive({ type: 'init', modelPaths: { whisper: '/m' } })
    c.receive({ type: 'begin', utteranceId: 'u' })
    c.receive(pcm('u', 0))
    c.receive({ type: 'end', utteranceId: 'u' })
    await tick()
    expect(partialsOf(c.posted)).toEqual([])
    expect(c.posted.at(-1)).toEqual({ type: 'final', utteranceId: 'u', text: 'final text' })
  })

  it('tells the host when the engine loaded without partials', async () => {
    const engine = streaming(['a'])
    engine.load = () => Promise.resolve({ partials: false })
    const c = partialCore(engine, () => 0)
    c.receive({ type: 'init', modelPaths: { whisper: '/m' } })
    await tick()
    expect(c.posted).toEqual([{ type: 'ready', partials: false }])
  })
})
