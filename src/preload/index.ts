import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { IpcRendererEvent } from 'electron'
import { channelNames, eventNames, sendNames } from '@shared/ipc/contract'
import type { ArcApi } from '@shared/ipc/arc-api'

const channels: ReadonlySet<string> = new Set(channelNames)
const events: ReadonlySet<string> = new Set(eventNames)
const sends: ReadonlySet<string> = new Set(sendNames)

const api: ArcApi = {
  invoke: (channel, request) => {
    if (!channels.has(channel)) throw new Error(`Unknown channel: ${channel}`)
    return ipcRenderer.invoke(channel, request)
  },
  send: (channel, request) => {
    if (!sends.has(channel)) throw new Error(`Unknown send channel: ${channel}`)
    ipcRenderer.send(channel, request)
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
