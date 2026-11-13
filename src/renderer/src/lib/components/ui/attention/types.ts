import type { AttentionQuestion, AttentionTool } from '@shared/types/session'

interface AttentionBase {
  id: string
  /** Who is asking, e.g. "W1 api-retry · via brain". */
  from: string
}

export interface PermissionRequest extends AttentionBase {
  kind: 'permission'
  /** The exact action requested (a command, for example), shown verbatim in a mono box. */
  action: string
  /** One-line reason or brain note. */
  reason?: string
  /** An MCP call's server, tool and arguments, or the access a Codex request asks for. */
  tool?: AttentionTool
}

export interface QuestionRequest extends AttentionBase {
  kind: 'question'
  question: string
  /** A command's or the brain's structured question; shown by StructuredQuestionCard. */
  questions?: AttentionQuestion[]
}

/** Arc's question about unsaved changes (spec 013); shown by BranchQuestionCard. */
export interface BranchRequest extends AttentionBase {
  kind: 'branch'
  projectId: string
  projectName: string
  files: string[]
  moreFiles: number
  workers: string[]
  message?: string
}

export type AttentionRequest = PermissionRequest | QuestionRequest | BranchRequest
