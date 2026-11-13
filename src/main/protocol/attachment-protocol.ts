import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { protocol } from 'electron'
import { ATTACHMENT_SCHEME, resolveAttachmentRequest } from './attachment-request'
import type { AttachmentRequestDeps } from './attachment-request'

// The renderer page is a file:// origin, so fetch() needs CORS to read any response.
const CORS = { 'Access-Control-Allow-Origin': '*' }

/** Call after the app is ready. The scheme itself is registered in `schemes.ts`. */
export function handleAttachmentProtocol(deps: AttachmentRequestDeps): void {
  protocol.handle(ATTACHMENT_SCHEME, async (request) => {
    const result = await resolveAttachmentRequest(request, deps)
    if (result.status !== 200 || !result.filePath)
      return new Response(null, { status: result.status, headers: CORS })
    try {
      const info = await stat(result.filePath)
      if (!info.isFile()) throw new Error('not a file')
      const body = Readable.toWeb(createReadStream(result.filePath)) as ReadableStream<Uint8Array>
      return new Response(body, {
        status: 200,
        headers: { ...result.headers, 'Content-Length': String(info.size), ...CORS }
      })
    } catch {
      deps.log?.warn('attachment protocol read failed')
      return new Response(null, { status: 404, headers: CORS })
    }
  })
}
