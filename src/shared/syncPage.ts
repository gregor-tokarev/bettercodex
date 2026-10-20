// Tab sync between machines: instead of streaming pixels, every machine renders the page itself
// and the machines exchange what happened (actions) plus the tab's state, eventually agreeing.
//
// The two functions at the bottom run inside web pages on both machines. They are injected with
// .toString(), so they must not use anything defined outside their own body.

/** How an element is found again in another copy of the same page. */
export interface ElementRef {
  tag: string;
  id?: string;
  testId?: string;
  nameAttr?: string;
  role?: string;
  /** Accessible name (aria-label, label, alt, text…), normalized and cut to 80 characters. */
  label?: string;
  /** Structural path, the fallback when nothing better identifies the element. */
  css: string;
}

/** Frames are matched by URL; null is the top document. */
export interface FrameRef {
  url: string;
  name: string;
}

export type Modifier = 'Alt' | 'Control' | 'Meta' | 'Shift';

/** Every action names the document it happened in (`doc`, its URL); elsewhere it only replays there. */
interface ActionBase {
  frame: FrameRef | null;
  doc?: string;
}

export type SyncAction = ActionBase &
  (
    | { kind: 'click'; target: ElementRef; fx: number; fy: number; button: 'left' | 'middle' | 'right'; clickCount: number; modifiers: Modifier[] }
    | { kind: 'input'; target: ElementRef; value: string }
    | { kind: 'check'; target: ElementRef; checked: boolean }
    | { kind: 'select'; target: ElementRef; values: string[] }
    | { kind: 'key'; target: ElementRef | null; key: string; modifiers: Modifier[] }
    | { kind: 'scroll'; target: ElementRef | null; x: number; y: number }
  );

/** Same document? (The fragment does not make another one.) */
export function sameDocument(a: string | undefined, b: string | undefined) {
  return !!a && !!b && a.split('#')[0] === b.split('#')[0];
}

export interface SyncField {
  frame: FrameRef | null;
  target: ElementRef;
  value?: string;
  checked?: boolean;
  values?: string[];
}

export interface SyncCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

/** The machine that owns the tab is the source of truth; copies converge to this. */
export interface SyncState {
  /** Last action the owner applied. */
  seq: number;
  /** Counts the owner's top-level navigations (a reload keeps the URL but changes this). */
  nav: number;
  url: string;
  title: string;
  scroll: { x: number; y: number };
  /** Form fields someone changed, with the owner's current values. */
  fields: SyncField[];
  /** The owner sent data to a site since the last state (a copy should refetch the page). */
  mutated: boolean;
  /** localStorage of the top document's origin, when it changed. */
  storage?: { origin: string; items: Record<string, string> };
  /** IndexedDB of the top document's origin (sign-ins often live there), when it changed. */
  indexedDB?: IndexedDbDump;
}

export interface IndexedDbDump {
  origin: string;
  databases: Array<{
    name: string;
    version: number;
    stores: Array<{
      name: string;
      keyPath: string | string[] | null;
      autoIncrement: boolean;
      indexes: Array<{ name: string; keyPath: string | string[]; unique: boolean; multiEntry: boolean }>;
      /** [key, value], both encoded by indexedDbOp. */
      rows: Array<[unknown, unknown]>;
    }>;
  }>;
}

/** A frame a WebSocket of the owner's page received (binary ones in base64). */
export interface SocketFrame {
  data: string;
  binary?: boolean;
}

/** The first frames of each WebSocket (a handshake, usually) are kept for copies connecting later. */
export const SOCKET_HANDSHAKE_FRAMES = 20;
export const SOCKET_HANDSHAKE_BYTES = 256 * 1024;

// ---- /sync websocket: JSON text frames ----

export type SyncClientMessage =
  | { t: 'subscribe'; tabId: string }
  | { t: 'unsubscribe'; tabId: string }
  | { t: 'action'; tabId: string; id: string; action: SyncAction }
  | { t: 'navigate'; tabId: string; action: 'back' | 'forward' | 'reload' };

