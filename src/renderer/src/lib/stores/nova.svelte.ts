import { untrack } from 'svelte'
import { shapeSpoken } from '@shared/spoken-text'
import type { AttentionView, BrainState, SessionEventEntry } from '@shared/types/session'
import type { KokoroVoiceId, VoiceSpeakPolicy } from '@shared/types/voice'
import { MicError } from '../nova/audio/listen-types'
import { messageFor } from '../ipc/messages'
import { Listener } from '../nova/listener'
import {
  SILENCE_MS,
  brainTurnChange,
  initialState,
  transition,
  type MachineEffect,
  type MachineEvent,
  type MachineState,
  type NovaMode
} from '../nova/machine'
import { getListenEngines, getPlayer, getTtsEngine } from '../nova/engines'
import { Speaker } from '../nova/speaker'
import { activeSession } from './active-session.svelte'
import { settings } from './settings.svelte'
import { voiceModels } from './voice-models.svelte'

export type NovaState = NovaMode

/** Why Nova cannot listen: no permission, no microphone, or it would not start. */
export type MicNotice = 'denied' | 'none' | 'failed'

const DEFAULT_END_PAUSE_MS = 1000

export const DETAILS_IN_CHAT = 'The details are in the chat.'
export const PREVIEW_SENTENCE = 'Hello, this is how I sound.'

const isBrainError = (e: SessionEventEntry): boolean =>
  e.kind === 'error' || e.kind === 'brain-stopped'

const DEFAULT_VOICE: KokoroVoiceId = 'af_heart'

class Nova {
  open = $state(false)
  state = $state<NovaState>('idle')
  muted = $state(false)
  /** The speech engine could not load or failed to speak; answers still appear in the chat. */
  ttsFailed = $state(false)
  /** Settings > Voice Preview is playing. */
  previewing = $state(false)
  /** What Nova last said for a brain answer (shown on the panel only with stub models, for e2e). */
  lastSpoken = $state('')
  /** Every sentence Nova started to say, in order (shown on the panel only with stub models, for e2e). */
  spokenLog = $state<string[]>([])
  /** Start conversation was clicked and the microphone and engine are still getting ready. */
  preparing = $state(false)
  /** A conversation is running: Nova listens again after every answer until End conversation. */
  conversation = $state(false)
  /** The user is speaking or the words are being recognised. */
  hearing = $state(false)
  /** Microphone level 0..1 for the live indicator. */
  micLevel = $state(0)
  /** What was recognised in the last spoken turn. */
  transcript = $state('')
  micNotice = $state<MicNotice | null>(null)
  /** The speech recogniser is not downloaded; the panel shows the download prompt. */
  modelMissing = $state(false)
  /** The recognised words could not be sent to the brain. */
  sendError = $state<string | null>(null)
  /** How long Nova listens with no speech before going Idle (tests shorten it). */
  silenceMs = SILENCE_MS

  private machine: MachineState = initialState({ muted: false, policy: 'all' })
  private prevBrain: BrainState = 'idle'
  private turnStartId: number | null = null
  private silenceTimer: ReturnType<typeof setTimeout> | null = null
  /** Bumped when a conversation start is abandoned (End, Close, a new start), so a late setup is undone. */
  private generation = 0
  // Bookkeeping for the alert announcer, never rendered: ids seen since the panel opened.
  private knownAttention = new Set<string>()
  private knownErrors = new Set<number>()
  private knownFor: string | null = null

  private readonly listener = new Listener(
    () => getListenEngines(),
    {
      canStart: () => this.machine.mode === 'listening' && this.machine.utterance === 'none',
      canBargeIn: () =>
        this.machine.mode === 'speaking' && this.machine.conversation && !this.machine.muted,
      onBargeIn: () => this.dispatch({ type: 'bargeIn' }),
      onSpeechStart: () => {
        this.transcript = ''
        this.dispatch({ type: 'speechStart' })
      },
      onSpeechEnd: () => this.dispatch({ type: 'speechEnd' }),
      onFinal: (text) => {
        if (text.trim() === '') {
          this.dispatch({ type: 'empty', speak: voiceModels.ttsReady })
        } else {
          this.transcript = text
          this.dispatch({ type: 'final', text })
        }
      },
      onLevel: (level) => {
        this.micLevel = level
      }
    },
    () => settings.values?.['voice.endPauseMs'] ?? DEFAULT_END_PAUSE_MS
  )

