import type { AppServices } from '../../app/app-services'
import { voiceLog } from '../../logging'
import { handle, listen } from '../register'

type VoiceServices = Pick<AppServices, 'voiceModels' | 'speechHost' | 'micAccess'>

export function registerVoiceHandlers(services: VoiceServices): void {
  const { voiceModels, speechHost, micAccess } = services
  handle('voice:models-status', async () => ({
    models: await voiceModels.status(),
    ...(voiceModels.isFake ? { fake: true } : {})
  }))
  // Returns as soon as the download runs; progress and failures arrive as events.
  handle('voice:download-models', () => {
    void voiceModels
      .download()
      .catch((error: unknown) =>
        voiceLog.error('voice model download crashed', error instanceof Error ? error.name : '')
      )
    return {}
  })
  handle('voice:delete-models', async () => {
    // The engine holds the Whisper file open.
    speechHost.close()
    await voiceModels.delete()
    return {}
  })
  handle('voice:mic-status', () => ({ status: micAccess.status() }))
  handle('voice:ask-mic', async () => ({ granted: await micAccess.ask() }))
  handle('voice:open-mic-settings', async () => {
    await micAccess.openSettings()
    return {}
  })
  handle('voice:open', async () => {
    await speechHost.open()
    return {}
  })
  handle('voice:close', () => {
    speechHost.close()
    return {}
  })
  handle('voice:begin-utterance', async ({ utteranceId }) => {
    await speechHost.beginUtterance(utteranceId)
    return {}
  })
  handle('voice:end-utterance', async ({ utteranceId }) => ({
    text: await speechHost.endUtterance(utteranceId)
  }))
  handle('voice:cancel-utterance', ({ utteranceId }) => {
    speechHost.cancelUtterance(utteranceId)
    return {}
  })
  listen('voice:pcm', ({ utteranceId, seq, samples }) => speechHost.pcm(utteranceId, seq, samples))
}
