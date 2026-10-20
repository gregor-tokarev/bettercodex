// Runs in every frame of a synced copy of another machine's tab.
import { contextBridge, ipcRenderer } from 'electron';
import { installSyncRecorder } from '../shared/syncPage';

// The recorder lives in this isolated world: page scripts cannot see it or feed it fake actions.
installSyncRecorder((json) => ipcRenderer.send('bc:sync-record', json), true);

// What the page sends right after the person does something is the other machine's to send (it
// does the same there). This is said before the page itself sees the key or click, so even its
// very first reaction (an autosave, say) waits for the other machine's answer.
let marked = 0;
for (const type of ['pointerdown', 'keydown', 'beforeinput', 'input', 'change', 'paste', 'cut', 'drop', 'compositionend', 'submit']) {
  addEventListener(
    type,
    (e) => {
      if (!e.isTrusted || Date.now() - marked < 1000) return;
      marked = Date.now();
      ipcRenderer.sendSync('bc:replica-activity');
    },
    { capture: true, passive: true },
  );
}

// localStorage of the other machine is in place before the page's own scripts run.
const seed = ipcRenderer.sendSync('bc:replica-seed', location.origin) as Record<string, string> | null;
if (seed) {
  contextBridge.executeInMainWorld({
    func: (items: Record<string, string>) => {
      try {
        for (let i = localStorage.length - 1; i >= 0; i--) {
          const key = localStorage.key(i);
          if (key !== null && !(key in items)) localStorage.removeItem(key);
        }
        for (const [key, value] of Object.entries(items)) if (localStorage.getItem(key) !== value) localStorage.setItem(key, value);
      } catch {
        // storage disabled for this origin
      }
    },
    args: [seed],
  });
}

// Dialogs show on the other machine when the same action arrives there; the copy's page waits for
// the answer given there (alerts need none).
contextBridge.executeInMainWorld({
  func: (ask: (type: string, message: string) => unknown) => {
    const define = (name: string, fn: unknown) => Object.defineProperty(window, name, { value: fn, writable: true, configurable: true });
    define('alert', function alert() {});
    define('confirm', function confirm(message?: unknown) {
      return ask('confirm', message === undefined ? '' : String(message)) === true;
    });
    define('prompt', function prompt(message?: unknown) {
      const answer = ask('prompt', message === undefined ? '' : String(message));
      return typeof answer === 'string' ? answer : null;
    });
  },
  args: [(type: string, message: string) => ipcRenderer.sendSync('bc:replica-dialog', { type, message })],
});

// The copy never connects to sites' WebSocket servers (what it would send there is the other
// machine's to send). Its page gets a stand-in that receives what the other machine's page does.
const sockets = new Map<number, (event: unknown) => void>();
let lastSocket = 0;
ipcRenderer.on('bc:replica-socket', (_e, msg: { sid: number; event: string }) => {
  const listener = sockets.get(msg.sid);
  if (msg.event === 'close') sockets.delete(msg.sid);
  listener?.(msg);
});
contextBridge.executeInMainWorld({
  func: (connect: (url: string, listener: (event: any) => void) => number, disconnect: (sid: number) => void) => {
    class WebSocket extends EventTarget {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      readonly CONNECTING = 0;
      readonly OPEN = 1;
      readonly CLOSING = 2;
      readonly CLOSED = 3;
      readonly url: string;
      readyState = 0;
      protocol = '';
      extensions = '';
      bufferedAmount = 0;
      binaryType: BinaryType = 'blob';
      onopen: ((e: Event) => unknown) | null = null;
      onmessage: ((e: MessageEvent) => unknown) | null = null;
      onerror: ((e: Event) => unknown) | null = null;
      onclose: ((e: CloseEvent) => unknown) | null = null;
      private sid: number;

      constructor(url: string | URL, _protocols?: string | string[]) {
        super();
        const u = new URL(String(url), location.href);
        if (u.protocol === 'http:') u.protocol = 'ws:';
        else if (u.protocol === 'https:') u.protocol = 'wss:';
        if (u.protocol !== 'ws:' && u.protocol !== 'wss:') throw new DOMException(`The URL's scheme must be either 'ws' or 'wss'.`, 'SyntaxError');
        this.url = u.href;
        for (const type of ['open', 'message', 'error', 'close']) this.addEventListener(type, (e) => (this as any)[`on${type}`]?.call(this, e));
        this.sid = connect(this.url, (e) => this.receive(e));
      }

      private receive(e: { event: string; data?: string; binary?: boolean }) {
        if (this.readyState >= 2) return;
        if (e.event === 'open') {
          this.readyState = 1;
          this.dispatchEvent(new Event('open'));
        } else if (e.event === 'message' && this.readyState === 1) {
          let data: unknown = e.data;
          if (e.binary) {
            const bytes = Uint8Array.from(atob(e.data ?? ''), (c) => c.charCodeAt(0));
            data = this.binaryType === 'arraybuffer' ? bytes.buffer : new Blob([bytes]);
          }
          this.dispatchEvent(new MessageEvent('message', { data, origin: new URL(this.url).origin }));
        } else if (e.event === 'close') {
          const opened = this.readyState === 1;
          this.readyState = 3;
          if (!opened) this.dispatchEvent(new Event('error'));
          this.dispatchEvent(new CloseEvent('close', { code: 1006, reason: '', wasClean: false }));
        }
      }

      send(_data: unknown) {
        if (this.readyState === 0) throw new DOMException("Failed to execute 'send' on 'WebSocket': Still in CONNECTING state.", 'InvalidStateError');
        // The page on the other machine sends; this one only listens.
      }

      close(code?: number, reason?: string) {
        if (this.readyState >= 2) return;
        this.readyState = 2;
        disconnect(this.sid);
        setTimeout(() => {
          this.readyState = 3;
          this.dispatchEvent(new CloseEvent('close', { code: code ?? 1005, reason: reason ?? '', wasClean: true }));
        });
      }
    }
    Object.defineProperty(window, 'WebSocket', { value: WebSocket, writable: true, configurable: true });
  },
  args: [
    (url: string, listener: (event: unknown) => void) => {
      const sid = ++lastSocket;
      sockets.set(sid, listener);
      ipcRenderer.send('bc:replica-socket', { op: 'open', sid, url });
      return sid;
    },
    (sid: number) => {
      sockets.delete(sid);
      ipcRenderer.send('bc:replica-socket', { op: 'close', sid });
    },
  ],
});
