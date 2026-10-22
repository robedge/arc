import type { MenuItemConstructorOptions } from 'electron'

export interface AppMenuOptions {
  isDev: boolean
  appName: string
  openDesignPreview: () => void
}

/**
 * The application menu. Quit uses the standard role, which goes through `before-quit` and so
 * through the close gate. Zoom items are deliberately absent: the layout is fixed-size.
 */
export function buildAppMenuTemplate(options: AppMenuOptions): MenuItemConstructorOptions[] {
  const { isDev, appName, openDesignPreview } = options
  return [
    {
      label: appName,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    { label: 'File', submenu: [{ role: 'close' }] },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        ...(isDev
          ? ([
              { role: 'reload' },
              { role: 'forceReload' },
              { role: 'toggleDevTools' },
              { type: 'separator' }
            ] as MenuItemConstructorOptions[])
          : []),
        { role: 'togglefullscreen' }
      ]
    },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'front' }] },
    {
      role: 'help',
      submenu: [{ id: 'help-design-preview', label: 'Design Preview', click: openDesignPreview }]
    }
  ]
}
