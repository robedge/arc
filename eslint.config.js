import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import svelte from 'eslint-plugin-svelte'
import prettier from 'eslint-config-prettier'
import globals from 'globals'

const nodeTypeAwareFiles = ['src/main/**/*.ts', 'src/preload/**/*.ts', 'src/shared/**/*.ts']

export default tseslint.config(
  {
    ignores: [
      'node_modules',
      'out',
      'dist',
      'release',
      'coverage',
      '.awos',
      '.claude',
      'context',
      'src/main/db/migrations'
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: nodeTypeAwareFiles,
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    }
  },
  ...svelte.configs['flat/recommended'],
  {
    files: ['**/*.svelte', '**/*.svelte.ts'],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { parser: tseslint.parser, extraFileExtensions: ['.svelte'] }
    }
  },
  {
    files: ['src/renderer/**/*.{ts,svelte}'],
    languageOptions: { globals: globals.browser },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/main/**', '**/main', '@main/*', 'electron'],
              message: 'The renderer must not import from src/main or Electron; use window.harness.'
            }
          ]
        }
      ]
    }
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error'
    }
  },
  {
    files: nodeTypeAwareFiles,
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      // A switch must name every member of a union or end in a `default` that says what the rest do.
      '@typescript-eslint/switch-exhaustiveness-check': [
        'error',
        { considerDefaultExhaustiveForUnions: true }
      ]
    }
  },
  {
    files: [
      '*.config.{js,ts,mjs}',
      'scripts/**/*.mjs',
      'tests/e2e/fixtures/*.mjs',
      'tests/unit/agents/helpers/*.mjs'
    ],
    languageOptions: { globals: globals.node }
  },
  prettier,
  ...svelte.configs['flat/prettier']
)