export type SyncHostMessage =
  | {
      t: 'snapshot';
      tabId: string;
      state: SyncState;
      cookies: SyncCookie[];
      /** The page's open WebSockets, with the first frames each received (their handshake). */
      sockets: Array<{ id: string; url: string; origin: string; frames: SocketFrame[] }>;
    }
  | { t: 'state'; tabId: string; state: SyncState; cookies?: { set: SyncCookie[]; removed: Array<Pick<SyncCookie, 'name' | 'domain' | 'path'>> } }
  | { t: 'action'; tabId: string; seq: number; action: SyncAction }
  | { t: 'ack'; tabId: string; id: string; seq: number; error?: string }
  | { t: 'gone'; tabId: string; error?: string }
  | ({ t: 'request'; tabId: string } & SyncRequest)
  | ({ t: 'response'; tabId: string } & SyncResponse)
  /** A dialog opened on the owner (`url`: the frame showing it), or was answered there. */
  | { t: 'dialog'; tabId: string; open: boolean; type: string; message: string; url: string; accept?: boolean; value?: string | null }
  /** The owner's page WebSockets: copies never connect themselves, they get what the owner receives. */
  | ({ t: 'socket'; tabId: string; id: string } & SocketEvent);

/** `origin`: of the document that opened the socket (only a frame of that origin gets its messages). */
export type SocketEvent = { event: 'open'; url: string; origin: string } | ({ event: 'message' } & SocketFrame) | { event: 'close' };

/**
 * A request of the owner's page whose answer goes to the copies: one that sends data right after an
 * action (`doc` unset), or a page the owner got by posting a form (`doc` is its URL). Copies make
 * the same request when they replay the action, and get the owner's answer instead of sending it.
 */
export interface SyncRequest extends RequestIdentity {
  id: string;
  doc?: string;
}

/** Identifies a request across machines, from exact (same address and data) to loose. */
export interface RequestIdentity {
  /** Method and address without the query. */
  key: string;
  /** Method, full address and data; null when the data is not known. */
  exact: string | null;
  /** Like exact, with numbers and long tokens (timestamps, ids, nonces) left out. */
  loose: string;
}

/** The owner's answer to a SyncRequest (same id), sent once the whole response is in. */
export interface SyncResponse {
  id: string;
  status: number;
  statusText: string;
  headers: Array<{ name: string; value: string }>;
  /** base64 */
  body: string;
  /** The owner's request failed (no answer). */
  failed?: boolean;
}

/** After an action, requests that send data are answered by the owner for this long. */
export const ACTION_WINDOW_MS = 8000;

/** Method and address without the query (which often carries timestamps). */
export function requestKey(method: string, url: string) {
  try {
    const u = new URL(url);
    return `${method.toUpperCase()} ${u.origin}${u.pathname}`;
  } catch {
    return `${method.toUpperCase()} ${url}`;
  }
}

export function requestIdentity(method: string, url: string, body: Uint8Array | null): RequestIdentity {
  const key = requestKey(method, url);
  const query = url.split('#')[0].split('?')[1] ?? '';
  const text = body ? new TextDecoder().decode(body.subarray(0, 256 * 1024)) : '';
  const vague = (s: string) => s.replace(/[0-9a-f]{8,}(?:-[0-9a-f]{4,})*|[\w-]{24,}|\d+(?:\.\d+)?/gi, '#');
  return {
    key,
    exact: body ? hash(`${method.toUpperCase()} ${url.split('#')[0]}\n${hash(body)}`) : null,
    loose: hash(`${key}?${vague(query)}\n${vague(text)}`),
  };
}

/** A fast 53-bit hash (cyrb53); matching requests needs no cryptography. */
function hash(data: string | Uint8Array) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < data.length; i++) {
    const ch = typeof data === 'string' ? data.charCodeAt(i) : data[i];
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** Pages a copy on another computer could not load: that machine's own servers and files. */
export function onlyReachableThere(url: string) {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === 'file:') return true;
  if (!/^https?:$/.test(parsed.protocol)) return false;
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || !host.includes('.')) return true;
  if (host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:')) return host.includes(':');
  const ip = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(host);
  if (!ip) return false;
  const [a, b] = [Number(ip[1]), Number(ip[2])];
  return a === 127 || a === 10 || a === 0 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}

/** Key used to recognize an action coming back from the copy that just replayed it. */
export function echoKey(a: { kind: string; frame: FrameRef | null; target: ElementRef | null }) {
  return `${a.kind}|${a.frame?.url ?? ''}|${a.target?.css ?? ''}`;
}

/**
 * Installs the recorder in a document. Clicks and keys are reported only when trusted (a person,
 * or the agent's real input events); field values also when a script set them on the owning
 * machine (Playwright's selectOption does that), because applying a value twice is harmless.
 * Copies (`replica`) never report script-set values (that is how they apply the owner's), refuse
 * to submit POST forms and do not open file pickers; the owning machine does those.
 * Returns a function that reports typing still waiting to be sent, right away.
 */
