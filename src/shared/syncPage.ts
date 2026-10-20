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
}

// ---- /sync websocket: JSON text frames ----

export type SyncClientMessage =
  | { t: 'subscribe'; tabId: string }
  | { t: 'unsubscribe'; tabId: string }
  | { t: 'action'; tabId: string; id: string; action: SyncAction }
  | { t: 'navigate'; tabId: string; action: 'back' | 'forward' | 'reload' };

export type SyncHostMessage =
  | { t: 'snapshot'; tabId: string; state: SyncState; cookies: SyncCookie[] }
  | { t: 'state'; tabId: string; state: SyncState; cookies?: { set: SyncCookie[]; removed: Array<Pick<SyncCookie, 'name' | 'domain' | 'path'>> } }
  | { t: 'action'; tabId: string; seq: number; action: SyncAction }
  | { t: 'ack'; tabId: string; id: string; seq: number; error?: string }
  | { t: 'gone'; tabId: string; error?: string };

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
 */
export function installSyncRecorder(emit: (json: string) => void, replica: boolean) {
  const w = window as any;
  if (w.__bettercodexRecorder) return;
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
        if (e.isTrusted) lastGesture = Date.now();
      },
      { capture: true, passive: true },
    );
  }

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

  const counts = (e: Event) => (replica ? e.isTrusted && Date.now() - lastGesture < 1500 : true);
  addEventListener(
    'input',
    (e) => {
      if (!counts(e) || !(e.target instanceof Element)) return;
      let el: Element = e.target;
      if ((el as HTMLElement).isContentEditable) el = editableRoot(el);
      else if (!isTextField(el) && !(el instanceof HTMLInputElement && el.type === 'range')) return;
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
