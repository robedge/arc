import { groupNameKey } from './group-name'

export const SECTION_KINDS = ['projects', 'notes', 'docs', 'playbooks', 'links', 'custom'] as const
export type SectionKind = (typeof SECTION_KINDS)[number]

export interface BuiltInSectionDef {
  kind: Exclude<SectionKind, 'custom'>
  name: string
  /** Subfolder of the knowledge root; null for Projects (not backed by a folder). */
  folder: string | null
}

/** Seeded in this order when a group is created; the index is the section's sort_order. */
export const BUILT_IN_SECTIONS: readonly BuiltInSectionDef[] = [
  { kind: 'projects', name: 'Projects', folder: null },
  { kind: 'notes', name: 'Notes', folder: 'Notes' },
  { kind: 'docs', name: 'Docs', folder: 'Docs' },
  { kind: 'playbooks', name: 'Playbooks', folder: 'Playbooks' },
  { kind: 'links', name: 'Links', folder: 'Links' }
]

/** Custom sections sort after the built-ins, starting here. */
export const CUSTOM_SECTION_SORT_START = 100

/** Case-insensitive uniqueness key for section names (same rules as group names). */
export function sectionNameKey(raw: string): string {
  return groupNameKey(raw)
}
