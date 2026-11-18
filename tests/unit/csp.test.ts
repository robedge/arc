import { describe, expect, it } from 'vitest'
import { buildCsp } from '../../src/main/app/csp'
import { KNOWLEDGE_SCHEME } from '../../src/main/protocol/knowledge-request'
import { VOICE_MODEL_SCHEME } from '../../src/main/protocol/voice-model-request'

describe('buildCsp', () => {
  const directive = (csp: string, name: string): string =>
    csp.split('; ').find((d) => d.startsWith(`${name} `)) ?? ''

  it('allows the knowledge scheme for images and fetches, and nothing broader', () => {
    const csp = buildCsp({ dev: false })
    expect(directive(csp, 'img-src')).toContain(`${KNOWLEDGE_SCHEME}:`)
    expect(directive(csp, 'connect-src')).toBe(
      `connect-src 'self' ${KNOWLEDGE_SCHEME}: ${VOICE_MODEL_SCHEME}:`
    )
  })

  it('allows what the voice stack needs and nothing wider', () => {
    for (const dev of [false, true]) {
      const csp = buildCsp({ dev })
      expect(directive(csp, 'script-src')).toBe("script-src 'self' 'wasm-unsafe-eval'")
      expect(directive(csp, 'worker-src')).toBe("worker-src 'self' blob:")
      expect(directive(csp, 'media-src')).toBe("media-src 'self' blob:")
      expect(directive(csp, 'connect-src')).toContain('arc-voice-model:')
      expect(directive(csp, 'img-src')).not.toContain('arc-voice-model')
      expect(csp).not.toContain("'unsafe-eval'")
      expect(csp.replaceAll('http://localhost:*', '')).not.toMatch(/https?:/)
    }
  })

  it('allows the attachment scheme for images only', () => {
    for (const dev of [false, true]) {
      const csp = buildCsp({ dev })
      expect(directive(csp, 'img-src')).toContain('arc-attachment:')
      expect(directive(csp, 'connect-src')).not.toContain('arc-attachment')
      expect(directive(csp, 'default-src')).not.toContain('arc-attachment')
    }
  })

  it('only the dev policy may reach the Vite server', () => {
    expect(buildCsp({ dev: false })).not.toContain('localhost')
    const dev = directive(buildCsp({ dev: true }), 'connect-src')
    expect(dev).toContain('http://localhost:*')
    expect(dev).toContain('ws://localhost:*')
  })
})
