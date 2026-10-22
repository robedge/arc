import { z } from 'zod'
import { toolsForRole } from '../bridge/tools/registry'
import type { BridgeRole } from '../bridge/types'

export interface SetupEstimate {
  /** `ceil(chars / 4)`. */
  tokens: number
  chars: number
}

export interface SetupEstimateInput {
  /** Everything Arc appends: the system prompt or developer instructions, group context manifest included. */
  instructions: string
  /** Name, description and JSON schema of each Arc bridge tool the agent is shown. */
  toolDescriptions: readonly string[]
}

const CHARS_PER_TOKEN = 4

/** Rough size of what Arc adds to an agent's setup. Labelled "about" wherever it is shown. */
export function estimateSetup(input: SetupEstimateInput): SetupEstimate {
  const chars =
    input.instructions.length + input.toolDescriptions.reduce((sum, text) => sum + text.length, 0)
  return { tokens: Math.ceil(chars / CHARS_PER_TOKEN), chars }
}

/**
 * The Arc bridge tools an agent of this role is shown, as the text a model receives for each:
 * name, description and input schema. `request_permission` is left out: the CLI calls it itself and
 * the model is not given it as a tool.
 */
export function bridgeToolDescriptions(role: BridgeRole): string[] {
  return toolsForRole(role)
    .filter((tool) => tool.name !== 'request_permission')
    .map((tool) => {
      const schema = JSON.stringify(z.toJSONSchema(z.object(tool.inputShape)))
      return `${tool.name}\n${tool.description}\n${schema}`
    })
}
