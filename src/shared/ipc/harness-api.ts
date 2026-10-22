import type { Result } from '../errors'
import type { Channel, ChannelRequest, ChannelResponse, IpcEventName, IpcEvents } from './contract'

/** The shape of `window.harness`, exposed by the preload. */
export interface HarnessApi {
  invoke<C extends Channel>(
    channel: C,
    request: ChannelRequest<C>
  ): Promise<Result<ChannelResponse<C>>>
  on<E extends IpcEventName>(event: E, callback: (payload: IpcEvents[E]) => void): () => void
  getPathForFile(file: File): string
}
