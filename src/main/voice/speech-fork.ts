import { join } from 'node:path'
import { utilityProcess } from 'electron'
import type { SpeechWorkerHandle } from './speech-host'

type Env = Readonly<Record<string, string | undefined>>

/** The stub engine only ever runs in an isolated e2e run, never in a user's real data folder. */
export function useFakeSpeechEngine(env: Env): boolean {
  return (
    env['HARNESS_VOICE_ENGINE'] === 'fake' &&
    env['HARNESS_E2E'] === '1' &&
    !!env['HARNESS_USER_DATA']
  )
}

/** Forks the speech worker entry that electron-vite emits next to `index.js`. */
export function forkSpeechWorker(env: Env): SpeechWorkerHandle {
  const entry = useFakeSpeechEngine(env) ? 'fake-speech-worker.js' : 'speech-worker.js'
  const child = utilityProcess.fork(join(import.meta.dirname, entry), [], {
    serviceName: 'Arc speech'
  })
  return {
    postMessage: (message) => child.postMessage(message),
    onMessage: (listener) => {
      child.on('message', listener)
    },
    onExit: (listener) => {
      child.on('exit', listener)
    },
    kill: () => {
      child.kill()
    }
  }
}
