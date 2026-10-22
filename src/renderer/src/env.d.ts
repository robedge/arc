/// <reference types="svelte" />
/// <reference types="vite/client" />
import type { HarnessApi } from '@shared/ipc/harness-api'

declare global {
  interface Window {
    harness: HarnessApi
  }
}
