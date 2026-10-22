import { MCP_SERVER_NAME, mcpToolName } from '../bridge/types'
import type { ProviderId } from '../../shared/types/provider'

/**
 * How a provider addresses the bridge tools. Claude shows the model `mcp__arc__<name>`. Codex
 * (spike S1) lists the tools under the namespace `mcp__arc` with their bare names, so its full
 * name is the bare one. Prompts and allowlists never spell the prefix themselves.
 */
export interface BridgeToolNamer {
  /** The namespace the provider puts in front of the server's tools. */
  readonly namespace: string
  /** A bare bridge tool name (`spawn_worker`) as the provider's tool list and allowlist spell it. */
  name(bare: string): string
}

const NAMERS: Readonly<Record<ProviderId, BridgeToolNamer>> = {
  claude: { namespace: `mcp__${MCP_SERVER_NAME}`, name: mcpToolName },
  codex: { namespace: `mcp__${MCP_SERVER_NAME}`, name: (bare) => bare },
  // Cursor lists the tools of an MCP server under the server's name, as Codex does (confirmed by the Cursor spikes).
  cursor: { namespace: `mcp__${MCP_SERVER_NAME}`, name: (bare) => bare }
}

export function bridgeToolNamer(provider: ProviderId): BridgeToolNamer {
  return NAMERS[provider]
}
