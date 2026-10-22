import { resolve } from 'node:path'
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

const shared = resolve('src/shared')

export default defineConfig({
  main: {
    resolve: { alias: { '@shared': shared } },
    build: { rollupOptions: { input: { index: resolve('src/main/index.ts') } } }
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
    resolve: { alias: { '@shared': shared } },
    plugins: [svelte(), tailwindcss(), cspMeta()],
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
