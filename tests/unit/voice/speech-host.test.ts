import { describe, expect, it, vi } from 'vitest'
import { FAKE_CRASH_UTTERANCE, createFakeWorker } from '../../../src/main/voice/fake-speech-engine'
import { SPEECH_IDLE_MS, SpeechHost } from '../../../src/main/voice/speech-host'
import type { SpeechWorkerHandle } from '../../../src/main/voice/speech-host'
import type { ToWorker } from '../../../src/main/voice/speech-protocol'
import type { VoiceEngineState } from '../../../src/shared/types/voice'

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const LOUD = new Int16Array(1600).fill(8000).buffer
const QUIET = new Int16Array(1600).fill(3).buffer

interface Loopback extends SpeechWorkerHandle {
  killed: boolean
  received: ToWorker[]
  /** Dies like a crashed process. */
  crash(code?: number): void
  /** With `defer`, messages wait here until released (the model is "loading"). */
  release(): void
}

/** A speech worker running in this process: the real core around the fake engine. */
function loopbackFork(env: Record<string, string | undefined>, opts: { defer?: boolean } = {}) {
  const forks: Loopback[] = []
  const fork = (): SpeechWorkerHandle => {
    let onMessage: (m: unknown) => void = () => undefined
    let onExit: (code: number) => void = () => undefined
    let deferred: ToWorker[] | undefined = opts.defer ? [] : undefined
    const worker = createFakeWorker({
      env,
      post: (m) => queueMicrotask(() => onMessage(m)),
      exit: (code) => queueMicrotask(() => onExit(code))
    })
    const handle: Loopback = {
      killed: false,
      received: [],
      postMessage(message) {
        handle.received.push(message)
        if (deferred) deferred.push(message)
        else worker.receive(message)
      },
      onMessage: (l) => (onMessage = l),
      onExit: (l) => (onExit = l),
      kill() {
        handle.killed = true
        // A real process reports its exit after it is killed.
        queueMicrotask(() => onExit(0))
      },
      crash: (code = 1) => queueMicrotask(() => onExit(code)),
      release() {
        const queued = deferred ?? []
        deferred = undefined
        for (const m of queued) worker.receive(m)
      }
    }
    forks.push(handle)
    return handle
  }
  return { fork, forks }
}

function manualTimers() {
  const timers = new Map<number, { fn: () => void; ms: number }>()
  let next = 1
  return {
    setTimer: (fn: () => void, ms: number): unknown => {
      timers.set(next, { fn, ms })
      return next++
    },
    clearTimer: (h: unknown): void => {
      timers.delete(h as number)
    },
    /** Runs the timers of that length (the idle clock or the start timeout). */
    fire(ms: number): void {
      for (const [id, t] of [...timers]) {
        if (t.ms === ms) {
          timers.delete(id)
          t.fn()
        }
      }
    },
    count: (ms: number): number => [...timers.values()].filter((t) => t.ms === ms).length
  }
}

function setup(
  opts: {
    env?: Record<string, string>
    defer?: boolean
    modelReady?: boolean
    zipformer?: boolean
  } = {}
) {
  const loop = loopbackFork(opts.env ?? {}, { defer: opts.defer ?? false })
  const timers = manualTimers()
  const states: VoiceEngineState[] = []
  const errors: { code: string; utteranceId?: string }[] = []
  const partials: { utteranceId: string; text: string }[] = []
  const log = { debug: vi.fn(), warn: vi.fn() }
  const host = new SpeechHost({
    fork: loop.fork,
    whisperModelPath: () =>
      Promise.resolve(opts.modelReady === false ? undefined : '/models/ggml-base.en.bin'),
    zipformerModelPath: () => Promise.resolve(opts.zipformer === false ? undefined : '/models/zip'),
    emitState: (s) => states.push(s),
    emitError: (e) => errors.push(e),
    emitPartial: (p) => partials.push(p),
    log,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer
  })
  return { host, loop, timers, states, errors, partials, log }
}

