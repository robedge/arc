import { stat } from 'node:fs/promises'
import type { VoiceModelSpec } from '../voice/model-manifest'

export const VOICE_MODEL_SCHEME = 'arc-voice-model'

export interface VoiceModelRequestDeps {
  manifest: readonly VoiceModelSpec[]
  /** Absolute path of a file of a complete model, or undefined while the model is not ready. */
  resolveFile: (model: VoiceModelSpec, relPath: string) => Promise<string | undefined>
  log?: { warn: (...args: unknown[]) => void }
}

export interface VoiceModelResponse {
  status: 200 | 206 | 404 | 405 | 416
  headers: Record<string, string>
  filePath?: string
  /** Inclusive byte range to read (206 only). */
  range?: { start: number; end: number }
}

const refuse = (
  status: 404 | 405 | 416,
  headers: Record<string, string> = {}
): VoiceModelResponse => ({
  status,
  headers
})

/** `bytes=a-b`, `bytes=a-`, `bytes=-n`. Anything else (several ranges, other units) is ignored. */
function parseRange(
  header: string,
  size: number
): 'none' | 'invalid' | { start: number; end: number } {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match || (match[1] === '' && match[2] === '')) return 'none'
  let start: number
  let end: number
  if (match[1] === '') {
    const suffix = Number(match[2])
    if (suffix === 0) return 'invalid'
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(match[1])
    end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1)
  }
  return start >= size || start > end ? 'invalid' : { start, end }
}

/**
 * Pure core of the `arc-voice-model://<modelId>/<file path>` handler. GET only. The model id must
 * be in the manifest and the path must be exactly one of its listed files, so no other path can be
 * named, and only a complete model is served.
 */
export async function resolveVoiceModelRequest(
  request: { method: string; url: string; range?: string | null },
  deps: VoiceModelRequestDeps
): Promise<VoiceModelResponse> {
  if (request.method !== 'GET') return refuse(405)
  try {
    const url = new URL(request.url)
    if (url.protocol !== `${VOICE_MODEL_SCHEME}:`) return refuse(404)
    const model = deps.manifest.find((m) => m.id === url.hostname)
    if (!model) return refuse(404)
    const relPath = decodeURIComponent(url.pathname.slice(1))
    if (!model.files.some((f) => f.path === relPath)) return refuse(404)
    const filePath = await deps.resolveFile(model, relPath)
    if (!filePath) return refuse(404)
    const info = await stat(filePath)
    if (!info.isFile()) return refuse(404)

    const base = {
      'Content-Type': 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache'
    }
    const range = request.range ? parseRange(request.range, info.size) : 'none'
    if (range === 'invalid') return refuse(416, { 'Content-Range': `bytes */${info.size}` })
    if (range === 'none') {
      return { status: 200, headers: { ...base, 'Content-Length': String(info.size) }, filePath }
    }
    return {
      status: 206,
      headers: {
        ...base,
        'Content-Length': String(range.end - range.start + 1),
        'Content-Range': `bytes ${range.start}-${range.end}/${info.size}`
      },
      filePath,
      range
    }
  } catch (error: unknown) {
    deps.log?.warn('voice model protocol request refused', error instanceof Error ? error.name : '')
    return refuse(404)
  }
}
