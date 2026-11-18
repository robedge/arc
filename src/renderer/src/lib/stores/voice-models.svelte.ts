import type {
  VoiceErrorCode,
  VoiceModelKind,
  VoiceModelProgress,
  VoiceModelState,
  VoiceModelStatus
} from '@shared/types/voice'

export type VoiceModelErrorCode = Extract<VoiceErrorCode, 'offline' | 'model-corrupt'>

/** Plain-language names for the three speech models. */
export const voiceModelNames: Record<VoiceModelKind, string> = {
  tts: "Nova's voice",
  'stt-stream': 'Live words',
  'stt-final': 'Speech recognition'
}

export const voiceErrorMessages: Record<VoiceModelErrorCode, string> = {
  offline: "Couldn't download the voice models. Check your connection and try again.",
  'model-corrupt': "A voice model didn't download correctly. Try again."
}

export interface VoiceModelRow {
  id: string
  kind: VoiceModelKind
  state: VoiceModelState
  /** Bytes on disk so far. */
  bytes: number
  totalBytes: number
}

export function percentOf(row: Pick<VoiceModelRow, 'bytes' | 'totalBytes'>): number {
  if (row.totalBytes <= 0) return 0
  return Math.max(0, Math.min(100, Math.floor((row.bytes / row.totalBytes) * 100)))
}

/** The speech models on disk; main (the model manager) stays the source of truth. */
export class VoiceModelsStore {
  models = $state<VoiceModelRow[]>([])
  error = $state<VoiceModelErrorCode | null>(null)
  /** Stub models (e2e): Nova then uses its stub speech engine too. */
  fake = $state(false)

  get isDownloading(): boolean {
    return this.models.some((m) => m.state === 'downloading')
  }
  get hasMissing(): boolean {
    return this.models.some((m) => m.state !== 'ready')
  }
  get allReady(): boolean {
    return this.models.length > 0 && this.models.every((m) => m.state === 'ready')
  }
  /** Nova's voice (the Kokoro model) is on disk; speech output needs nothing else. */
  get ttsReady(): boolean {
    return this.models.some((m) => m.kind === 'tts' && m.state === 'ready')
  }
  get totalBytes(): number {
    return this.models.reduce((sum, m) => sum + m.totalBytes, 0)
  }
  /** The download size in MB, rounded to the nearest 10. */
  get totalMb(): number {
    return Math.round(this.totalBytes / 1_000_000 / 10) * 10
  }
  get percent(): number {
    return percentOf({
      bytes: this.models.reduce((sum, m) => sum + m.bytes, 0),
      totalBytes: this.totalBytes
    })
  }

  /** Seeds rows without IPC (Design Preview). */
  seed(models: VoiceModelRow[], error: VoiceModelErrorCode | null = null): void {
    this.models = models
    this.error = error
  }

  async load(): Promise<void> {
    const result = await window.arc.invoke('voice:models-status', {})
    if (result.ok) {
      this.models = (result.data.models ?? []).map(toRow)
      this.fake = result.data.fake === true
    }
  }

  async download(): Promise<void> {
    this.error = null
    this.models = this.models.map((m) => (m.state === 'ready' ? m : { ...m, state: 'downloading' }))
    const result = await window.arc.invoke('voice:download-models', {})
    if (!result.ok) await this.load()
  }

  async remove(): Promise<void> {
    await window.arc.invoke('voice:delete-models', {})
    this.error = null
    await this.load()
  }

  /** `voice:model-progress`. */
  handleProgress(event: VoiceModelProgress): void {
    this.models = this.models.map((m) =>
      m.id === event.id
        ? {
            ...m,
            state: event.state,
            bytes: event.receivedBytes,
            totalBytes: event.totalBytes || m.totalBytes
          }
        : m
    )
  }

  /** `voice:error`. Only the two download failures belong here. */
  handleError(event: { code: VoiceErrorCode }): void {
    if (event.code !== 'offline' && event.code !== 'model-corrupt') return
    this.error = event.code
    // The download is over: no row may keep claiming it is running (the progress bar follows).
    this.models = this.models.map((m) =>
      m.state === 'downloading' ? { ...m, state: 'failed' } : m
    )
  }
}

function toRow(s: VoiceModelStatus): VoiceModelRow {
  return { id: s.id, kind: s.kind, state: s.state, bytes: s.bytes, totalBytes: s.totalBytes }
}

export const voiceModels = new VoiceModelsStore()