export function installSyncRecorder(emit: (json: string) => void, replica: boolean): () => void {
  const w = window as any;
  if (w.__bettercodexRecorder) return () => {};
  w.__bettercodexRecorder = true;

  const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const label = (el: Element): string => {
    const aria = el.getAttribute('aria-label');
    if (aria) return clean(aria);
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const text = by
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? '')
        .join(' ');
      if (clean(text)) return clean(text);
    }
    const labels = (el as HTMLInputElement).labels;
    if (labels && labels.length) return clean(labels[0].textContent);
    for (const attr of ['alt', 'title', 'placeholder']) {
      const v = el.getAttribute(attr);
      if (v) return clean(v);
    }
    if (el instanceof HTMLInputElement && ['submit', 'button', 'reset'].includes(el.type)) return clean(el.value);
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return '';
    if ((el as HTMLElement).isContentEditable) return '';
    return clean((el as HTMLElement).innerText ?? el.textContent);
  };
  const cssPath = (el: Element) => {
    const parts: string[] = [];
    for (let node: Element | null = el; node && node !== document.documentElement; node = node.parentElement) {
      if (node.id && /^[A-Za-z][\w-]*$/.test(node.id) && !/\d{4,}/.test(node.id) && document.querySelectorAll(`#${CSS.escape(node.id)}`).length === 1) {
        parts.unshift(`#${CSS.escape(node.id)}`);
        break;
      }
      const tag = node.tagName.toLowerCase();
      const parent: Element | null = node.parentElement;
      if (!parent) {
        parts.unshift(tag);
        break;
      }
      const same = Array.from(parent.children).filter((c) => c.tagName === node!.tagName);
      parts.unshift(same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(node) + 1})` : tag);
    }
    return parts.join(' > ');
  };
  const describe = (el: Element) => {
    const ref: Record<string, string> = { tag: el.tagName.toLowerCase(), css: cssPath(el) };
    if (el.id && !/\d{4,}|[0-9a-f]{8,}|:/i.test(el.id)) ref.id = el.id;
    const testId = el.getAttribute('data-testid') ?? el.getAttribute('data-test') ?? el.getAttribute('data-qa') ?? el.getAttribute('data-test-id');
    if (testId) ref.testId = testId;
    const nameAttr = el.getAttribute('name');
    if (nameAttr) ref.nameAttr = nameAttr;
    const role = el.getAttribute('role');
    if (role) ref.role = role;
    const text = label(el);
    if (text) ref.label = text;
    return ref;
  };
  const editableRoot = (el: Element) => {
    let root = el as HTMLElement;
    while (root.parentElement && root.parentElement.isContentEditable) root = root.parentElement;
    return root;
  };
  const isTextField = (el: Element | null) =>
    !!el &&
    ((el instanceof HTMLInputElement && !['checkbox', 'radio', 'file', 'button', 'submit', 'reset', 'image', 'color', 'range'].includes(el.type)) ||
      el instanceof HTMLTextAreaElement ||
      (el as HTMLElement).isContentEditable);
  const modifiers = (e: KeyboardEvent | MouseEvent) => {
    const m: string[] = [];
    if (e.altKey) m.push('Alt');
    if (e.ctrlKey) m.push('Control');
    if (e.metaKey) m.push('Meta');
    if (e.shiftKey) m.push('Shift');
    return m;
  };
  const send = (action: Record<string, unknown>) => {
    try {
      emit(JSON.stringify({ ...action, doc: location.href }));
    } catch {
      // the other side is gone
    }
  };

  // Typed text is reported as the field's whole value once typing pauses (or before a click/key).
  const pending = new Map<Element, ReturnType<typeof setTimeout>>();
  const valueOf = (el: Element) => ((el as HTMLElement).isContentEditable ? (el as HTMLElement).innerText : (el as HTMLInputElement).value);
  const flush = (el: Element) => {
    const timer = pending.get(el);
    if (timer === undefined) return;
    clearTimeout(timer);
    pending.delete(el);
    if (el.isConnected) send({ kind: 'input', target: describe(el), value: valueOf(el) });
  };
  const flushAll = () => {
    for (const el of Array.from(pending.keys())) flush(el);
  };

  // Scripts can make trusted-looking input (execCommand), so a copy only reports values right after
  // the person did something: a key, a pointer, pasting, dropping or an input method.
  let lastUserInput = 0;
  let lastGesture = 0;
  let gestureTarget: EventTarget | null = null;
  for (const type of ['pointerdown', 'wheel', 'keydown', 'touchmove']) {
    addEventListener(
      type,
      (e) => {
        if (e.isTrusted) lastUserInput = Date.now();
      },
      { capture: true, passive: true },
    );
  }
  for (const type of ['pointerdown', 'keydown', 'paste', 'cut', 'drop', 'beforeinput', 'compositionend']) {
    addEventListener(
      type,
      (e) => {
        if (!e.isTrusted) return;
        lastGesture = Date.now();
        gestureTarget = e.target;
      },
      { capture: true, passive: true },
    );
  }
  // Selects, colors and dates are chosen in a popup of their own (no page events): the choice may
  // come long after the click that opened it.
  const PICKERS = ['color', 'date', 'time', 'datetime-local', 'month', 'week'];
  const picker = (el: EventTarget | null) => el instanceof HTMLSelectElement || (el instanceof HTMLInputElement && PICKERS.includes(el.type));

  addEventListener(
    'click',
    (e) => {
      // detail 0: the click came from a key (Enter/Space) or a form's implicit submit; the key travels instead.
      if (!e.isTrusted || e.detail === 0 || !(e.target instanceof Element)) return;
      const hit = e.target.closest('a,button,input,select,textarea,label,summary,option,[role],[onclick],[tabindex],[contenteditable]') ?? e.target;
      // Native selects open their own popup; the chosen value travels as a 'select' action.
      if (hit instanceof HTMLSelectElement || hit instanceof HTMLOptionElement) return;
      flushAll();
      const r = hit.getBoundingClientRect();
      send({
        kind: 'click',
        target: describe(hit),
        fx: r.width ? Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) : 0.5,
        fy: r.height ? Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) : 0.5,
        button: ['left', 'middle', 'right'][e.button] ?? 'left',
        clickCount: e.detail,
        modifiers: modifiers(e),
      });
      if (replica && hit instanceof HTMLInputElement && hit.type === 'file') e.preventDefault();
    },
    true,
  );

  const counts = (e: Event) =>
    replica ? e.isTrusted && (Date.now() - lastGesture < 1500 || (picker(e.target) && e.target === gestureTarget && Date.now() - lastGesture < 300000)) : true;
  addEventListener(
    'input',
    (e) => {
      if (!counts(e) || !(e.target instanceof Element)) return;
      let el: Element = e.target;
      if ((el as HTMLElement).isContentEditable) el = editableRoot(el);
      else if (!isTextField(el) && !(el instanceof HTMLInputElement && (el.type === 'range' || el.type === 'color'))) return;
      const timer = pending.get(el);
      if (timer !== undefined) clearTimeout(timer);
      pending.set(
        el,
        setTimeout(() => flush(el), 300),
      );
    },
    true,
  );

  addEventListener(
    'change',
    (e) => {
      if (!counts(e)) return;
      const el = e.target;
      if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) send({ kind: 'check', target: describe(el), checked: el.checked });
      else if (el instanceof HTMLSelectElement) {
        send({ kind: 'select', target: describe(el), values: Array.from(el.selectedOptions).map((o) => o.value) });
      }
    },
    true,
  );

  const SPECIAL = ['Enter', 'Escape', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', 'Backspace', 'Delete', ' '];
  addEventListener(
    'keydown',
    (e) => {
      if (!e.isTrusted || e.isComposing || !SPECIAL.includes(e.key)) return;
      const el = document.activeElement;
      if (isTextField(el)) {
        // Inside text the value travels by itself; only keys that act on the field are sent.
        if (!['Enter', 'Escape', 'Tab', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
        if (e.key === 'Enter' && (el instanceof HTMLTextAreaElement || (el as HTMLElement).isContentEditable) && !e.ctrlKey && !e.metaKey) return;
        flush((el as HTMLElement).isContentEditable ? editableRoot(el!) : el!);
      }
      send({
        kind: 'key',
        target: el && el !== document.body && el !== document.documentElement ? describe(el) : null,
        key: e.key === ' ' ? 'Space' : e.key,
        modifiers: modifiers(e),
      });
    },
    true,
  );

  // Scrolling is reported only when it follows user input (pages also scroll by themselves).
  const scrollTimers = new Map<EventTarget, ReturnType<typeof setTimeout>>();
  addEventListener(
    'scroll',
    (e) => {
      if (Date.now() - lastUserInput > 1500) return;
      const t = e.target;
      if (scrollTimers.has(t!)) return;
      scrollTimers.set(
        t!,
        setTimeout(() => {
          scrollTimers.delete(t!);
          const el = t instanceof Element ? t : null;
          send({ kind: 'scroll', target: el ? describe(el) : null, x: el ? el.scrollLeft : scrollX, y: el ? el.scrollTop : scrollY });
        }, 250),
      );
    },
    { capture: true, passive: true },
  );

  if (replica) {
    // A copy never sends data anywhere; the owning machine submits forms when the click arrives there.
    addEventListener(
      'submit',
      (e) => {
        const form = e.target as HTMLFormElement;
        if (form instanceof HTMLFormElement && (form.method || 'get').toLowerCase() === 'post') e.preventDefault();
      },
      true,
    );
  }
  return flushAll;
}

/**
 * Finds an element described by an ElementRef and works with it. Returns plain data, or the
 * element itself for op "element" (the owning machine turns that into a Playwright handle).
 */
export function syncPageOp(op: string, ref: ElementRef | null, arg?: any): any {
  const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const label = (el: Element): string => {
    const aria = el.getAttribute('aria-label');
    if (aria) return clean(aria);
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const text = by
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? '')
        .join(' ');
      if (clean(text)) return clean(text);
    }
    const labels = (el as HTMLInputElement).labels;
    if (labels && labels.length) return clean(labels[0].textContent);
    for (const attr of ['alt', 'title', 'placeholder']) {
      const v = el.getAttribute(attr);
      if (v) return clean(v);
    }
    if (el instanceof HTMLInputElement && ['submit', 'button', 'reset'].includes(el.type)) return clean(el.value);
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return '';
    if ((el as HTMLElement).isContentEditable) return '';
    return clean((el as HTMLElement).innerText ?? el.textContent);
  };
  const find = (r: ElementRef | null): Element | null => {
    if (!r) return null;
    const ok = (el: Element | null): el is Element => !!el && el.tagName.toLowerCase() === r.tag;
    const one = (selector: string) => {
      try {
        const list = document.querySelectorAll(selector);
        return list.length === 1 ? list[0] : null;
      } catch {
        return null;
      }
    };
    if (r.id) {
      const el = document.getElementById(r.id);
      if (ok(el)) return el;
    }
    if (r.testId) {
      for (const attr of ['data-testid', 'data-test', 'data-qa', 'data-test-id']) {
        const el = one(`[${attr}="${CSS.escape(r.testId)}"]`);
        if (ok(el)) return el;
      }
    }
    if (r.nameAttr) {
      const el = one(`${r.tag}[name="${CSS.escape(r.nameAttr)}"]`);
      if (el) return el;
    }
    let byPath: Element | null = null;
    try {
      byPath = document.querySelector(r.css);
    } catch {
      byPath = null;
    }
    if (ok(byPath) && (r.label === undefined || label(byPath) === r.label)) return byPath;
    if (r.label) {
      const matches = Array.from(document.querySelectorAll(r.tag)).filter((el) => label(el) === r.label);
      if (matches.length) return matches[0];
    }
    return ok(byPath) ? byPath : null;
  };

  if (op === 'dirtyFields') {
    // Fields filled before anyone watched (the recorder was not there yet). Values a framework keeps
    // in sync with the value attribute look untouched, so every filled text field counts.
    const cssPath = (el: Element) => {
      const parts: string[] = [];
      for (let node: Element | null = el; node && node !== document.documentElement; node = node.parentElement) {
        if (node.id && /^[A-Za-z][\w-]*$/.test(node.id) && !/\d{4,}/.test(node.id) && document.querySelectorAll(`#${CSS.escape(node.id)}`).length === 1) {
          parts.unshift(`#${CSS.escape(node.id)}`);
          break;
        }
        const tag = node.tagName.toLowerCase();
        const parent: Element | null = node.parentElement;
        if (!parent) {
          parts.unshift(tag);
          break;
        }
        const same = Array.from(parent.children).filter((c) => c.tagName === node!.tagName);
        parts.unshift(same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(node) + 1})` : tag);
      }
      return parts.join(' > ');
    };
    const describe = (el: Element) => {
      const ref: Record<string, string> = { tag: el.tagName.toLowerCase(), css: cssPath(el) };
      if (el.id && !/\d{4,}|[0-9a-f]{8,}|:/i.test(el.id)) ref.id = el.id;
      const testId = el.getAttribute('data-testid') ?? el.getAttribute('data-test') ?? el.getAttribute('data-qa') ?? el.getAttribute('data-test-id');
      if (testId) ref.testId = testId;
      const nameAttr = el.getAttribute('name');
      if (nameAttr) ref.nameAttr = nameAttr;
      const role = el.getAttribute('role');
      if (role) ref.role = role;
      const text = label(el);
      if (text) ref.label = text;
      return ref;
    };
    const fields: Array<{ target: Record<string, string>; value?: string; checked?: boolean; values?: string[] }> = [];
    for (const el of Array.from(document.querySelectorAll('input, textarea, select'))) {
      if (fields.length >= 60) break;
      if (el instanceof HTMLInputElement) {
        if (['button', 'submit', 'reset', 'image', 'file', 'hidden'].includes(el.type)) continue;
        if (el.type === 'checkbox' || el.type === 'radio') {
          if (el.checked !== el.defaultChecked) fields.push({ target: describe(el), checked: el.checked });
        } else if (el.value !== el.defaultValue || (el.value && el.type !== 'range' && el.type !== 'color')) fields.push({ target: describe(el), value: el.value });
      } else if (el instanceof HTMLTextAreaElement) {
        if (el.value) fields.push({ target: describe(el), value: el.value });
      } else if (el instanceof HTMLSelectElement && Array.from(el.options).some((o) => o.selected !== o.defaultSelected)) {
        fields.push({ target: describe(el), values: Array.from(el.selectedOptions).map((o) => o.value) });
      }
    }
    return fields;
  }
  if (op === 'scrollPos') return { x: Math.round(scrollX), y: Math.round(scrollY) };
  if (op === 'storage') {
    try {
      const items: Record<string, string> = {};
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i)!;
        items[key] = localStorage.getItem(key) ?? '';
      }
      return { origin: location.origin, items };
    } catch {
      return null;
    }
  }
  if (op === 'setStorage') {
    try {
      const items = arg as Record<string, string>;
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const key = localStorage.key(i);
        if (key !== null && !(key in items)) localStorage.removeItem(key);
      }
      for (const [key, value] of Object.entries(items)) if (localStorage.getItem(key) !== value) localStorage.setItem(key, value);
    } catch {
      // storage disabled for this origin
    }
    return true;
  }
  if (op === 'scroll' && !ref) {
    scrollTo(arg.x, arg.y);
    return true;
  }

  const el = find(ref);
  if (op === 'element') return el;
  if (!el) return null;
  const html = el as HTMLElement;
  switch (op) {
    case 'box': {
      const r0 = el.getBoundingClientRect();
      if (r0.top < 0 || r0.left < 0 || r0.bottom > innerHeight || r0.right > innerWidth) el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as ScrollBehavior });
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    }
    case 'focus':
      html.focus();
      return true;
    case 'isFocused':
      return document.activeElement === el;
    case 'setValue': {
      if (html.isContentEditable) {
        html.focus();
        document.execCommand('selectAll');
        document.execCommand('insertText', false, String(arg));
        return true;
      }
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if ((el as HTMLInputElement).value === String(arg)) return true;
      if (setter) setter.call(el, String(arg));
      else (el as HTMLInputElement).value = String(arg);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    case 'setChecked':
      if ((el as HTMLInputElement).checked !== !!arg) html.click();
      return true;
    case 'select': {
      const values = arg as string[];
      const current = Array.from((el as HTMLSelectElement).selectedOptions).map((o) => o.value);
      if (current.length === values.length && current.every((v) => values.includes(v))) return true;
      for (const option of Array.from((el as HTMLSelectElement).options)) option.selected = values.includes(option.value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    case 'scroll':
      el.scrollLeft = arg.x;
      el.scrollTop = arg.y;
      return true;
    case 'read':
      if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) return { checked: el.checked };
      if (el instanceof HTMLSelectElement) return { values: Array.from(el.selectedOptions).map((o) => o.value) };
      return { value: html.isContentEditable ? html.innerText : (el as HTMLInputElement).value };
    case 'syntheticClick': {
      // For frames the input pipeline cannot reach directly: dispatch the event sequence by hand.
      const r = el.getBoundingClientRect();
      const init = { bubbles: true, cancelable: true, composed: true, clientX: r.left + r.width * (arg?.fx ?? 0.5), clientY: r.top + r.height * (arg?.fy ?? 0.5), detail: arg?.clickCount ?? 1 };
      el.dispatchEvent(new PointerEvent('pointerdown', init));
      el.dispatchEvent(new MouseEvent('mousedown', init));
      html.focus?.();
      el.dispatchEvent(new PointerEvent('pointerup', init));
      el.dispatchEvent(new MouseEvent('mouseup', init));
      html.click();
      return true;
    }
  }
  return null;
}

/** Page address a copy loads (answered locally) to write an origin's IndexedDB before its pages run. */
export const SEED_PATH = '/__bettercodex_seed__';

/**
 * Reads ('dump') or writes ('restore') the IndexedDB databases of the page's origin. Runs inside
 * pages like the functions above. Values travel as JSON with their types tagged; records that
 * cannot be copied (Web Crypto keys, for one) are left out, and so are large databases. Restoring
 * resolves to true when every database of the dump was written.
 */
export async function indexedDbOp(op: 'dump' | 'restore', arg?: any): Promise<any> {
  const LIMIT = 2 * 1024 * 1024;
  const b64 = (buf: ArrayBuffer) => {
    const bytes = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

  if (op === 'dump') {
    if (!/^https?:$/.test(location.protocol) || !indexedDB.databases) return null;
    // Size of a value once encoded, counted before anything is read (blobs inside records too).
    const rough = (v: any, depth = 0): number => {
      if (v === null || v === undefined || typeof v === 'boolean' || typeof v === 'number' || typeof v === 'bigint') return 8;
      if (typeof v === 'string') return v.length + 2;
      if (v instanceof Blob) return Math.ceil(v.size * 1.4) + 32;
      if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) return Math.ceil(v.byteLength * 1.4) + 32;
      if (typeof v !== 'object' || depth > 40) return LIMIT + 1;
      let size = 16;
      const items: unknown[] = v instanceof Map ? [...v].flat() : v instanceof Set ? [...v] : Array.isArray(v) ? v : Object.entries(v).flat();
      for (const item of items) {
        size += rough(item, depth + 1);
        if (size > LIMIT) break;
      }
      return size;
    };
    const encode = async (v: any): Promise<any> => {
      if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
      if (typeof v === 'number') return Number.isFinite(v) ? v : { $: 'num', v: String(v) };
      if (v === undefined) return { $: 'undef' };
      if (typeof v === 'bigint') return { $: 'big', v: v.toString() };
      if (Array.isArray(v)) return { $: 'arr', v: await Promise.all(v.map(encode)) };
      if (v instanceof Date) return { $: 'date', v: v.getTime() };
      if (v instanceof ArrayBuffer) return { $: 'buf', v: b64(v) };
      if (ArrayBuffer.isView(v)) return { $: 'view', t: v.constructor.name, v: b64(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer) };
      if (v instanceof Blob) return { $: 'blob', type: v.type, name: v instanceof File ? v.name : undefined, v: b64(await v.arrayBuffer()) };
      if (v instanceof Map) return { $: 'map', v: await Promise.all([...v].map(async ([k, x]) => [await encode(k), await encode(x)])) };
      if (v instanceof Set) return { $: 'set', v: await Promise.all([...v].map(encode)) };
      if (v instanceof RegExp) return { $: 're', v: v.source, f: v.flags };
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) throw new Error('not copyable');
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) out[k] = await encode(x);
      return { $: 'obj', v: out };
    };
    const open = (name: string) =>
      new Promise<IDBDatabase | null>((resolve) => {
        const r = indexedDB.open(name);
        r.onsuccess = () => resolve(r.result);
        r.onerror = r.onblocked = () => resolve(null);
        // It does not exist (any more): do not create it.
        r.onupgradeneeded = () => r.transaction?.abort();
      });
    // Reads a store within the transaction (no other awaits there), giving up past the size limit.
    const read = (store: IDBObjectStore) =>
      new Promise<Array<[any, any]> | null>((resolve, reject) => {
        const rows: Array<[any, any]> = [];
        let size = 0;
        const r = store.openCursor();
        r.onerror = () => reject(r.error);
        r.onsuccess = () => {
          const cursor = r.result;
          if (!cursor) return resolve(rows);
          size += rough(cursor.value);
          if (size > LIMIT) return resolve(null);
          rows.push([cursor.primaryKey, cursor.value]);
          cursor.continue();
        };
      });
    const databases: any[] = [];
    let total = 0;
    for (const info of await indexedDB.databases()) {
      if (!info.name) continue;
      const db = await open(info.name);
      if (!db) continue;
      db.onversionchange = () => db.close();
      try {
        const names = Array.from(db.objectStoreNames);
        // Everything is read while the transaction is alive; encoding (blobs) comes after.
        const raw: Array<{ meta: Omit<IndexedDbDump['databases'][number]['stores'][number], 'rows'>; rows: Array<[any, any]> }> = [];
        if (names.length) {
          const tx = db.transaction(names, 'readonly');
          let tooBig = false;
          for (const name of names) {
            const store = tx.objectStore(name);
            const meta = {
              name: store.name,
              keyPath: store.keyPath,
              autoIncrement: store.autoIncrement,
              indexes: Array.from(store.indexNames).map((n) => {
                const index = store.index(n);
                return { name: index.name, keyPath: index.keyPath, unique: index.unique, multiEntry: index.multiEntry };
              }),
            };
            const rows = await read(store);
            if (!rows) {
              tooBig = true;
              break;
            }
            raw.push({ meta, rows });
          }
          if (tooBig) continue;
        }
        const stores = [];
        for (const { meta, rows } of raw) {
          const encoded: Array<[unknown, unknown]> = [];
          for (const [k, v] of rows) {
            try {
              encoded.push([await encode(k), await encode(v)]);
            } catch {
              // not copyable: left out
            }
          }
          stores.push({ ...meta, rows: encoded });
        }
        const dump = { name: db.name, version: db.version, stores };
        const size = JSON.stringify(dump).length;
        if (size > LIMIT || total + size > 2 * LIMIT) continue;
        total += size;
        databases.push(dump);
      } catch {
        // unreadable: left out
      } finally {
        db.close();
      }
    }
    return { origin: location.origin, databases };
  }

  // restore: replaces each database of the dump (others stay as they are)
  const decode = (v: any): any => {
    if (v === null || typeof v !== 'object') return v;
    switch (v.$) {
      case 'num':
        return Number(v.v);
      case 'undef':
        return undefined;
      case 'big':
        return BigInt(v.v);
      case 'arr':
        return v.v.map(decode);
      case 'date':
        return new Date(v.v);
      case 'buf':
        return unb64(v.v).buffer;
      case 'view': {
        const bytes = unb64(v.v);
        const Ctor = (globalThis as any)[v.t];
        return v.t === 'DataView' ? new DataView(bytes.buffer) : typeof Ctor === 'function' ? new Ctor(bytes.buffer) : bytes;
      }
      case 'blob':
        return v.name !== undefined ? new File([unb64(v.v)], v.name, { type: v.type }) : new Blob([unb64(v.v)], { type: v.type });
      case 'map':
        return new Map(v.v.map(([k, x]: [unknown, unknown]) => [decode(k), decode(x)]));
      case 'set':
        return new Set(v.v.map(decode));
      case 're':
        return new RegExp(v.v, v.f);
      case 'obj': {
        const out: Record<string, unknown> = {};
        for (const [k, x] of Object.entries(v.v)) out[k] = decode(x);
        return out;
      }
    }
    return v;
  };
  const settle = <T>(start: (resolve: (value: T) => void) => void, fallback: T) =>
    new Promise<T>((resolve) => {
      const timer = setTimeout(() => resolve(fallback), 3000);
      start((value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
  // Other copies of this origin may have a database open: it is never deleted (that would wait for
  // them, and run whenever they let go). Stores are written in place; a missing store needs a new
  // version, which is given up on (without harm) when others hold the database open.
  const open = (d: IndexedDbDump['databases'][number], version?: number) =>
    settle<IDBDatabase | null>((done) => {
      let late = false;
      const r = version === undefined ? indexedDB.open(d.name) : indexedDB.open(d.name, version);
      r.onupgradeneeded = () => {
        for (const s of d.stores) {
          if (r.result.objectStoreNames.contains(s.name)) continue;
          const store = r.result.createObjectStore(s.name, { keyPath: s.keyPath ?? undefined, autoIncrement: s.autoIncrement });
          for (const ix of s.indexes) store.createIndex(ix.name, ix.keyPath, { unique: ix.unique, multiEntry: ix.multiEntry });
        }
      };
      r.onsuccess = () => {
        r.result.onversionchange = () => r.result.close();
        if (late) r.result.close();
        else done(r.result);
      };
      r.onerror = () => done(null);
      setTimeout(() => (late = true), 2900);
    }, null);
  let complete = true;
  const existing = new Map((await indexedDB.databases()).map((info) => [info.name, info.version ?? 0]));
  for (const d of (arg?.databases ?? []) as IndexedDbDump['databases']) {
    const version = existing.get(d.name);
    let db = await open(d, version === undefined ? d.version : Math.max(version, d.version));
    if (db && d.stores.some((s) => !db!.objectStoreNames.contains(s.name))) {
      const current = db.version;
      db.close();
      db = await open(d, current + 1);
    }
    if (!db) {
      complete = false;
      continue;
    }
    const names = d.stores.map((s) => s.name).filter((n) => db!.objectStoreNames.contains(n));
    if (names.length < d.stores.length) complete = false;
    if (names.length) {
      const written = await settle<boolean>((done) => {
        const tx = db!.transaction(names, 'readwrite');
        tx.oncomplete = () => done(true);
        tx.onerror = tx.onabort = () => done(false);
        for (const s of d.stores) {
          if (!names.includes(s.name)) continue;
          const store = tx.objectStore(s.name);
          store.clear();
          for (const [k, v] of s.rows) {
            try {
              const put = s.keyPath != null ? store.put(decode(v)) : store.put(decode(v), decode(k));
              // One record that does not fit must not undo the others.
              put.onerror = (e) => e.preventDefault();
            } catch {
              // left out
            }
          }
        }
      }, false);
      if (!written) complete = false;
    }
    db.close();
  }
  return complete;
}
