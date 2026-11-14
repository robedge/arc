/**
 * SPIKE (A2UI): compiles A2UI Express, the compact text the brain writes, into the A2UI v1.0
 * `createSurface` body Arc stores and draws. The compiler is the official `@a2ui/agent` SDK; the
 * catalog it checks against is `ARC_CATALOG`. Throwaway.
 */
import {
  A2uiError,
  A2uiGenerator,
  CatalogConfig,
  ExpressFormatFactory,
  InMemoryCatalogProvider,
  type A2uiRequestProcessor
} from '@a2ui/agent'
import { surfaceProblem, surfaceSchema, type Surface } from '../../shared/surface'
import { ARC_CATALOG, ARC_CATALOG_ID } from './arc-catalog'

let cached: A2uiRequestProcessor | undefined

function processor(): A2uiRequestProcessor {
  if (cached) return cached
  const catalog = new InMemoryCatalogProvider(ARC_CATALOG).load()
  const generator = new A2uiGenerator([new CatalogConfig(catalog)])
  cached = generator.createProcessor(
    { '1.0': { supportedCatalogIds: [ARC_CATALOG_ID] } },
    new ExpressFormatFactory()
  )
  return cached
}

/** The component signatures, as the SDK derives them from the catalog. */
export function componentSignatures(): string {
  const snippet = processor().promptSnippet
  const from = snippet.indexOf('## Positional Component Signatures')
  const to = snippet.indexOf('## Positional Function Signatures')
  if (from < 0 || to < from) return snippet
  return snippet
    .slice(from, to)
    .replace('## Positional Component Signatures', '')
    .replace(/^Use these exact positional signatures.*$/m, '')
    .trim()
}

export class ExpressError extends Error {}

/** Compiles one surface. Throws `ExpressError` with a message the brain can act on. */
export function compileExpress(surfaceId: string, express: string): Surface {
  const body = express
    .replace(/^\s*```[a-z0-9]*\s*$/gim, '')
    .replace(/<\/?a2ui>/g, '')
    .trim()
  let parts
  try {
    parts = processor().parseResponse(`<a2ui>\n${body}\n</a2ui>`)
  } catch (error) {
    if (error instanceof A2uiError) {
      throw new ExpressError(
        error.message.startsWith('Surface not found')
          ? 'The text defines no surface. Assign the top component to `root`.'
          : error.message
      )
    }
    throw error
  }
  for (const part of parts) {
    if (part.type !== 'a2ui') continue
    for (const message of part.a2ui as { createSurface?: Record<string, unknown> }[]) {
      const created = message.createSurface
      if (!created) continue
      const surface = surfaceSchema.safeParse({
        surfaceId,
        components: created['components'],
        ...(created['dataModel'] ? { dataModel: created['dataModel'] } : {})
      })
      if (!surface.success)
        throw new ExpressError('The compiled surface is too large or malformed.')
      const problem = surfaceProblem(surface.data)
      if (problem !== null) throw new ExpressError(problem)
      return surface.data
    }
  }
  throw new ExpressError('The text defines no surface. Assign the top component to `root`.')
}
