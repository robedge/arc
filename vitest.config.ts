import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import { svelte } from '@sveltejs/vite-plugin-svelte'

const alias = { '@shared': resolve('src/shared') }

export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'main',
          environment: 'node',
          include: ['tests/unit/**/*.test.ts']
        }
      },
      {
        plugins: [svelte()],
        resolve: { alias, conditions: ['browser'] },
        test: {
          name: 'renderer',
          environment: 'jsdom',
          include: ['tests/renderer/**/*.test.ts']
        }
      }
    ]
  }
})
