// The browser's keyboard shortcuts, shared by the page views (main process), the address bar and
// the streamed view (renderer), so a key does the same thing wherever the focus is.

export type BrowserAction =
  | { type: 'focusAddress' }
  | { type: 'newTab' }
  | { type: 'closeTab' }
  | { type: 'reopenTab' }
  | { type: 'nextTab' }
  | { type: 'prevTab' }
  /** 0-based; -1 is the last tab. */
  | { type: 'selectTab'; index: number }
  | { type: 'reload'; hard: boolean }
  | { type: 'back' }
  | { type: 'forward' }
  /** Stops loading; the page still gets the Esc key. */
  | { type: 'stop' }
  | { type: 'find' }
  | { type: 'findNext'; backwards: boolean }
  | { type: 'zoom'; step: 1 | -1 | 0 };

export interface KeyPress {
  key: string;
  code: string;
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
}

/** The latin letter or digit of a key, also on other keyboard layouts (Ctrl+Е is Ctrl+T). */
export function shortcutKey(k: Pick<KeyPress, 'key' | 'code'>) {
  if (/^[a-z0-9]$/i.test(k.key)) return k.key.toLowerCase();
  const m = /^(?:Key([A-Z])|Digit(\d))$/.exec(k.code);
  return m ? (m[1] ?? m[2]).toLowerCase() : k.key.toLowerCase();
}

export function browserAction(k: KeyPress, mac: boolean): BrowserAction | null {
  const mod = mac ? k.meta : k.ctrl;
  // The other platform modifier held too is some other shortcut.
  const other = mac ? k.ctrl : k.meta;
  const c = shortcutKey(k);
  if (mod && !other && !k.alt) {
    if (c === 'l' && !k.shift) return { type: 'focusAddress' };
    if (c === 't') return k.shift ? { type: 'reopenTab' } : { type: 'newTab' };
    if (c === 'w' && !k.shift) return { type: 'closeTab' };
    if (c === 'r') return { type: 'reload', hard: k.shift };
    if (c === 'f' && !k.shift) return { type: 'find' };
    if (c === 'g') return { type: 'findNext', backwards: k.shift };
    if (!k.shift && /^[1-9]$/.test(c)) return { type: 'selectTab', index: c === '9' ? -1 : Number(c) - 1 };
    if (k.key === '=' || k.key === '+' || k.code === 'Equal' || k.code === 'NumpadAdd') return { type: 'zoom', step: 1 };
    if (k.key === '-' || k.key === '_' || k.code === 'Minus' || k.code === 'NumpadSubtract') return { type: 'zoom', step: -1 };
    if (!k.shift && (c === '0' || k.code === 'Numpad0')) return { type: 'zoom', step: 0 };
    if (mac && !k.shift && k.code === 'BracketLeft') return { type: 'back' };
    if (mac && !k.shift && k.code === 'BracketRight') return { type: 'forward' };
    if (mac && k.shift && k.code === 'BracketLeft') return { type: 'prevTab' };
    if (mac && k.shift && k.code === 'BracketRight') return { type: 'nextTab' };
  }
  if (k.ctrl && !k.meta && !k.alt) {
    if (k.key === 'Tab') return k.shift ? { type: 'prevTab' } : { type: 'nextTab' };
    if (!k.shift && k.key === 'PageDown') return { type: 'nextTab' };
    if (!k.shift && k.key === 'PageUp') return { type: 'prevTab' };
    if (!mac && !k.shift && k.key === 'F4') return { type: 'closeTab' };
  }
  if (mac && k.meta && k.alt && !k.ctrl && !k.shift) {
    if (k.key === 'ArrowRight') return { type: 'nextTab' };
    if (k.key === 'ArrowLeft') return { type: 'prevTab' };
  }
  if (!mac && k.alt && !k.ctrl && !k.meta && !k.shift) {
    if (k.key === 'ArrowLeft') return { type: 'back' };
    if (k.key === 'ArrowRight') return { type: 'forward' };
    if (c === 'd') return { type: 'focusAddress' };
  }
  if (k.key === 'BrowserBack') return { type: 'back' };
  if (k.key === 'BrowserForward') return { type: 'forward' };
  if (k.key === 'F5' && !k.meta) return { type: 'reload', hard: k.shift || k.ctrl };
  if (k.key === 'F6' && !k.ctrl && !k.meta && !k.alt && !k.shift) return { type: 'focusAddress' };
  if (k.key === 'F3' && !k.ctrl && !k.meta && !k.alt) return { type: 'findNext', backwards: k.shift };
  if (k.key === 'Escape' && !k.ctrl && !k.meta && !k.alt && !k.shift) return { type: 'stop' };
  return null;
}

/** Chrome's zoom levels, as factors. */
const ZOOM_FACTORS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];

export function nextZoom(current: number, step: 1 | -1 | 0) {
  if (step === 0) return 1;
  if (step > 0) return ZOOM_FACTORS.find((f) => f > current + 0.001) ?? ZOOM_FACTORS[ZOOM_FACTORS.length - 1];
  return [...ZOOM_FACTORS].reverse().find((f) => f < current - 0.001) ?? ZOOM_FACTORS[0];
}
