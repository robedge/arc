import { describe, expect, it } from 'vitest'
import { buildCsp } from '../../src/main/app/csp'
import { KNOWLEDGE_SCHEME } from '../../src/main/protocol/knowledge-request'

describe('buildCsp', () => {
  const directive = (csp: string, name: string): string =>
    csp.split('; ').find((d) => d.startsWith(`${name} `)) ?? ''

  it('allows the knowledge scheme for images and fetches, and nothing broader', () => {
    const csp = buildCsp({ dev: false })
    expect(directive(csp, 'img-src')).toContain(`${KNOWLEDGE_SCHEME}:`)
    expect(directive(csp, 'connect-src')).toBe(`connect-src 'self' ${KNOWLEDGE_SCHEME}:`)
    expect(directive(csp, 'script-src')).toBe("script-src 'self'")
  })

  it('only the dev policy may reach the Vite server', () => {
    expect(buildCsp({ dev: false })).not.toContain('localhost')
    const dev = directive(buildCsp({ dev: true }), 'connect-src')
    expect(dev).toContain('http://localhost:*')
    expect(dev).toContain('ws://localhost:*')
  })
})
