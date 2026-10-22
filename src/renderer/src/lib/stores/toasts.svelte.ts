import type { MessageKind } from '../components/ui/kinds'

export interface Toast {
  id: number
  message: string
  kind: MessageKind
}

const TOAST_MS = 5000

class ToastStore {
  list = $state<Toast[]>([])
  private nextId = 1

  show(message: string, kind: MessageKind = 'info'): void {
    const id = this.nextId++
    this.list.push({ id, message, kind })
    setTimeout(() => this.dismiss(id), TOAST_MS)
  }

  dismiss(id: number): void {
    this.list = this.list.filter((t) => t.id !== id)
  }
}

export const toasts = new ToastStore()
