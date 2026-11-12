/// <reference types="svelte" />
/// <reference types="vite/client" />
import type { ArcApi } from '@shared/ipc/arc-api'

declare global {
  interface Window {
    arc: ArcApi
  }
}
