import type { Result } from '../errors'
import type {
  Channel,
  ChannelRequest,
  ChannelResponse,
  IpcEventName,
  IpcEvents,
  SendChannel,
  SendRequest
} from './contract'

/** The shape of `window.arc`, exposed by the preload. */
export interface ArcApi {
  invoke<C extends Channel>(
    channel: C,
    request: ChannelRequest<C>
  ): Promise<Result<ChannelResponse<C>>>
  /** Fire-and-forget: no reply and no error back; main drops an invalid payload. */
  send<C extends SendChannel>(channel: C, request: SendRequest<C>): void
  on<E extends IpcEventName>(event: E, callback: (payload: IpcEvents[E]) => void): () => void
  getPathForFile(file: File): string
}
