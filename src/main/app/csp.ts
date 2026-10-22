/**
 * Content-Security-Policy for the renderer.
 * style-src allows 'unsafe-inline' because Svelte transitions and Tailwind/Vite dev
 * inject inline styles; scripts stay 'self' only.
 * Dev additionally allows the Vite dev server and its HMR websocket.
 */
export function buildCsp(options: { dev: boolean }): string {
  const knowledgeProtocolSources = ['harness-knowledge:']
  const connect = [
    "'self'",
    ...knowledgeProtocolSources,
    ...(options.dev ? ['http://localhost:*', 'ws://localhost:*'] : [])
  ]
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    ["img-src 'self' data:", ...knowledgeProtocolSources].join(' '),
    `connect-src ${connect.join(' ')}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'"
  ].join('; ')
}
