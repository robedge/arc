import { z } from 'zod'
import { PROVIDER_IDS } from './types/provider'
import { KOKORO_VOICES } from './types/voice'

/** Voice settings (spec 016). Shared by the settings store and the IPC contract. */
export const voiceIdSchema = z.enum(KOKORO_VOICES)
export const voiceSpeedSchema = z.number().min(0.7).max(1.3)
export const voiceSpeakPolicySchema = z.enum(['all', 'spoken-only'])
export const voiceEndPauseMsSchema = z.number().min(500).max(2000)

/** A model with its provider. Shared by the settings store and the IPC contract. */
export const modelRefSchema = z
  .object({
    provider: z.enum(PROVIDER_IDS),
    model: z.string().min(1)
  })
  .strict()

/** The Workers choice: the brain picks, the brain picks within one provider, or one model is pinned. */
export const workersPrefSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('auto') }).strict(),
  z.object({ mode: z.literal('provider'), provider: z.enum(PROVIDER_IDS) }).strict(),
  z.object({ mode: z.literal('model'), model: modelRefSchema }).strict()
])

/** The item keys switched off per role (`agents.loadOff`); the caps keep a bad payload small. */
export const agentLoadOffSchema = z
  .object({
    brain: z.array(z.string().min(1).max(300)).max(1000),
    workers: z.array(z.string().min(1).max(300)).max(1000)
  })
  .strict()
