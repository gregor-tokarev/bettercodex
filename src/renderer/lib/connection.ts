import { WS_SUBPROTOCOL, type HostMessage } from '../../shared/types';
import { bc } from './bridge';

type Listener = (msg: HostMessage) => void;

export class RpcFailure extends Error {
  constructor(
    message: string,
    public code: number,
  ) {
    super(message);
  }
}

/** JSON-RPC-ish socket to one BetterCodex host (Codex app-server traffic plus browser events). */
export class HostConnection {
  ws: WebSocket | null = null;
  state: 'connecting' | 'open' | 'closed' = 'closed';
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private listeners = new Set<Listener>();
  private closeListeners = new Set<() => void>();
  private fileCache = new Map<string, Promise<string>>();

  constructor(
    readonly hostId: string,
    readonly port: number,
    readonly token: string,
  ) {}

  get streamUrl() {
    return `ws://127.0.0.1:${this.port}/stream`;
  }

  get protocols() {
    return [WS_SUBPROTOCOL, `auth.${this.token}`];
  }

  open(): Promise<void> {
    this.state = 'connecting';
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${this.port}/ws`, this.protocols);
      this.ws = ws;
      ws.onopen = () => {
        this.state = 'open';
        resolve();
      };
      ws.onerror = () => {
        if (this.state === 'connecting') reject(new Error('Could not connect to host'));
      };
      ws.onclose = () => {
        const wasOpen = this.state === 'open';
        this.state = 'closed';
        for (const [, p] of this.pending) p.reject(new Error('Connection to host lost'));
        this.pending.clear();
        if (wasOpen) for (const cb of this.closeListeners) cb();
      };
      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data as string) as HostMessage;
        if (msg.t === 'res') {
          const p = this.pending.get(msg.id);
          if (!p) return;
          this.pending.delete(msg.id);
          if (msg.error) p.reject(new RpcFailure(msg.error.message, msg.error.code));
          else p.resolve(msg.result);
          return;
        }
        for (const l of this.listeners) l(msg);
      };
    });
  }

  close() {
    this.closeListeners.clear();
    this.ws?.close();
  }

  onMessage(cb: Listener) {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  onClose(cb: () => void) {
    this.closeListeners.add(cb);
    return () => {
      this.closeListeners.delete(cb);
    };
  }

  rpc<T = any>(method: string, params?: unknown): Promise<T> {
    if (!this.ws || this.state !== 'open') return Promise.reject(new Error('Not connected to host'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws!.send(JSON.stringify({ t: 'rpc', id, method, params }));
    });
  }

  respond(id: string | number, result: unknown) {
    this.ws?.send(JSON.stringify({ t: 'reqres', id, result }));
  }

  respondError(id: string | number, message: string, code = -32601) {
    this.ws?.send(JSON.stringify({ t: 'reqres', id, error: { code, message } }));
  }

  /** Files on the host (screenshots, images) as blob URLs, fetched with the host token. */
  fileUrl(path: string): Promise<string> {
    let cached = this.fileCache.get(path);
    if (!cached) {
      // Fetched by the main process: the file:// renderer cannot send auth headers to the host.
      cached = bc.files.read(this.hostId, path).then(({ data, mime }) => URL.createObjectURL(new Blob([new Uint8Array(data)], { type: mime })));
      cached.catch(() => this.fileCache.delete(path));
      this.fileCache.set(path, cached);
    }
    return cached;
  }
}
