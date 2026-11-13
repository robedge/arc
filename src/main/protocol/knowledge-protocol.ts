import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { protocol } from 'electron'
import { KNOWLEDGE_SCHEME, resolveKnowledgeRequest } from './knowledge-request'
import type { KnowledgeRequestDeps } from './knowledge-request'

// The renderer page is a file:// origin, so fetch() needs CORS to read any response.
const CORS = { 'Access-Control-Allow-Origin': '*' }

/** Call after the app is ready. */
export function handleKnowledgeProtocol(deps: KnowledgeRequestDeps): void {
  protocol.handle(KNOWLEDGE_SCHEME, async (request) => {
    const result = await resolveKnowledgeRequest(request, deps)
    if (result.status !== 200 || !result.filePath)
      return new Response(null, { status: result.status, headers: CORS })
    try {
      // Streamed from disk: a large PDF or image is never held in memory whole.
      const info = await stat(result.filePath)
      if (!info.isFile()) throw new Error('not a file')
      const body = Readable.toWeb(createReadStream(result.filePath)) as ReadableStream<Uint8Array>
      return new Response(body, {
        status: 200,
        headers: { ...result.headers, 'Content-Length': String(info.size), ...CORS }
      })
    } catch {
      deps.log?.warn('knowledge protocol read failed')
      return new Response(null, { status: 404, headers: CORS })
    }
  })
}
