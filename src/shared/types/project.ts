import type { ErrorCode } from '../errors'

export interface Project {
  id: string
  name: string
  path: string
  isGit: boolean
  available: boolean
}

export interface SkippedProject {
  path: string
  code: ErrorCode
}

export interface AddProjectsResult {
  added: Project[]
  skipped: SkippedProject[]
}