describe('SpeechHost lifecycle', () => {
  it('starts lazily: nothing forks until open, and a second open reuses the process', async () => {
    const t = setup()
    expect(t.loop.forks).toHaveLength(0)
    await t.host.open()
    await tick()
    await t.host.open()
    expect(t.loop.forks).toHaveLength(1)
    expect(t.states).toEqual(['starting', 'ready'])
    expect(t.loop.forks[0]?.received[0]).toEqual({
      type: 'init',
      modelPaths: { whisper: '/models/ggml-base.en.bin', zipformer: '/models/zip' }
    })
  })

  it('opens with Whisper alone while the Zipformer is not ready, and says so by code', async () => {
    const t = setup({ zipformer: false })
    await t.host.open()
    expect(t.loop.forks[0]?.received[0]).toEqual({
      type: 'init',
      modelPaths: { whisper: '/models/ggml-base.en.bin' }
    })
    expect(t.log.debug).toHaveBeenCalledWith('speech partials off: zipformer not ready')
  })

  it('refuses to open while the Whisper model is not ready, and forks nothing', async () => {
    const t = setup({ modelReady: false })
    await expect(t.host.open()).rejects.toMatchObject({ code: 'VOICE_MODEL_MISSING' })
    expect(t.loop.forks).toHaveLength(0)
    expect(t.states).toEqual([])
  })

  it('returns the text of a whole utterance, and an empty string for near-silent audio', async () => {
    const t = setup()
    await t.host.open()
    await t.host.beginUtterance('u1')
    t.host.pcm('u1', 0, LOUD)
    t.host.pcm('u1', 1, LOUD)
    await expect(t.host.endUtterance('u1')).resolves.toBe('What are the workers doing right now?')
    await t.host.beginUtterance('u2')
    t.host.pcm('u2', 0, QUIET)
    await expect(t.host.endUtterance('u2')).resolves.toBe('')
  })

  it('treats Whisper non-speech tokens as nothing said', async () => {
    const t = setup({ env: { HARNESS_FAKE_TRANSCRIPT: '[BLANK_AUDIO]' } })
    await t.host.open()
    await t.host.beginUtterance('u1')
    t.host.pcm('u1', 0, LOUD)
    await expect(t.host.endUtterance('u1')).resolves.toBe('')
  })

  it('discards a cancelled utterance and its audio', async () => {
    const t = setup()
    await t.host.open()
    await t.host.beginUtterance('u1')
    t.host.pcm('u1', 0, LOUD)
    t.host.cancelUtterance('u1')
    await expect(t.host.endUtterance('u1')).rejects.toBeDefined()
  })

  it('queues begin, audio and end that arrive while the model is still loading', async () => {
    const t = setup({ defer: true })
    await t.host.open()
    expect(t.host.engineState).toBe('starting')
    await t.host.beginUtterance('u1')
    t.host.pcm('u1', 0, LOUD)
    const text = t.host.endUtterance('u1')
    t.loop.forks[0]?.release()
    await expect(text).resolves.toBe('What are the workers doing right now?')
    expect(t.host.engineState).toBe('ready')
  })

  it('stops after 60 seconds with no activity, without an error or a restart', async () => {
    const t = setup()
    await t.host.open()
    await tick()
    expect(t.timers.count(SPEECH_IDLE_MS)).toBe(1)
    t.timers.fire(SPEECH_IDLE_MS)
    await tick()
    expect(t.loop.forks[0]?.killed).toBe(true)
    expect(t.host.engineState).toBe('off')
    expect(t.states).toEqual(['starting', 'ready', 'off'])
    expect(t.errors).toEqual([])
    expect(t.loop.forks).toHaveLength(1)
  })

  it('does not go idle mid-utterance, and the next utterance after an idle stop restarts it', async () => {
    const t = setup()
    await t.host.open()
    await t.host.beginUtterance('u1')
    expect(t.timers.count(SPEECH_IDLE_MS)).toBe(0)
    t.host.pcm('u1', 0, LOUD)
    await t.host.endUtterance('u1')
    expect(t.timers.count(SPEECH_IDLE_MS)).toBe(1)
    t.timers.fire(SPEECH_IDLE_MS)
    await tick()
    await t.host.beginUtterance('u2')
    expect(t.loop.forks).toHaveLength(2)
  })

  it('stops on close and on dispose, and refuses a transcription still waiting', async () => {
    const t = setup({ defer: true })
    await t.host.open()
    await t.host.beginUtterance('u1')
    t.host.pcm('u1', 0, LOUD)
    const waiting = t.host.endUtterance('u1')
    t.host.close()
    await expect(waiting).rejects.toBeDefined()
    await tick()
    expect(t.host.engineState).toBe('off')
    expect(t.loop.forks).toHaveLength(1)
    expect(t.errors).toEqual([])
    await t.host.open()
    t.host.dispose()
    expect(t.loop.forks[1]?.killed).toBe(true)
  })

  it('restarts once after a crash, then reports engine-crashed', async () => {
    const t = setup()
    await t.host.open()
    await tick()
    await t.host.beginUtterance(FAKE_CRASH_UTTERANCE)
    await tick()
    await tick()
    // First crash: a silent restart.
    expect(t.loop.forks).toHaveLength(2)
    expect(t.errors).toEqual([])
    expect(t.host.engineState).toBe('ready')
    // The restarted worker is usable.
    await t.host.beginUtterance('u1')
    t.host.pcm('u1', 0, LOUD)
    await expect(t.host.endUtterance('u1')).resolves.toBe('What are the workers doing right now?')
    // A completed utterance means the engine is healthy again, so the next crash gets its restart too.
    await t.host.beginUtterance(FAKE_CRASH_UTTERANCE)
    await tick()
    await tick()
    expect(t.loop.forks).toHaveLength(3)
    // Crash again before anything finished: reported.
    await t.host.beginUtterance(FAKE_CRASH_UTTERANCE)
    await tick()
    await tick()
    expect(t.loop.forks).toHaveLength(3)
    expect(t.errors).toEqual([{ code: 'engine-crashed' }])
    expect(t.host.engineState).toBe('failed')
  })

  it('settles a transcription that was waiting when the engine crashed', async () => {
    const t = setup({ defer: true })
    await t.host.open()
    await t.host.beginUtterance('u1')
    t.host.pcm('u1', 0, LOUD)
    const waiting = t.host.endUtterance('u1')
    t.loop.forks[0]?.crash()
    await expect(waiting).rejects.toBeDefined()
    await tick()
    expect(t.loop.forks).toHaveLength(2)
  })

  it('reports a worker that never becomes ready', async () => {
    const t = setup({ defer: true })
    await t.host.open()
    t.timers.fire(30_000)
    await tick()
    expect(t.host.engineState).toBe('failed')
    expect(t.errors).toEqual([{ code: 'engine-crashed' }])
    expect(t.loop.forks[0]?.killed).toBe(true)
  })

  it('never logs the text it transcribed', async () => {
    const t = setup({ env: { HARNESS_FAKE_TRANSCRIPT: 'TRANSCRIPT-MARKER-4412' } })
    await t.host.open()
    await t.host.beginUtterance('u1')
    t.host.pcm('u1', 0, LOUD)
    await t.host.endUtterance('u1')
    expect(JSON.stringify([...t.log.debug.mock.calls, ...t.log.warn.mock.calls])).not.toContain(
      'MARKER'
    )
  })
})

