import { z } from 'zod'
import { VOICE_PCM_MAX_BYTES } from '@shared/ipc/contract'

/**
 * The messages between main and the speech utility process (`postMessage`). Both sides parse what
 * they receive; a message that does not match is dropped. Text and audio only ever travel here,
 * never into a log.
 */

const utteranceId = z.string().min(1).max(64)
const isArrayBuffer = (v: unknown): v is ArrayBuffer =>
  Object.prototype.toString.call(v) === '[object ArrayBuffer]'

export const toWorkerSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('init'),
    modelPaths: z
      .object({
        whisper: z.string().min(1),
        /** The folder of the streaming Zipformer; left out while that model is not ready (no partials). */
        zipformer: z.string().min(1).optional()
      })
      .strict()
  }),
  z.object({ type: z.literal('begin'), utteranceId }),
  z.object({
    type: z.literal('pcm'),
    utteranceId,
    seq: z.number().int().min(0),
    samples: z
      .custom<ArrayBuffer>(isArrayBuffer)
      .refine((b) => b.byteLength <= VOICE_PCM_MAX_BYTES && b.byteLength % 2 === 0)
  }),
  z.object({ type: z.literal('end'), utteranceId }),
  z.object({ type: z.literal('cancel'), utteranceId }),
  z.object({ type: z.literal('shutdown') })
])

/** Failures a worker can name; the host turns them into the `voice:error` codes of the same name. */
export const workerErrorCodeSchema = z.enum(['model-corrupt', 'engine-crashed'])

export const fromWorkerSchema = z.discriminatedUnion('type', [
  /** `partials: false` means the Zipformer was asked for but could not load; Whisper still works. */
  z.object({ type: z.literal('ready'), partials: z.boolean().optional() }),
  /** The words heard so far in an open utterance; never the final text. */
  z.object({ type: z.literal('partial'), utteranceId, text: z.string() }),
  z.object({ type: z.literal('final'), utteranceId, text: z.string() }),
  z.object({
    type: z.literal('error'),
    utteranceId: utteranceId.optional(),
    code: workerErrorCodeSchema
  })
])

export type ToWorker = z.infer<typeof toWorkerSchema>
export type FromWorker = z.infer<typeof fromWorkerSchema>
