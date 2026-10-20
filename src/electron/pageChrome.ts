import { clipboard, Menu, shell, type BrowserWindow, type ContextMenuParams, type Input, type MenuItemConstructorOptions, type WebContents } from 'electron';

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

/** Keys pressed in a page view: app shortcuts go to the app window, browser keys to the page. */
export function handlePageKeys(event: Electron.Event, input: Input, uiWindow: BrowserWindow | null, nav: PageNavigation) {
  if (input.type !== 'keyDown') return;
  const mod = process.platform === 'darwin' ? input.meta : input.control;
  const key = input.key.toLowerCase();
  if (mod && !input.alt && (key === 'l' || key === 'n' || key === ',' || (key === 'b' && input.shift))) {
    event.preventDefault();
    uiWindow?.webContents.send('app:shortcut', { key, shift: input.shift });
    return;
  }
  if ((mod && key === 'r') || input.key === 'F5') {
    event.preventDefault();
    nav.reload(input.shift);
    return;
  }
  if (input.alt && !mod && (input.key === 'ArrowLeft' || input.key === 'ArrowRight')) {
    event.preventDefault();
    if (input.key === 'ArrowLeft') nav.back();
    else nav.forward();
  }
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
