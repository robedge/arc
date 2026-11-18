import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFakeWorker } from '../../../src/main/voice/fake-speech-engine'
import { createSpeechCore } from '../../../src/main/voice/speech-core'
import { SpeechHost } from '../../../src/main/voice/speech-host'
import type { SpeechWorkerHandle } from '../../../src/main/voice/speech-host'

const MARKER = 'TRANSCRIPT-MARKER-9917'
const LOUD = new Int16Array(1600).fill(9000).buffer

afterEach(() => vi.restoreAllMocks())

/** Every argument of every call, errors expanded the way a log file would write them. */
const flat = (calls: unknown[][]): string =>
  JSON.stringify(
    calls.map((args) =>
      args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}\n${a.stack ?? ''}` : a))
    )
  )

function loopback(
  make: (post: (m: unknown) => void, exit: (c: number) => void) => { receive: (m: unknown) => void }
) {
  return (): SpeechWorkerHandle => {
    let onMessage: (m: unknown) => void = () => undefined
    let onExit: (c: number) => void = () => undefined
    const w = make(
      (m) => queueMicrotask(() => onMessage(m)),
      (c) => queueMicrotask(() => onExit(c))
    )
    return {
      postMessage: (m) => w.receive(m),
      onMessage: (l) => (onMessage = l),
      onExit: (l) => (onExit = l),
      kill: () => undefined
    }
  }
}

describe('no transcript or audio reaches a log', () => {
  it('through the host, the worker core, failures and the console', async () => {
    const hostLog = { debug: vi.fn(), warn: vi.fn() }
    const consoleCalls = vi.fn()
    for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, m).mockImplementation(consoleCalls)
    }
    const posted: unknown[] = []
    const events: unknown[] = []
    // One engine that recognises the marker, then one whose failure message carries it.
    let calls = 0
    const fork = loopback((post, exit) => {
      const core = createSpeechCore({
        engine: {
          load: () => Promise.resolve(),
          transcribe: () =>
            ++calls === 1
              ? Promise.resolve(MARKER)
              : Promise.reject(new Error(`failed on ${MARKER}`)),
          release: () => Promise.resolve()
        },
        post: (m) => {
          posted.push(m)
          post(m)
        },
        exit
      })
      return core
    })
    const host = new SpeechHost({
      fork,
      whisperModelPath: () => Promise.resolve('/models/ggml-base.en.bin'),
      zipformerModelPath: () => Promise.resolve(undefined),
      emitPartial: (p) => events.push(p),
      emitState: (s) => events.push(s),
      emitError: (e) => events.push(e),
      log: hostLog
    })
    await host.open()
    await host.beginUtterance('u1')
    host.pcm('u1', 0, LOUD)
    await expect(host.endUtterance('u1')).resolves.toBe(MARKER)
    await host.beginUtterance('u2')
    host.pcm('u2', 0, LOUD)
    await expect(host.endUtterance('u2')).rejects.toBeDefined()
    host.close()

    const everything = flat([
      ...hostLog.debug.mock.calls,
      ...hostLog.warn.mock.calls,
      ...consoleCalls.mock.calls
    ])
    expect(everything).not.toContain(MARKER)
    expect(everything).not.toContain('MARKER')
    // The error that leaves the process names a code, not the engine's message.
    expect(JSON.stringify(events)).not.toContain('MARKER')
    expect(
      JSON.stringify(posted.filter((m) => (m as { type: string }).type === 'error'))
    ).not.toContain('MARKER')
  })

  it('the fake worker path logs nothing either', async () => {
    const hostLog = { debug: vi.fn(), warn: vi.fn() }
    const host = new SpeechHost({
      fork: loopback((post, exit) =>
        createFakeWorker({ env: { HARNESS_FAKE_TRANSCRIPT: MARKER }, post, exit })
      ),
      whisperModelPath: () => Promise.resolve('/m'),
      zipformerModelPath: () => Promise.resolve(undefined),
      emitPartial: () => undefined,
      emitState: () => undefined,
      emitError: () => undefined,
      log: hostLog
    })
    await host.open()
    await host.beginUtterance('u')
    host.pcm('u', 0, LOUD)
    await host.endUtterance('u')
    expect(flat([...hostLog.debug.mock.calls, ...hostLog.warn.mock.calls])).not.toContain('MARKER')
  })

  it('the speech sources never write to the console', () => {
    const dir = join(import.meta.dirname, '../../../src/main/voice')
    const speech = readdirSync(dir).filter((f) => /^(speech|fake-speech|transcript|mic)/.test(f))
    expect(speech.length).toBeGreaterThan(5)
    for (const file of speech) {
      expect(readFileSync(join(dir, file), 'utf8'), file).not.toMatch(/console\./)
    }
  })
})
