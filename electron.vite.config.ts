import { readFileSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import tailwindcss from '@tailwindcss/vite'
import type { Plugin } from 'vite'
import { buildCsp } from './src/main/app/csp'

// Production builds carry the strict CSP in a meta tag; dev gets it as a header (needs HMR).
const cspMeta = (): Plugin => ({
  name: 'harness-csp-meta',
  apply: 'build',
  transformIndexHtml: (html) =>
    html.replace(
      '<head>',
      `<head>\n    <meta http-equiv="Content-Security-Policy" content="${buildCsp({ dev: false })}" />`
    )
})

// Nova's voice detector (@ricky0123/vad-web) loads its worklet, Silero model and onnxruntime WASM
// from `vad/` next to the page, never from a CDN. Build copies them into the bundle; dev serves them.
const vadFiles = (): { name: string; from: string }[] => {
  const vad = realpathSync(resolve('node_modules/@ricky0123/vad-web'))
  const ort = join(vad, '../../onnxruntime-web/dist')
  return [
    { name: 'vad.worklet.bundle.min.js', from: join(vad, 'dist/vad.worklet.bundle.min.js') },
    { name: 'silero_vad_v5.onnx', from: join(vad, 'dist/silero_vad_v5.onnx') },
    { name: 'ort-wasm-simd-threaded.mjs', from: join(ort, 'ort-wasm-simd-threaded.mjs') },
    { name: 'ort-wasm-simd-threaded.wasm', from: join(ort, 'ort-wasm-simd-threaded.wasm') }
  ]
}
const vadAssets = (): Plugin => ({
  name: 'harness-vad-assets',
  generateBundle() {
    for (const { name, from } of vadFiles()) {
      this.emitFile({ type: 'asset', fileName: `vad/${name}`, source: readFileSync(from) })
    }
  },
  configureServer(server) {
    server.middlewares.use('/vad/', (req, res, next) => {
      const file = vadFiles().find((f) => `/${f.name}` === req.url?.split('?')[0])
      if (!file) return next()
      res.setHeader(
        'Content-Type',
        file.name.endsWith('.wasm')
          ? 'application/wasm'
          : file.name.endsWith('.onnx')
            ? 'application/octet-stream'
            : 'text/javascript'
      )
      res.end(readFileSync(file.from))
    })
  }
})

const shared = resolve('src/shared')

export default defineConfig({
  main: {
    resolve: { alias: { '@shared': shared } },
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          // Utility-process entries (native speech addons never load in main or the renderer).
          'speech-worker': resolve('src/main/voice/speech-worker.ts'),
          'fake-speech-worker': resolve('src/main/voice/fake-speech-worker.ts')
        }
      }
    }
  },
  preload: {
    resolve: { alias: { '@shared': shared } },
    build: {
      // Sandboxed preloads cannot import modules: emit CJS and bundle zod into it.
      externalizeDeps: { exclude: ['zod'] },
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    }
  },
  renderer: {
    root: resolve('src/renderer'),
    resolve: {
      alias: {
        '@shared': shared,
        // The package exports map hides these files; the Kokoro worker serves them from the bundle.
        '@ort': resolve('node_modules/@huggingface/transformers/dist')
      }
    },
    // The Kokoro worker is a module worker (it loads onnxruntime with a dynamic import).
    worker: { format: 'es' },
    // The Kokoro worker imports the ORT loader with `?url`. In dev the dependency optimiser would
    // pre-bundle that .mjs and hand back its default export (a function), not a URL string.
    optimizeDeps: { exclude: ['@ort/ort-wasm-simd-threaded.jsep.mjs?url'] },
    plugins: [svelte(), tailwindcss(), cspMeta(), vadAssets()],
    build: {
      // Fonts must stay files: data: URIs are blocked by the CSP (default-src 'self').
      assetsInlineLimit: 0,
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          preview: resolve('src/renderer/preview.html')
        }
      }
    }
  }
})
