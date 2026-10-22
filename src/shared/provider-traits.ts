import type { ProviderId } from './types/provider'

/** Where a provider's plan-usage windows come from (see `forwardRateLimit`). */
export type ProviderPlanSource = 'event' | 'push' | 'probe'

export interface ProviderTraits {
  /** What the app calls the provider: "Claude", "Codex", "Cursor". */
  name: string
  /** What its command-line tool is called in messages: "Claude Code", "Codex", "Cursor". */
  cliName: string
  /** What the user runs in Terminal to sign in. */
  loginCommand: string
  /** How to install the tool, as it reads in a "not installed" message. */
  installHint: string
  /** Position when another provider has to stand in: the lowest number is tried first. */
  fallbackOrder: number
  /** True when the CLI takes a system prompt; false when Arc's instructions travel in the first prompt. */
  hasNativeSystemPrompt: boolean
  /** True when a running agent changes model without a restart. */
  liveModelSwitch: boolean
  /** Whether plan windows arrive with the agent's events, are pushed by the CLI or are probed by Arc. */
  planSource: ProviderPlanSource
  /** True when the full message comes late (after its text chunks), so the terminal shows the chunks as they arrive. */
  streamsTextDeltas: boolean
  /**
   * False when the provider's protocol carries no token counts (Cursor's ACP, spike M1): its turns are
   * recorded without tokens and read "Not reported", and it stays out of token totals.
   */
  reportsTokens: boolean
}

export const PROVIDER_TRAITS: Readonly<Record<ProviderId, ProviderTraits>> = {
  claude: {
    name: 'Claude',
    cliName: 'Claude Code',
    loginCommand: 'claude',
    installHint: 'Install it from claude.com/claude-code',
    fallbackOrder: 0,
    hasNativeSystemPrompt: true,
    liveModelSwitch: false,
    planSource: 'event',
    streamsTextDeltas: false,
    reportsTokens: true
  },
  codex: {
    name: 'Codex',
    cliName: 'Codex',
    loginCommand: 'codex login',
    installHint: 'Install it with npm install -g @openai/codex',
    fallbackOrder: 1,
    hasNativeSystemPrompt: true,
    liveModelSwitch: true,
    planSource: 'push',
    streamsTextDeltas: false,
    reportsTokens: true
  },
  cursor: {
    name: 'Cursor',
    cliName: 'Cursor',
    loginCommand: 'agent login',
    installHint: 'curl https://cursor.com/install -fsS | bash',
    fallbackOrder: 2,
    hasNativeSystemPrompt: false,
    liveModelSwitch: true,
    planSource: 'probe',
    streamsTextDeltas: true,
    reportsTokens: false
  }
}

/** False only for a provider known to carry no token counts (Cursor); unknown ids count as reporting. */
export function providerReportsTokens(provider: string): boolean {
  return provider in PROVIDER_TRAITS ? PROVIDER_TRAITS[provider as ProviderId].reportsTokens : true
}