describe('SpeechHost partial text', () => {
  it('emits the partials of an open utterance in order, before the final text', async () => {
    const t = setup({ env: { HARNESS_FAKE_TRANSCRIPT: 'open the settings panel' } })
    await t.host.open()
    await t.host.beginUtterance('u1')
    for (let seq = 0; seq < 4; seq++) t.host.pcm('u1', seq, LOUD)
    await tick() // the worker's partials travel while the utterance is still open
    const final = await t.host.endUtterance('u1')
    expect(t.partials).toEqual([
      { utteranceId: 'u1', text: 'open' },
      { utteranceId: 'u1', text: 'open the' },
      { utteranceId: 'u1', text: 'open the settings' },
      { utteranceId: 'u1', text: 'open the settings panel' }
    ])
    expect(final).toBe('open the settings panel')
  })

  it('emits no partial for silence, and none after the utterance was cancelled', async () => {
    const t = setup({ env: { HARNESS_FAKE_TRANSCRIPT: 'one two three' } })
    await t.host.open()
    await t.host.beginUtterance('q')
    t.host.pcm('q', 0, QUIET)
    t.host.cancelUtterance('q')
    t.host.pcm('q', 1, LOUD)
    await tick()
    expect(t.partials).toEqual([])
  })

  it('drops a partial that reaches main after the utterance ended', async () => {
    let onMessage: (m: unknown) => void = () => undefined
    const partials: unknown[] = []
    const host = new SpeechHost({
      fork: () => ({
        postMessage(m) {
          if (m.type === 'init') queueMicrotask(() => onMessage({ type: 'ready' }))
          if (m.type === 'end') {
            // The worker was still decoding: its last partial arrives behind the end.
            queueMicrotask(() => {
              onMessage({ type: 'partial', utteranceId: m.utteranceId, text: 'late words' })
              onMessage({ type: 'final', utteranceId: m.utteranceId, text: 'done' })
            })
          }
        },
        onMessage: (l) => (onMessage = l),
        onExit: () => undefined,
        kill: () => undefined
      }),
      whisperModelPath: () => Promise.resolve('/w'),
      zipformerModelPath: () => Promise.resolve(undefined),
      emitState: () => undefined,
      emitError: () => undefined,
      emitPartial: (p) => partials.push(p),
      log: { debug: vi.fn(), warn: vi.fn() }
    })
    await host.open()
    await host.beginUtterance('u')
    await expect(host.endUtterance('u')).resolves.toBe('done')
    expect(partials).toEqual([])
  })
})
