import { protocol } from 'electron'
import { ATTACHMENT_SCHEME } from './attachment-request'
import { KNOWLEDGE_SCHEME } from './knowledge-request'

export const PRIVILEGED_SCHEMES: Electron.CustomScheme[] = [
  KNOWLEDGE_SCHEME,
  ATTACHMENT_SCHEME
].map((scheme) => ({
  scheme,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    stream: true,
    corsEnabled: true
  }
}))

/**
 * Must run once, before the app is ready. `registerSchemesAsPrivileged` replaces the earlier call's
 * list rather than adding to it, so every custom scheme is registered here together.
 */
export function registerAppSchemes(): void {
  protocol.registerSchemesAsPrivileged(PRIVILEGED_SCHEMES)
}
