import type { AnyBridgeTool, BridgeRole } from '../types'
import { askBrainTool } from './ask-brain'
import { askUserTool } from './ask-user'
import { escalateToUserTool } from './escalate-to-user'
import { getWorkerStatusTool } from './get-worker-status'
import { mergeWorkerTool } from './merge-worker'
import { messageWorkerTool } from './message-worker'
import { proposePlanTool } from './propose-plan'
import { reportDoneTool } from './report-done'
import { reportProgressTool } from './report-progress'
import { requestPermissionTool } from './request-permission'
import { resolveRequestTool } from './resolve-request'
import { spawnWorkerTool } from './spawn-worker'
import { syncWorkerTool } from './sync-worker'

/** Adding a tool: write one file in this folder and list it here. */
export const BRIDGE_TOOLS: readonly AnyBridgeTool[] = [
  proposePlanTool,
  spawnWorkerTool,
  messageWorkerTool,
  getWorkerStatusTool,
  mergeWorkerTool,
  syncWorkerTool,
  resolveRequestTool,
  escalateToUserTool,
  askUserTool,
  reportProgressTool,
  reportDoneTool,
  askBrainTool,
  requestPermissionTool
]

export function toolsForRole(role: BridgeRole): AnyBridgeTool[] {
  return BRIDGE_TOOLS.filter((t) => t.role === role || t.role === 'any')
}
