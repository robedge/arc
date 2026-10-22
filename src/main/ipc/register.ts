import { ipcMain } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import type { z } from 'zod'
import type { Channel, ChannelResponse, IpcEventName, IpcEvents } from '@shared/ipc/contract'
import { channelSchemas } from '@shared/ipc/contract'
import { getMainWindow } from '../app/main-window'
import { ipcLog } from '../logging'
import { wrapHandler } from './wrap-handler'

function isMainWindowTopFrame(event: IpcMainInvokeEvent): boolean {
  const win = getMainWindow()
  return win !== null && event.senderFrame === win.webContents.mainFrame
}

/** Register a validated, sender-checked handler. The renderer always receives a Result. */
export function handle<C extends Channel>(
  channel: C,
  fn: (
    request: z.infer<(typeof channelSchemas)[C]>
  ) => ChannelResponse<C> | Promise<ChannelResponse<C>>
): void {
  const wrapped = wrapHandler(
    { channel, isTrustedSender: isMainWindowTopFrame, logger: ipcLog },
    channelSchemas[channel],
    // TS cannot correlate the generic channel with its schema output here.
    fn as (request: unknown) => ChannelResponse<C> | Promise<ChannelResponse<C>>
  )
  ipcMain.handle(channel, (event, raw: unknown) => wrapped(event, raw))
}

/** Send a push event to the main window. */
export function emit<E extends IpcEventName>(event: E, payload: IpcEvents[E]): void {
  getMainWindow()?.webContents.send(event, payload)
}
