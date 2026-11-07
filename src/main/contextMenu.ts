import { t } from './i18n'
import { clipboard, Menu, shell, type WebContents } from 'electron'

export function attachContextMenu(contents: WebContents): void {
  contents.on('context-menu', (_event, params) => {
    const menuItems: Electron.MenuItemConstructorOptions[] = []

    // Spell-check suggestions (if any)
    if (params.misspelledWord && params.dictionarySuggestions?.length) {
      for (const suggestion of params.dictionarySuggestions) {
        menuItems.push({
          label: suggestion,
          click: () => contents.replaceMisspelling(suggestion)
        })
      }
      menuItems.push({ type: 'separator' })
    }

    // Link handling
    if (/^https?:\/\//i.test(params.linkURL)) {
      menuItems.push({
        label: t('menu.openLink'),
        click: () => void shell.openExternal(params.linkURL).catch(() => {})
      })
      menuItems.push({
        label: t('menu.copyLink'),
        click: () => void clipboard.writeText(params.linkURL).catch(() => {})
      })
      menuItems.push({ type: 'separator' })
    }

    // Keep edits in the clicked view, even if another connection gains focus.
    if (params.isEditable) {
      menuItems.push(
        { label: t('menu.undo'), click: () => contents.undo(), enabled: params.editFlags.canUndo },
        { label: t('menu.redo'), click: () => contents.redo(), enabled: params.editFlags.canRedo },
        { type: 'separator' },
        { label: t('menu.cut'), click: () => contents.cut(), enabled: params.editFlags.canCut },
        { label: t('menu.copy'), click: () => contents.copy(), enabled: params.editFlags.canCopy },
        {
          label: t('menu.paste'),
          click: () => contents.paste(),
          enabled: params.editFlags.canPaste
        },
        {
          label: t('menu.selectAll'),
          click: () => contents.selectAll(),
          enabled: params.editFlags.canSelectAll
        }
      )
    } else if (params.selectionText) {
      // Non-editable text selection
      menuItems.push({
        label: t('menu.copy'),
        click: () => contents.copy(),
        enabled: params.editFlags.canCopy
      })
    }

    if (params.mediaType === 'image') {
      if (menuItems.length > 0 && menuItems[menuItems.length - 1].type !== 'separator') {
        menuItems.push({ type: 'separator' })
      }
      menuItems.push(
        {
          label: t('menu.copyImage'),
          enabled: params.hasImageContents,
          click: () => contents.copyImageAt(params.x, params.y)
        },
        {
          label: t('menu.saveImage'),
          enabled: !!params.srcURL,
          click: () => contents.downloadURL(params.srcURL)
        }
      )
    }

    if (menuItems.length > 0) {
      Menu.buildFromTemplate(menuItems).popup()
    }
  })
}