  private readonly speaker = new Speaker({
    engine: () => getTtsEngine(voiceModels.fake),
    player: () => getPlayer(),
    voice: () => this.voice,
    onDone: () => {
      this.previewing = false
      this.dispatch({ type: 'speakDone' })
    },
    onError: (error) => {
      this.previewing = false
      this.failTts(error)
      this.dispatch({ type: 'stop' })
    }
  })

  private get voice(): { voiceId: string; speed: number } {
    return {
      voiceId: settings.values?.['voice.voiceId'] ?? DEFAULT_VOICE,
      speed: settings.values?.['voice.speed'] ?? 1
    }
  }

  private get policy(): VoiceSpeakPolicy {
    return settings.values?.['voice.speakPolicy'] ?? 'all'
  }

  toggle(): void {
    if (this.open) this.close()
    else this.open = true
  }

  /** Closing the panel silences Nova and releases the microphone. */
  close(): void {
    this.generation++
    this.dispatch({ type: 'close' })
    this.open = false
  }

  /** Start conversation: checks the microphone permission, warms the engine and starts listening. */
  async startConversation(): Promise<void> {
    if (this.preparing || this.machine.conversation) return
    const generation = ++this.generation
    this.preparing = true
    this.micNotice = null
    this.modelMissing = false
    this.sendError = null
    try {
      if (!(await this.micAllowed())) {
        if (generation === this.generation) this.micNotice = 'denied'
        return
      }
      const engine = await window.arc.invoke('voice:open', {})
      if (generation !== this.generation) {
        void window.arc.invoke('voice:close', {})
        return
      }
      if (!engine.ok) {
        if (engine.error.code === 'VOICE_MODEL_MISSING') this.modelMissing = true
        else this.micNotice = 'failed'
        return
      }
      const started = await this.listener.start()
      if (!started) return
      if (generation !== this.generation) {
        // End or Close came while the microphone was opening: undo what just opened.
        this.listener.stop()
        void window.arc.invoke('voice:close', {})
        return
      }
      this.dispatch({ type: 'start' })
    } catch (error) {
      if (generation !== this.generation) return
      this.micNotice =
        error instanceof MicError
          ? error.reason === 'unavailable'
            ? 'none'
            : error.reason
          : 'failed'
      void window.arc.invoke('voice:close', {})
    } finally {
      if (generation === this.generation) this.preparing = false
    }
  }

  /** Whether the app may use the microphone, asking macOS the first time. */
  private async micAllowed(): Promise<boolean> {
    const status = await window.arc.invoke('voice:mic-status', {})
    if (!status.ok) return false
    if (status.data.status === 'granted') return true
    if (status.data.status !== 'not-determined') return false
    const asked = await window.arc.invoke('voice:ask-mic', {})
    return asked.ok && asked.data.granted
  }

  openMicSettings(): void {
    void window.arc.invoke('voice:open-mic-settings', {})
  }

  /** End conversation: stops listening and speaking. */
  endConversation(): void {
    this.generation++
    this.preparing = false
    this.dispatch({ type: 'end' })
  }

  /** Cancel: throws away what was said so far, sends nothing, and goes Idle. */
  cancel(): void {
    this.dispatch({ type: 'cancel' })
  }

  closeAndStop(): void {
    this.close()
  }

  stop(): void {
    this.dispatch({ type: 'stop' })
  }

