// Browser shortcuts end up in the browser panel, whether they were pressed in the app window or in a
// page view (reported by the main process). Some work from anywhere and open the panel first.
import { browserAction, type BrowserAction } from '../../shared/browserKeys';
import { bc, isMac } from './bridge';
import { getState, setPrefs } from './store';

type Handler = (action: BrowserAction, fromPage: boolean) => void;

let handler: Handler | null = null;
const queued: Array<{ action: BrowserAction; fromPage: boolean }> = [];

/** Runs `action` in the browser panel, opening the panel first if needed. */
export function runBrowserAction(action: BrowserAction, fromPage = false) {
  if (handler) return handler(action, fromPage);
  const s = getState();
  if (!s.selection || s.view !== 'thread') return;
  queued.push({ action, fromPage });
  setPrefs({ browserOpen: true });
}

/** Called by the mounted browser panel; actions waiting for it run right away. */
export function handleBrowserActions(h: Handler) {
  handler = h;
  for (const q of queued.splice(0)) h(q.action, q.fromPage);
  return () => {
    if (handler === h) handler = null;
  };
}

bc.onBrowserAction((action) => runBrowserAction(action, true));

/** Whether the person is working in the browser panel (address bar, tabs, find bar) rather than the chat. */
let inPanel = false;
const track = (e: Event) => {
  inPanel = !!(e.target as Element | null)?.closest?.('.browser-panel');
};
window.addEventListener('pointerdown', track, true);
window.addEventListener('focusin', track, true);

export function inBrowserPanel() {
  return inPanel;
}

/** Shortcuts that also work while the chat has the focus; the others need the browser to have it. */
const ANYWHERE = new Set<BrowserAction['type']>(['newTab', 'reopenTab', 'focusAddress']);

/** Handles a key pressed in the app window if it is a browser shortcut; true when it was. */
export function browserKeyDown(e: KeyboardEvent) {
  if (e.defaultPrevented || e.isComposing) return false;
  const action = browserAction({ key: e.key, code: e.code, ctrl: e.ctrlKey, meta: e.metaKey, alt: e.altKey, shift: e.shiftKey }, isMac);
  if (!action || (!ANYWHERE.has(action.type) && !inPanel)) return false;
  // Esc also keeps doing whatever else it does there.
  if (action.type !== 'stop') e.preventDefault();
  runBrowserAction(action);
  return true;
}
