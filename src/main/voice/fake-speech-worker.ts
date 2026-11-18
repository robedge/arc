import { createFakeWorker } from './fake-speech-engine'

// The utility-process entry used only when HARNESS_VOICE_ENGINE=fake under HARNESS_E2E (see speech-host).
const port = process.parentPort
const worker = createFakeWorker({
  env: process.env,
  post: (message) => port.postMessage(message),
  exit: (code) => process.exit(code)
})
port.on('message', (event) => worker.receive(event.data))