  async setMuted(muted: boolean): Promise<void> {
    const before = this.muted
    this.muted = muted
    this.dispatch({ type: 'mute', muted })
    await settings.save({ 'voice.muted': muted })
    if (settings.error !== null) {
      // Saving failed: fall back to what was stored.
      this.muted = before
      this.dispatch({ type: 'mute', muted: before })
    }
  }

  /** The next brain turn answers something the user said aloud (Slice 5). */
  markNextTurnSpoken(): void {
    this.dispatch({ type: 'markSpoken' })
  }

  /** Settings > Voice: plays a sample sentence with the chosen voice and speed. */
  preview(): void {
    if (!voiceModels.ttsReady) return
    this.dispatch({ type: 'stop' })
    this.speaker.stop()
    this.previewing = true
    this.speaker.speak(PREVIEW_SENTENCE)
  }

  /** Starts watching the open session. Call from the panel's mount and run the result on unmount. */
  attach(): () => void {
    this.ttsFailed = false
    this.muted = settings.values?.['voice.muted'] ?? false
    this.machine = initialState({ muted: this.muted, policy: this.policy })
    this.state = 'idle'
    this.resetListening()
    this.prevBrain = activeSession.brainState
    this.turnStartId = null
    this.seedAlerts()
    const stopPartials = window.arc.on('voice:partial', (event) => this.onPartial(event))
    const stopWatching = $effect.root(() => {
      $effect(() => {
        const next = activeSession.brainState
        untrack(() => this.onBrainState(next))
      })
      $effect(() => {
        const key = activeSession.header?.id ?? null
        const queue = activeSession.queueAttention
        const events = activeSession.events
        untrack(() => this.onAlerts(key, queue, events))
      })
      $effect(() => {
        const policy = this.policy
        untrack(() => this.dispatch({ type: 'policy', policy }))
      })
      $effect(() => {
        const stored = settings.values?.['voice.muted']
        if (stored === undefined) return
        untrack(() => {
          this.muted = stored
          this.dispatch({ type: 'mute', muted: stored })
        })
      })
      $effect(() => {
        if (this.open && voiceModels.ttsReady) untrack(() => this.warm())
      })
    })
    return () => {
      stopWatching()
      stopPartials()
      this.dispatch({ type: 'close' })
    }
  }

  private seedAlerts(): void {
    this.knownFor = activeSession.header?.id ?? null
    this.knownAttention = new Set(activeSession.queueAttention.map((r) => r.id))
    this.knownErrors = new Set(activeSession.events.filter(isBrainError).map((e) => e.id))
  }

  /**
   * Says one sentence per batch: every new Needs attention item or brain error since the last run
   * marks its id known, and a batch of any size is announced once, and only when nothing else was
   * already waiting in Needs attention. Muted or voice not ready: nothing
   * is said, but the ids are still known, so unmuting later does not replay them.
   */
  private onAlerts(
    key: string | null,
    queue: AttentionView[],
    events: readonly SessionEventEntry[]
  ): void {
    if (key !== this.knownFor) {
      this.seedAlerts()
      return
    }
    const freshAttention = queue.filter((r) => !this.knownAttention.has(r.id))
    for (const r of freshAttention) this.knownAttention.add(r.id)
    const freshErrors = events.filter((e) => isBrainError(e) && !this.knownErrors.has(e.id))
    for (const e of freshErrors) this.knownErrors.add(e.id)
    if (!this.open || !voiceModels.ttsReady) return
    // Only when Needs attention was empty before: more items joining ones still waiting stay quiet.
    const wasEmpty = freshAttention.length === queue.length
    if (freshAttention.length > 0 && wasEmpty) this.dispatch({ type: 'attentionNew' })
    if (freshErrors.length > 0) this.dispatch({ type: 'brainError' })
  }

  /** Live words of the turn being spoken; partials of any other utterance are ignored. */
  private onPartial(event: { utteranceId: string; text: string }): void {
    if (this.machine.utterance === 'none') return
    if (event.utteranceId !== getListenEngines().stt.utteranceId) return
    // The streaming model writes capitals only (S OPEN THE SETTING'S PANEL); the final Whisper text keeps its own case.
    this.transcript = event.text.toLowerCase()
    this.listener.onPartial(this.transcript)
  }

