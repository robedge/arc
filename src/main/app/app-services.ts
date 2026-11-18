import type { Db } from '../db/client'
import type { CliResolver } from '../agents/cli-resolver'
import type { CommandCatalogue } from '../agents/command-probe'
import type { CodexCommands } from '../agents/codex/codex-commands'
import type { CodexProbe } from '../agents/codex/codex-probe'
import type { CursorCommands } from '../agents/cursor/cursor-commands'
import type { ProcessSupervisor } from '../agents/process-supervisor'
import type { BridgeServer } from '../bridge/bridge-server'
import type { AppSettingsRepo } from '../db/repositories/app-settings-repo'
import type { KnowledgeItemsRepo } from '../db/repositories/knowledge-items-repo'
import type { BranchQuestionsRepo } from '../db/repositories/branch-questions-repo'
import type { MessageAttachmentsRepo } from '../db/repositories/message-attachments-repo'
import type { KnowledgeSuggestionsRepo } from '../db/repositories/knowledge-suggestions-repo'
import type { UsageRepo } from '../db/repositories/usage-repo'
import type { UsageSuggestionsRepo } from '../db/repositories/usage-suggestions-repo'
import type { GroupService } from '../groups/group-service'
import type { ProjectService } from '../groups/project-service'
import type { AvailabilityService } from '../knowledge/availability-service'
import type { KnowledgeIndex } from '../knowledge/knowledge-index'
import type { KnowledgeService } from '../knowledge/knowledge-service'
import type { KnowledgeSuggestionService } from '../knowledge/knowledge-suggestion-service'
import type { KnowledgeStorageService } from '../knowledge/knowledge-storage-service'
import type { KnowledgeWatcher } from '../knowledge/knowledge-watcher'
import type { SectionService } from '../knowledge/section-service'
import type { ModelRegistry } from '../models/model-registry'
import type { BypassDetector } from '../personal/bypass-detector'
import type { LoadCatalogue } from '../personal/load-catalogue'
import type { PersonalConfigService } from '../personal/personal-config'
import type { AttachmentService } from '../attachments/attachment-service'
import type { Dialogs } from '../platform/dialogs'
import type { ShellService } from '../platform/shell-service'
import type { PluginService } from '../plugins/plugin-service'
import type { PluginViewService } from '../plugins/plugin-view'
import type { ProviderStatusService } from '../providers/provider-status-service'
import type { AttentionService } from '../sessions/attention-service'
import type { SessionService } from '../sessions/session-service'
import type { ClaudePlanProbe } from '../usage/claude-plan-probe'
import type { CodexRateLimitReader } from '../usage/codex-rate-limit-reader'
import type { CursorPlanReader } from '../usage/cursor-plan-reader'
import type { PlanUsageService } from '../usage/plan-usage-service'
import type { SuggestionService } from '../usage/suggestion-service'
import type { UsageRecorder } from '../usage/usage-recorder'
import type { MicAccess } from '../voice/mic-access'
import type { ModelManager } from '../voice/model-manager'
import type { SpeechHost } from '../voice/speech-host'
import type { ProviderChecks } from './provider-checks'

/**
 * Every service the IPC handlers and the app lifecycle use, built once at startup by
 * `buildServices`. Handler modules take the slice they need (`Pick<AppServices, ...>`).
 */
export interface AppServices {
  db: Db
  dialogs: Dialogs
  resolver: CliResolver
  supervisor: ProcessSupervisor
  appSettings: AppSettingsRepo

  providerStatus: ProviderStatusService
  providerChecks: ProviderChecks
  models: ModelRegistry
  codexProbe: CodexProbe
  codexCommands: CodexCommands
  cursorCommands: CursorCommands

  availability: AvailabilityService
  itemsRepo: KnowledgeItemsRepo
  getKnowledgeRoot: (groupId: string) => string
  knowledgeIndex: KnowledgeIndex
  knowledgeWatcher: KnowledgeWatcher
  sectionService: SectionService
  storageService: KnowledgeStorageService
  knowledgeService: KnowledgeService
  knowledgeSuggestions: KnowledgeSuggestionService
  attachments: AttachmentService
  knowledgeSuggestionsRepo: KnowledgeSuggestionsRepo
  shellService: ShellService
  groupService: GroupService
  projectService: ProjectService

  bridge: BridgeServer
  pluginView: PluginViewService
  pluginService: PluginService
  bypassDetector: BypassDetector
  personalConfig: PersonalConfigService
  loadCatalogue: LoadCatalogue
  commandCatalogue: CommandCatalogue

  usageRepo: UsageRepo
  suggestionsRepo: UsageSuggestionsRepo
  suggestions: SuggestionService
  usage: UsageRecorder
  plans: PlanUsageService
  codexLimits: CodexRateLimitReader
  cursorPlan: CursorPlanReader
  /** Absent when the plan probe is not available for this binary (see `planProbeTarget`). */
  claudePlanProbe: ClaudePlanProbe | undefined

  sessions: SessionService
  messageAttachmentsRepo: MessageAttachmentsRepo
  branchQuestionsRepo: BranchQuestionsRepo
  attention: AttentionService

  voiceModels: ModelManager
  speechHost: SpeechHost
  micAccess: MicAccess
}
