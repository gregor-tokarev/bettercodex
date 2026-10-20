import { clipboard, Menu, shell, type BrowserWindow, type ContextMenuParams, type Input, type MenuItemConstructorOptions, type WebContents } from 'electron';
import { browserAction, nextZoom, shortcutKey, type BrowserAction } from '../shared/browserKeys.js';

/** Back/forward/reload of a page view; for a synced copy these go to the machine that owns the tab. */
export interface PageNavigation {
  back(): void;
  forward(): void;
  reload(hard: boolean): void;
  canGoBack(): boolean;
  canGoForward(): boolean;
}

export function localNavigation(wc: WebContents): PageNavigation {
  return {
    back: () => wc.navigationHistory.goBack(),
    forward: () => wc.navigationHistory.goForward(),
    reload: (hard) => (hard ? wc.reloadIgnoringCache() : wc.reload()),
    canGoBack: () => wc.navigationHistory.canGoBack(),
    canGoForward: () => wc.navigationHistory.canGoForward(),
  };
}

/** Panel actions that need the keyboard in the app window (a text field there takes the next keys). */
const TAKES_FOCUS = new Set<BrowserAction['type']>(['focusAddress', 'newTab', 'find']);

/**
 * Keys pressed in a page view: app shortcuts go to the app window, browser shortcuts work like in
 * any browser. Keys replayed into the page for someone else (`synthetic`) are the page's alone, so
 * they cannot close or switch tabs here.
 */
export function handlePageKeys(event: Electron.Event, input: Input, uiWindow: BrowserWindow | null, nav: PageNavigation, wc: WebContents, synthetic?: () => boolean) {
  if (input.type !== 'keyDown' || input.isComposing || synthetic?.()) return;
  const mac = process.platform === 'darwin';
  const mod = mac ? input.meta : input.control;
  const key = shortcutKey({ key: input.key, code: input.code });
  if (mod && !input.alt && (key === 'n' || key === ',' || (key === 'b' && input.shift))) {
    event.preventDefault();
    uiWindow?.webContents.send('app:shortcut', { key, shift: input.shift });
    return;
  }
  const action = browserAction({ key: input.key, code: input.code, ctrl: input.control, meta: input.meta, alt: input.alt, shift: input.shift }, mac);
  if (!action) return;
  switch (action.type) {
    case 'stop':
      // The panel closes its find bar and stops loading; the page gets its Esc too (closing its own popups).
      uiWindow?.webContents.send('browser:action', action);
      return;
    case 'reload':
      nav.reload(action.hard);
      break;
    case 'back':
      nav.back();
      break;
    case 'forward':
      nav.forward();
      break;
    case 'zoom':
      wc.setZoomFactor(nextZoom(wc.getZoomFactor(), action.step));
      uiWindow?.webContents.send('pageView:zoomed', { factor: wc.getZoomFactor() });
      break;
    default:
      // Tabs, the address bar and find belong to the browser panel.
      if (!uiWindow) return;
      if (TAKES_FOCUS.has(action.type)) uiWindow.webContents.focus();
      uiWindow.webContents.send('browser:action', action);
  }
  event.preventDefault();
}

/** Mouse back/forward buttons, reported by the page's preload. */
export function handleNavButton(action: unknown, nav: PageNavigation) {
  if (action === 'back') nav.back();
  else if (action === 'forward') nav.forward();
}

export function showPageMenu(wc: WebContents, p: ContextMenuParams, uiWindow: BrowserWindow | null, nav: PageNavigation, opts: { newTab: boolean }) {
  const items: MenuItemConstructorOptions[] = [];
  if (p.linkURL && /^https?:/i.test(p.linkURL)) {
    if (opts.newTab) items.push({ label: 'Open Link in New Tab', click: () => void wc.executeJavaScript(`window.open(${JSON.stringify(p.linkURL)}, '_blank')`, true) });
    items.push(
      { label: 'Open Link in System Browser', click: () => void shell.openExternal(p.linkURL) },
      { label: 'Copy Link Address', click: () => clipboard.writeText(p.linkURL) },
      { type: 'separator' },
    );
  }
  if (p.mediaType === 'image' && p.srcURL) {
    items.push({ label: 'Copy Image', click: () => wc.copyImageAt(p.x, p.y) }, { label: 'Copy Image Address', click: () => clipboard.writeText(p.srcURL) }, { type: 'separator' });
  }
  if (p.isEditable) {
    items.push(
      { label: 'Cut', role: 'cut', enabled: p.editFlags.canCut },
      { label: 'Copy', role: 'copy', enabled: p.editFlags.canCopy },
      { label: 'Paste', role: 'paste', enabled: p.editFlags.canPaste },
      { label: 'Select All', role: 'selectAll' },
      { type: 'separator' },
    );
  } else if (p.selectionText) {
    items.push({ label: 'Copy', role: 'copy' }, { type: 'separator' });
  }
  items.push(
    { label: 'Back', enabled: nav.canGoBack(), click: () => nav.back() },
    { label: 'Forward', enabled: nav.canGoForward(), click: () => nav.forward() },
    { label: 'Reload', click: () => nav.reload(false) },
    { type: 'separator' },
    // DevTools only from this menu: a key press could be synthesized by the agent.
    {
      label: 'Inspect',
      click: () => {
        wc.openDevTools({ mode: 'detach' });
        wc.inspectElement(p.x, p.y);
      },
    },
  );
  Menu.buildFromTemplate(items).popup(uiWindow ? { window: uiWindow } : {});
}