  private resetListening(): void {
    this.conversation = false
    this.hearing = false
    this.preparing = false
    this.transcript = ''
    this.micNotice = null
    this.modelMissing = false
    this.sendError = null
    this.micLevel = 0
    this.syncSilenceTimer()
  }

  /** Ten seconds listening with no speech ends the conversation. */
  private syncSilenceTimer(): void {
    const wanted = this.machine.mode === 'listening' && this.machine.utterance === 'none'
    if (wanted && this.silenceTimer === null) {
      this.silenceTimer = setTimeout(() => {
        this.silenceTimer = null
        this.dispatch({ type: 'silenceTimeout' })
      }, this.silenceMs)
    } else if (!wanted && this.silenceTimer !== null) {
      clearTimeout(this.silenceTimer)
      this.silenceTimer = null
    }
  }

  private warm(): void {
    getTtsEngine(voiceModels.fake)
      .then((engine) => engine.warm())
      .catch((error: unknown) => this.failTts(error))
  }

  private failTts(error: unknown): void {
    this.ttsFailed = true
    // Never the spoken text: only the error's name, and only in development.
    if (import.meta.env.DEV) console.warn('nova: speech unavailable', (error as Error)?.name)
  }

  private onBrainState(next: BrainState): void {
    const change = brainTurnChange(this.prevBrain, next)
    this.prevBrain = next
    if (change === 'started') {
      this.turnStartId = activeSession.messages.reduce((max, m) => Math.max(max, m.id), 0)
      this.dispatch({ type: 'brainThinking' })
    } else if (change === 'settled') {
      const text = this.turnStartId === null ? '' : this.spokenAnswer(this.turnStartId)
      this.turnStartId = null
      this.dispatch({ type: 'brainSettled', text })
    }
  }

  /** The short spoken form of the brain's finished messages since `afterId`. */
  private spokenAnswer(afterId: number): string {
    if (!voiceModels.ttsReady) return ''
    const answer = activeSession.messages
      .filter((m) => m.role === 'brain' && m.state === 'complete' && m.id > afterId)
      .map((m) => m.content)
      .join('\n\n')
    const shaped = shapeSpoken(answer)
    return shaped.droppedContent ? `${shaped.text} ${DETAILS_IN_CHAT}`.trim() : shaped.text
  }

  private dispatch(event: MachineEvent): void {
    const next = transition(this.machine, event)
    this.machine = next.state
    this.state = next.state.mode
    this.conversation = next.state.conversation
    this.hearing = next.state.utterance !== 'none'
    for (const effect of next.effects) this.run(effect)
    this.syncSilenceTimer()
  }

  private run(effect: MachineEffect): void {
    switch (effect.type) {
      case 'speak':
        this.lastSpoken = effect.text
        this.spokenLog = [...this.spokenLog, effect.text]
        this.speaker.speak(effect.text)
        break
      case 'stopSpeech':
        this.previewing = false
        this.speaker.stop()
        break
      case 'send':
        this.sendSpoken(effect.text)
        break
      case 'beginUtterance':
        this.transcript = ''
        this.listener.beginUtterance()
        break
      case 'cancelUtterance':
        this.listener.cancelUtterance()
        break
      case 'endConversation':
        this.listener.stop()
        this.transcript = ''
        void window.arc.invoke('voice:close', {})
        break
    }
  }

  /** Sends what the user said to the brain, as if typed, marked as spoken. */
  private sendSpoken(text: string): void {
    this.sendError = null
    this.markNextTurnSpoken()
    void activeSession.send(text, { spoken: true }).then((error) => {
      if (error === null) return
      this.sendError = messageFor(error)
      this.dispatch({ type: 'sendFailed' })
    })
  }
}

export const nova = new Nova()
