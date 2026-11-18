import { createReadStream } from 'node:fs'
import { Readable } from 'node:stream'
import { protocol } from 'electron'
import { VOICE_MODEL_SCHEME, resolveVoiceModelRequest } from './voice-model-request'
import type { VoiceModelRequestDeps } from './voice-model-request'

// The renderer page is a file:// origin, so fetch() needs CORS to read any response.
const CORS = { 'Access-Control-Allow-Origin': '*' }

/** Call after the app is ready. */
export function handleVoiceModelProtocol(deps: VoiceModelRequestDeps): void {
  protocol.handle(VOICE_MODEL_SCHEME, async (request) => {
    const result = await resolveVoiceModelRequest(
      { method: request.method, url: request.url, range: request.headers.get('range') },
      deps
    )
    if ((result.status !== 200 && result.status !== 206) || !result.filePath) {
      return new Response(null, { status: result.status, headers: { ...result.headers, ...CORS } })
    }
    try {
      // Streamed from disk: the 326 MB model is never held in memory whole.
      const body = Readable.toWeb(
        createReadStream(result.filePath, result.range)
      ) as ReadableStream<Uint8Array>
      return new Response(body, {
        status: result.status,
        headers: { ...result.headers, ...CORS }
      })
    } catch {
      deps.log?.warn('voice model protocol read failed')
      return new Response(null, { status: 404, headers: CORS })
    }
  })
}
