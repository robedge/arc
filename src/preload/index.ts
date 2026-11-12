import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { IpcRendererEvent } from 'electron'
import { channelNames, eventNames } from '@shared/ipc/contract'
import type { ArcApi } from '@shared/ipc/arc-api'

const channels: ReadonlySet<string> = new Set(channelNames)
const events: ReadonlySet<string> = new Set(eventNames)

const api: ArcApi = {
  invoke: (channel, request) => {
    if (!channels.has(channel)) throw new Error(`Unknown channel: ${channel}`)
    return ipcRenderer.invoke(channel, request)
  },
  on: (event, callback) => {
    if (!events.has(event)) throw new Error(`Unknown event: ${String(event)}`)
    const listener = (_e: IpcRendererEvent, payload: unknown): void =>
      (callback as (p: unknown) => void)(payload)
    ipcRenderer.on(event, listener)
    return () => {
      ipcRenderer.removeListener(event, listener)
    }
  },
  getPathForFile: (file) => webUtils.getPathForFile(file)
}

contextBridge.exposeInMainWorld('arc', api)
