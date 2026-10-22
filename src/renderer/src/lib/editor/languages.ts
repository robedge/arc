import type { Extension } from '@codemirror/state'

export type LanguageName = 'sql' | 'json' | 'yaml'

const LOADERS: Record<LanguageName, () => Promise<Extension>> = {
  sql: async () => (await import('@codemirror/lang-sql')).sql(),
  json: async () => (await import('@codemirror/lang-json')).json(),
  yaml: async () => (await import('@codemirror/lang-yaml')).yaml()
}

const BY_EXTENSION: Record<string, LanguageName> = {
  sql: 'sql',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml'
}

export function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.')
  return dot < 0 ? '' : fileName.slice(dot + 1).toLowerCase()
}

/** The CodeMirror language for a file name, or null for plain text. */
export function languageFor(fileName: string): LanguageName | null {
  return BY_EXTENSION[extensionOf(fileName)] ?? null
}

/** Loads the language support on demand so it stays out of the main bundle. */
export function loadLanguage(name: LanguageName): Promise<Extension> {
  return LOADERS[name]()
}
