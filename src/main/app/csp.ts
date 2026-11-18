/**
 * Content-Security-Policy for the renderer.
 * style-src allows 'unsafe-inline' because Svelte transitions and Tailwind/Vite dev
 * inject inline styles; scripts stay 'self' only.
 * Voice (Nova): 'wasm-unsafe-eval' for the speech engines' WebAssembly, blob: workers and media for
 * the TTS worker and playback, and arc-voice-model: to read the downloaded models. The renderer
 * never connects to the internet; only main downloads.
 * Dev additionally allows the Vite dev server and its HMR websocket.
 */
export function buildCsp(options: { dev: boolean }): string {
  const knowledgeProtocolSources = ['arc-knowledge:']
  const attachmentProtocolSources = ['arc-attachment:']
  const voiceModelProtocolSources = ['arc-voice-model:']
  const connect = [
    "'self'",
    ...knowledgeProtocolSources,
    ...voiceModelProtocolSources,
    ...(options.dev ? ['http://localhost:*', 'ws://localhost:*'] : [])
  ]
  return [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "worker-src 'self' blob:",
    "media-src 'self' blob:",
    "style-src 'self' 'unsafe-inline'",
    ["img-src 'self' data:", ...knowledgeProtocolSources, ...attachmentProtocolSources].join(' '),
    `connect-src ${connect.join(' ')}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'"
  ].join('; ')
}
