import { messageFor } from './messages'
import { toasts } from '../stores/toasts.svelte'

/** Opens an http(s) address from rendered markdown; main revalidates the scheme. */
export async function openUrl(url: string): Promise<void> {
  const res = await window.harness.invoke('shell:openUrl', { url })
  if (!res.ok) toasts.show(messageFor(res.error), 'error')
}

/**
 * Opens a saved link in the default browser. Main re-reads and revalidates the
 * address from disk, so the renderer only ever sends the item id.
 */
export async function openLink(itemId: string): Promise<void> {
  const res = await window.harness.invoke('shell:openLink', { itemId })
  if (!res.ok) toasts.show(messageFor(res.error), 'error')
}
