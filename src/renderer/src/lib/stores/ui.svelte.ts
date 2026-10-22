import { groupDetail } from './group-detail.svelte'

/** The hard-coded first tab; not a DB section. */
export const SECTION_SESSIONS = '__sessions__'

export type DialogSpec =
  | { kind: 'group-create' }
  | { kind: 'group-rename'; groupId: string }
  | { kind: 'group-delete'; groupId: string }
  | { kind: 'section-create' }
  | { kind: 'section-rename'; sectionId: string }
  | { kind: 'section-delete'; sectionId: string }
  | { kind: 'project-remove'; projectId: string }
  | { kind: 'item-create'; sectionId: string }
  | { kind: 'item-delete'; itemId: string }
  | { kind: 'link-form'; itemId?: string }
  | { kind: 'storage-link' }
  | { kind: 'storage-unlink' }
  | { kind: 'storage-use-app' }

export type SettingsPage = 'providers' | 'plugins' | 'agent-load'

class UiStore {
  selectedGroupId = $state<string | null>(null)
  /** Null (or the sessions sentinel) means the Sessions tab. */
  selectedSectionId = $state<string | null>(null)
  selectedItemId = $state<string | null>(null)
  dialog = $state<DialogSpec | null>(null)
  /** Which screen fills the window below the title bar; the selections above are kept while Settings is open. */
  view = $state<'main' | 'settings' | 'usage'>('main')
  /** The page Settings shows; it opens on Providers unless a caller names another. */
  settingsPage = $state<SettingsPage>('providers')

  /** The selected section if it still exists, else Sessions. */
  get activeSectionId(): string {
    const id = this.selectedSectionId
    return id !== null && groupDetail.sections.some((s) => s.id === id) ? id : SECTION_SESSIONS
  }

  selectGroup(id: string | null): void {
    this.selectedGroupId = id
    this.selectedSectionId = null
    this.selectedItemId = null
    void groupDetail.load(id)
    if (id !== null) void window.harness.invoke('groups:open', { groupId: id })
  }

  selectSection(id: string | null): void {
    this.selectedSectionId = id
    this.selectedItemId = null
  }

  selectItem(id: string | null): void {
    this.selectedItemId = id
  }

  openSettings(page: SettingsPage = 'providers'): void {
    this.settingsPage = page
    this.view = 'settings'
  }

  closeSettings(): void {
    this.view = 'main'
  }

  openUsage(): void {
    this.view = 'usage'
  }

  closeUsage(): void {
    this.view = 'main'
  }

  openDialog(spec: DialogSpec): void {
    this.dialog = spec
  }

  closeDialog(): void {
    this.dialog = null
  }
}

export const ui = new UiStore()
