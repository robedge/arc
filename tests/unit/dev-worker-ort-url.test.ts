// @spec: 016-voice-companion
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'vite'
import type { InlineConfig, ViteDevServer } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import config from '../../electron.vite.config'

/**
 * `pnpm dev` regression: the Kokoro worker imports onnxruntime's `.jsep.mjs` and `.wasm` with `?url`
 * to learn where to load them from. Vite's dev dependency optimiser used to pre-bundle the `.mjs`
 * (a JS file in node_modules) and hand the worker its default export, a function, instead of a URL.
 * The worker then asked the dev server for a "URL" made of the function's source, got a 404, and
 * Nova said it could not speak. The built app (file://) never took this path.
 */
describe('dev server: Kokoro worker onnxruntime URLs', () => {
  let server: ViteDevServer
  let cacheDir: string

  beforeAll(async () => {
    cacheDir = mkdtempSync(join(tmpdir(), 'arc-vite-cache-'))
    const renderer = (config as { renderer: InlineConfig }).renderer
    server = await createServer({
      ...renderer,
      configFile: false,
      cacheDir,
      logLevel: 'silent',
      appType: 'custom',
      server: { middlewareMode: true, hmr: false, watch: null }
    })
  }, 60_000)

  afterAll(async () => {
    await server?.close()
    rmSync(cacheDir, { recursive: true, force: true })
  })

  it.each(['ortMjs', 'ortWasm'])(
    '%s resolves to a URL string, not a module',
    async (name) => {
      const worker = await server.transformRequest('/src/lib/nova/audio/tts.worker.ts')
      const line = new RegExp(`import ${name} from "([^"]+)"`).exec(worker?.code ?? '')
      expect(line, `${name} import in the transformed worker`).not.toBeNull()
      const dep = await server.transformRequest(line![1]!)
      expect(dep?.code).toMatch(/^export default "[^"]+"/)
      expect(line![1]).not.toContain('/deps/')
    },
    60_000
  )
})
