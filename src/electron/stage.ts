import { BaseWindow, type BrowserWindow, type WebContentsView } from 'electron';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A page view the panel can show: a local tab or a synced copy of another machine's tab. */
export interface Staged {
  view: WebContentsView;
  size: { width: number; height: number };
}

const DEFAULT_SIZE = { width: 1280, height: 800 };

/**
 * Where page views live. At most one is placed over the browser panel of the app window; the
 * others wait in a hidden window, keeping the size they had on screen so pages do not reflow.
 */
export class ViewStage {
  private parkWindow: BaseWindow | null = null;
  private shown: { item: Staged; win: BrowserWindow } | null = null;

  static defaultSize() {
    return { ...DEFAULT_SIZE };
  }

  /** Created lazily: windows can only exist once the app is ready. */
  private get park() {
    if (!this.parkWindow) this.parkWindow = new BaseWindow({ show: false, ...DEFAULT_SIZE, title: 'BetterCodex tabs' });
    return this.parkWindow;
  }

  add(item: Staged) {
    this.parkView(item);
  }

  remove(item: Staged) {
    if (this.shown?.item === item) {
      if (!this.shown.win.isDestroyed()) this.shown.win.contentView.removeChildView(item.view);
      this.shown = null;
    } else if (this.parkWindow && !this.parkWindow.isDestroyed()) {
      this.parkWindow.contentView.removeChildView(item.view);
    }
  }

  isShown(item: Staged) {
    return this.shown?.item === item;
  }

  /** Shows `item` in `win` at `bounds` (renderer CSS pixels), or hides whatever is shown there. */
  show(win: BrowserWindow, item: Staged | null, bounds: Rect | null) {
    if (this.shown && (this.shown.item !== item || this.shown.win !== win || !bounds)) this.parkShown();
    if (!item || !bounds || win.isDestroyed() || item.view.webContents.isDestroyed()) return false;
    if (!this.shown) {
      if (!this.park.isDestroyed()) this.park.contentView.removeChildView(item.view);
      win.contentView.addChildView(item.view);
      this.shown = { item, win };
    }
    // The renderer measures in CSS pixels; views are placed in window pixels (they differ when the UI is zoomed).
    const zoom = win.webContents.getZoomFactor() || 1;
    const rect = {
      x: Math.round(bounds.x * zoom),
      y: Math.round(bounds.y * zoom),
      width: Math.max(1, Math.round(bounds.width * zoom)),
      height: Math.max(1, Math.round(bounds.height * zoom)),
    };
    item.view.setBounds(rect);
    item.size = { width: rect.width, height: rect.height };
    return true;
  }

  /** The app window went away: its view moves back to the hidden window. */
  windowClosed(win: BrowserWindow) {
    if (this.shown?.win !== win) return;
    const item = this.shown.item;
    this.shown = null;
    this.parkView(item);
  }

  /** Resizes a view that is not on screen. */
  resize(item: Staged, width: number, height: number) {
    if (this.shown?.item === item || item.view.webContents.isDestroyed()) return;
    item.size = { width: Math.max(240, Math.min(3840, Math.round(width))), height: Math.max(200, Math.min(2400, Math.round(height))) };
    item.view.setBounds({ x: 0, y: 0, ...item.size });
  }

  /** Temporarily gives a hidden view another size (full-page captures). */
  setParkedBounds(item: Staged, width: number, height: number) {
    if (this.shown?.item === item || item.view.webContents.isDestroyed()) return false;
    item.view.setBounds({ x: 0, y: 0, width, height });
    return true;
  }

  private parkShown() {
    const shown = this.shown;
    this.shown = null;
    if (!shown) return;
    if (!shown.win.isDestroyed()) shown.win.contentView.removeChildView(shown.item.view);
    this.parkView(shown.item);
  }

  private parkView(item: Staged) {
    if (this.park.isDestroyed() || item.view.webContents.isDestroyed()) return;
    this.park.contentView.addChildView(item.view);
    item.view.setBounds({ x: 0, y: 0, ...item.size });
  }
}
