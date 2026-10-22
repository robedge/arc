import type { SectionKind } from '../sections'

export interface Section {
  id: string
  groupId: string
  kind: SectionKind
  name: string
  builtIn: boolean
  /** Regular files directly in the section's folder (0 for Projects until it is backed by projects). */
  itemCount: number
  sortOrder: number
}
