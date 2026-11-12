import { enabledExtensions } from '../../knowledge/import-types'
import type { AppServices } from '../../app/app-services'
import { handle } from '../register'

type KnowledgeServices = Pick<AppServices, 'knowledgeService' | 'shellService' | 'dialogs'>

export function registerKnowledgeHandlers(services: KnowledgeServices): void {
  const { knowledgeService, shellService, dialogs } = services
  handle('links:upsert', (input) => knowledgeService.upsertLink(input))
  handle('shell:open-link', ({ itemId }) => shellService.openLink(itemId))
  handle('shell:open-url', ({ url }) => shellService.openUrl(url))
  handle('shell:reveal', (target) => shellService.reveal(target))
  handle('items:list', ({ sectionId }) => knowledgeService.reconcileAndList(sectionId))
  handle('items:read', ({ itemId }) => knowledgeService.read(itemId))
  handle('items:create', ({ sectionId, title, description }) =>
    knowledgeService.create(sectionId, title, description)
  )
  handle('items:save', ({ itemId, content, baseRevision }) =>
    knowledgeService.save(itemId, content, baseRevision)
  )
  handle('items:rename', ({ itemId, title }) => knowledgeService.rename(itemId, title))
  handle('items:set-description', ({ itemId, description }) =>
    knowledgeService.setDescription(itemId, description)
  )
  handle('items:delete', ({ itemId }) => knowledgeService.delete(itemId))
  handle('items:pick-import', async ({ sectionId }) => {
    const paths = await dialogs.pickFiles({
      multi: true,
      filters: [{ name: 'Supported files', extensions: enabledExtensions() }]
    })
    if (!paths) return { added: [], failed: [], conflicts: [] }
    return knowledgeService.importFiles(sectionId, paths)
  })
  handle('items:import', ({ sectionId, paths, onConflict }) =>
    knowledgeService.importFiles(sectionId, paths, onConflict)
  )
}
