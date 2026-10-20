import { ipcMain, session, WebContentsView, type BrowserWindow, type IpcMainEvent, type Session, type WebContents, type WebFrameMain } from 'electron';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { WS_SUBPROTOCOL } from '../shared/types.js';
import {
  ACTION_WINDOW_MS,
  echoKey,
  indexedDbOp,
  onlyReachableThere,
  requestIdentity,
  sameDocument,
  SEED_PATH,
  SOCKET_HANDSHAKE_BYTES,
  SOCKET_HANDSHAKE_FRAMES,
  syncPageOp,
  type FrameRef,
  type IndexedDbDump,
  type Modifier,
  type RequestIdentity,
  type SocketFrame,
  type SyncAction,
  type SyncClientMessage,
  type SyncCookie,
  type SyncField,
  type SyncHostMessage,
  type SyncRequest,
  type SyncResponse,
  type SyncState,
} from '../shared/syncPage.js';
import type { HostManager } from './hosts.js';
import { handlePageKeys, showPageMenu, type PageNavigation } from './pageChrome.js';
import { ViewStage, type Rect } from './stage.js';

const PAGE_OP = syncPageOp.toString();
const IDB_OP = indexedDbOp.toString();
const debug = process.env.BETTERCODEX_DEBUG ? (...args: unknown[]) => console.log('[sync]', ...args) : () => {};
/** Copies kept around (hidden) so switching back to a tab is instant. */
const MAX_REPLICAS = 8;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
/** While the person types or scrolls in a copy, the other machine's state does not overwrite it. */
const QUIET_MS = 1500;
/** How long a copy's request waits for the owner to make the same request before it fails. */
const ANSWER_WAIT_MS = 30000;
/** Once the owner made it, the copy waits while the owner receives the answer (it may stream). */
const RESPONSE_WAIT_MS = 10 * 60 * 1000;
/** Requests matched by address alone wait this long for the owner's requests to come in first. */
const KEY_MATCH_DELAY_MS = 1500;
/** Answers nobody here asked for are kept this long, and up to this much in all. */
const ANSWER_KEEP_MS = 30000;
const ANSWER_KEEP_BYTES = 32 * 1024 * 1024;
/** A dialog in a copy waits this long for the same dialog to open on the owner. */
const DIALOG_WAIT_MS = 10000;
/** A copy's WebSocket waits this long for the owner's page to open the same one. */
const SOCKET_WAIT_MS = 30000;
/** A site this machine could not reach is shown live (streamed) for this long, then tried again. */
const UNREACHABLE_MS = 5 * 60 * 1000;
/** Load errors meaning the site is reachable from the owning machine only (its DNS, VPN or CA). */
const UNREACHABLE_ERRORS = new Set([-102, -104, -105, -109, -118, -130, -137, -138]);

export type ReplicaStatus = 'connecting' | 'loading' | 'synced' | 'syncing' | 'offline' | 'gone';

/** A request of the owner's page whose answer goes to the copies (see SyncRequest). */
interface OwnerRequest extends SyncRequest {
  at: number;
  answer: SyncResponse | null;
  answeredAt: number;
  claimed: boolean;
}

/** A request of this copy held until the owner's answer to the same request is there. */
interface HeldRequest extends RequestIdentity {
  requestId: string;
  sessionId?: string;
  at: number;
  /** A page load: without the owner's answer it loads from the site as usual. */
  doc: boolean;
  owner: OwnerRequest | null;
  timer: NodeJS.Timeout;
}

interface OwnerSocket {
  url: string;
  /** Of the document that opened it; only a frame of this origin in the copy gets its messages. */
  origin: string;
  frames: SocketFrame[];
  bytes: number;
  copy: CopySocket | null;
}

/** A WebSocket the copy's page opened; it gets what the owner's matching socket receives. */
interface CopySocket {
  sid: number;
  frame: WebFrameMain;
  origin: string;
  owner: OwnerSocket | null;
  url: string;
  timer: NodeJS.Timeout | null;
}

/** Dialogs are told apart by kind, text and the origin of the frame showing them. */
interface DialogKey {
  type: string;
  message: string;
  origin: string;
}

interface DialogWait extends DialogKey {
  event: IpcMainEvent;
  timer: NodeJS.Timeout;
}

interface Replica {
  hostId: string;
  tabId: string;
  view: WebContentsView;
  wc: WebContents;
  wcId: number;
  size: { width: number; height: number };
  status: ReplicaStatus;
  error: string | null;
  /** Highest action number of the owning machine already reflected here. */
  seq: number;
  /** The owner's navigation counter this copy has caught up with. */
  nav: number;
  /** Own actions sent to the owner and not yet confirmed. */
  pending: Map<string, SyncAction>;
  lastAckSeq: number;
  loading: boolean;
  /** Set while this copy loads a page because of the owner, not because of a click here. */
  expectNavigation: boolean;
  navigatedSinceState: boolean;
  /** The last page loaded to follow the owner; a redirect elsewhere is accepted, not retried. */
  lastTarget: { url: string; nav: number } | null;
  /** The owner's scroll position last time; the copy only follows when the owner scrolls. */
  ownerScroll: string | null;
  /** The owner changed data on the site; the copy refetches the page once that is possible. */
  needsRefresh: boolean;
  refreshTimer: NodeJS.Timeout | null;
  /** The newest state, applied again once the person stops typing or own actions are confirmed. */
  lastState: SyncState | null;
  reconcileTimer: NodeJS.Timeout | null;
  replays: Array<{ key: string; at: number }>;
  /** The owning machine is this one too, so its localhost pages load here as well. */
  sameMachine: boolean;
  lastLocalInput: number;
  lastShown: number;
  /** Snapshots, states and actions from the owner are applied one after another, in order. */
  work: Promise<void>;
  /** Last action here or replayed from the owner; data sent soon after it is the owner's to send. */
  lastActionAt: number;
  /** Requests of the owner whose answers this copy may use, and this copy's requests waiting for them. */
  owned: Map<string, OwnerRequest>;
  held: HeldRequest[];
  /** When the copy last got one of the owner's answers (its page then saw the same result). */
  lastAnsweredAt: number;
  snapshotted: boolean;
  /** The owner's page URL, as of the last snapshot or state. */
  ownerUrl: string;
  ownerSockets: Map<string, OwnerSocket>;
  copySockets: Map<string, CopySocket>;
  /** Dialogs of the copy's page waiting for the owner's answer, the owner's open dialogs, and answers that came first. */
  dialogWaits: DialogWait[];
  ownerDialogs: DialogKey[];
  dialogAnswers: Array<DialogKey & { accept: boolean; value: string | null; at: number }>;
  /** While the owner's field values are put into the copy's page; what the page sends then is held. */
  restoringUntil: number;
}

/** One sync connection per machine. */
class HostLink {
  ws: WebSocket | null = null;
  readonly replicas = new Map<string, Replica>();
  private retry: NodeJS.Timeout | null = null;
  private connectedTo = '';

  constructor(
    private manager: ReplicaManager,
    readonly hostId: string,
    private endpoint: () => { port: number; token: string } | null,
  ) {}

  connect() {
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return;
    const endpoint = this.endpoint();
    if (!endpoint) return this.later();
    this.connectedTo = `${endpoint.port}:${endpoint.token}`;
    const ws = new WebSocket(`ws://127.0.0.1:${endpoint.port}/sync`, [WS_SUBPROTOCOL, `auth.${endpoint.token}`], { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
    this.ws = ws;
    ws.on('open', () => {
      for (const replica of this.replicas.values()) this.manager.subscribe(replica);
    });
    ws.on('message', (data) => {
      try {
        this.manager.onHostMessage(this.hostId, JSON.parse(data.toString()) as SyncHostMessage);
      } catch (err) {
        console.error('sync message failed', err);
      }
    });
    ws.on('close', () => {
      if (this.ws !== ws) return;
      this.ws = null;
      for (const replica of this.replicas.values()) this.manager.setStatus(replica, 'offline');
      this.later();
    });
    ws.on('error', () => ws.close());
  }

  /** The machine was reconnected: start over if it is reached somewhere else now (new tunnel). */
  reconnect() {
    const endpoint = this.endpoint();
    if (this.ws && endpoint && `${endpoint.port}:${endpoint.token}` === this.connectedTo) return;
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    if (this.replicas.size) this.connect();
  }

  private later() {
    if (!this.retry && this.replicas.size) this.retry = setTimeout(() => this.connect(), 2000);
  }

  send(msg: SyncClientMessage) {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      this.connect();
      return false;
    }
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  close() {
    if (this.retry) clearTimeout(this.retry);
    this.ws?.close();
    this.ws = null;
  }
}

/**
 * Copies of tabs that live on other machines, rendered by this app like its own tabs. Nothing is
 * streamed: what the person does in a copy is sent to the owning machine as actions and replayed
 * there; what happens on the owner (the agent, or someone at that machine) comes back the same
 * way, and the owner's state (URL, fields, scroll, cookies, localStorage) settles any difference.
 * Copies never send data to sites (no POST, no WebSocket): the owner does that when it replays.
 */
export class ReplicaManager extends EventEmitter {
  private links = new Map<string, HostLink>();
  private replicas = new Map<string, Replica>();
  private byContents = new Map<number, Replica>();
  private sessions = new Set<string>();
  /** localStorage of the owning machine, per machine and origin. */
  private storage = new Map<string, Map<string, Record<string, string>>>();
  /** Cookie updates of one machine are applied in the order they were sent (all its copies share them). */
  private cookieWork = new Map<string, Promise<void>>();
  /** IndexedDB of the owning machine per machine and origin, and what was last written here. */
  private indexedDB = new Map<string, Map<string, { dump: IndexedDbDump; json: string }>>();
  private indexedDBApplied = new Map<string, Map<string, string>>();
  /** Sites a machine's copies could not load, per machine and origin (until when they are streamed). */
  private unreachableOrigins = new Map<string, Map<string, number>>();

  constructor(
    private stage: ViewStage,
    private hosts: HostManager,
    private preloadPath: string,
    private uiWindow: () => BrowserWindow | null,
  ) {
    super();
    ipcMain.on('bc:sync-record', (event, json: string) => this.onRecorded(event, json));
    // The person just did something in the copy: what the page sends right after is the owner's to send.
    ipcMain.on('bc:replica-activity', (event) => {
      const replica = this.byContents.get(event.sender.id);
      if (replica) replica.lastActionAt = Date.now();
      event.returnValue = true;
    });
    ipcMain.on('bc:replica-dialog', (event, d: { type: string; message: string }) => this.onDialog(event, d));
    ipcMain.on('bc:replica-socket', (event, msg: { op: 'open'; sid: number; url: string } | { op: 'close'; sid: number }) => this.onCopySocket(event, msg));
    setInterval(() => {
      for (const replica of this.replicas.values()) this.trimAnswers(replica);
    }, 5000).unref();
    ipcMain.on('bc:replica-seed', (event, origin: string) => {
      const replica = this.byContents.get(event.sender.id);
      event.returnValue = (replica && this.storage.get(replica.hostId)?.get(origin)) ?? null;
    });
    hosts.on('status', (status: { id: string; state: string }) => {
      if (status.state === 'connected') this.links.get(status.id)?.reconnect();
    });
  }

  // ---------- views ----------

  show(win: BrowserWindow, hostId: string, tabId: string, bounds: Rect | null, sameMachine = false) {
    if (!bounds) {
      const replica = this.replicas.get(key(hostId, tabId));
      return replica ? this.stage.show(win, replica, null) : false;
    }
    const replica = this.ensure(hostId, tabId);
    replica.sameMachine = sameMachine;
    replica.lastShown = Date.now();
    return this.stage.show(win, replica, bounds);
  }

  async capture(hostId: string, tabId: string) {
    const replica = this.replicas.get(key(hostId, tabId));
    if (!replica || replica.wc.isDestroyed()) return null;
    const image = await replica.wc.capturePage(undefined, { stayHidden: true, stayAwake: true });
    return image.isEmpty() ? null : image.toDataURL();
  }

  /** Brings back a copy whose tab went to sleep on its machine. */
  reload(hostId: string, tabId: string) {
    const replica = this.replicas.get(key(hostId, tabId));
    if (replica) this.subscribe(replica);
  }

  statusOf(hostId: string, tabId: string) {
    const replica = this.replicas.get(key(hostId, tabId));
    return replica ? { status: replica.status, error: replica.error, pending: replica.pending.size, unreachable: this.ownerUnreachable(replica) } : null;
  }

  private ensure(hostId: string, tabId: string) {
    const existing = this.replicas.get(key(hostId, tabId));
    if (existing) {
      if (existing.status === 'gone') this.subscribe(existing);
      return existing;
    }
    const view = new WebContentsView({
      webPreferences: {
        session: this.session(hostId),
        preload: this.preloadPath,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: true,
        backgroundThrottling: false,
        plugins: true,
        spellcheck: true,
      },
    });
    view.setBackgroundColor('#ffffff');
    const replica: Replica = {
      hostId,
      tabId,
      view,
      wc: view.webContents,
      wcId: view.webContents.id,
      size: ViewStage.defaultSize(),
      status: 'connecting',
      error: null,
      seq: 0,
      nav: 0,
      pending: new Map(),
      lastAckSeq: 0,
      loading: false,
      expectNavigation: false,
      navigatedSinceState: false,
      lastTarget: null,
      ownerScroll: null,
      needsRefresh: false,
      refreshTimer: null,
      lastState: null,
      reconcileTimer: null,
      replays: [],
      sameMachine: false,
      lastLocalInput: 0,
      lastShown: Date.now(),
      work: Promise.resolve(),
      lastActionAt: 0,
      owned: new Map(),
      held: [],
      lastAnsweredAt: 0,
      snapshotted: false,
      ownerUrl: '',
      ownerSockets: new Map(),
      copySockets: new Map(),
      dialogWaits: [],
      ownerDialogs: [],
      dialogAnswers: [],
      restoringUntil: 0,
    };
    this.replicas.set(key(hostId, tabId), replica);
    this.byContents.set(replica.wcId, replica);
    this.stage.add(replica);
    this.wire(replica);
    this.intercept(replica);
    const link = this.link(hostId);
    link.replicas.set(tabId, replica);
    this.subscribe(replica);
    this.evict();
    return replica;
  }

  private link(hostId: string) {
    let link = this.links.get(hostId);
    if (!link) {
      link = new HostLink(this, hostId, () => this.hosts.status(hostId).endpoint);
      this.links.set(hostId, link);
    }
    return link;
  }

  subscribe(replica: Replica) {
    replica.snapshotted = false;
    replica.pending.clear();
    this.setStatus(replica, 'connecting');
    this.link(replica.hostId).send({ t: 'subscribe', tabId: replica.tabId });
  }

  private evict() {
    if (this.replicas.size <= MAX_REPLICAS) return;
    const idle = [...this.replicas.values()].filter((r) => !this.stage.isShown(r)).sort((a, b) => a.lastShown - b.lastShown);
    for (const replica of idle.slice(0, this.replicas.size - MAX_REPLICAS)) this.destroy(replica);
  }

  private destroy(replica: Replica) {
    this.replicas.delete(key(replica.hostId, replica.tabId));
    this.byContents.delete(replica.wcId);
    this.stage.remove(replica);
    const link = this.links.get(replica.hostId);
    link?.replicas.delete(replica.tabId);
    link?.send({ t: 'unsubscribe', tabId: replica.tabId });
    if (link && link.replicas.size === 0) {
      link.close();
      this.links.delete(replica.hostId);
    }
    if (replica.refreshTimer) clearTimeout(replica.refreshTimer);
    if (replica.reconcileTimer) clearTimeout(replica.reconcileTimer);
    this.letGo(replica);
    if (!replica.wc.isDestroyed()) replica.wc.close();
  }

  /** One profile per machine: its cookies are the owning machine's, kept apart from this one's. */
  private session(hostId: string): Session {
    const partition = `persist:replica-${hostId.replace(/[^\w-]/g, '_')}`;
    const ses = session.fromPartition(partition);
    if (this.sessions.has(partition)) return ses;
    this.sessions.add(partition);
    ses.setUserAgent(ses.getUserAgent().replace(/\s(Electron|BetterCodex|bettercodex)\/\S+/g, ''));
    // Pages load like anywhere else (many read through POST APIs). Data sent right after an action
    // is answered by the owner (see intercept); sockets, top-level form posts and frames posted to
    // right after an action only ever run on the owner (the copy's pages get the owner's sockets
    // relayed instead, see onCopySocket). Frames a page posts to on its own while loading (embedded
    // apps that sign in that way) load like its other requests.
    ses.webRequest.onBeforeRequest((details, callback) => {
      const socket = details.resourceType === 'webSocket' || /^wss?:/i.test(details.url);
      const replica = details.webContentsId === undefined ? undefined : this.byContents.get(details.webContentsId);
      const afterAction = !replica || Date.now() - replica.lastActionAt <= ACTION_WINDOW_MS;
      const formPost = !SAFE_METHODS.has(details.method) && (details.resourceType === 'mainFrame' || (details.resourceType === 'subFrame' && afterAction));
      if (formPost) debug('form post left to the owner', details.resourceType, details.url);
      callback({ cancel: socket || formPost });
    });
    ses.on('will-download', (_event, item) => item.cancel());
    ses.setPermissionRequestHandler((_wc, permission, callback) => callback(permission === 'clipboard-sanitized-write' || permission === 'fullscreen'));
    ses.setPermissionCheckHandler((_wc, permission) => permission === 'clipboard-sanitized-write' || permission === 'fullscreen');
    return ses;
  }

  private navigation(replica: Replica): PageNavigation {
    const send = (action: 'back' | 'forward' | 'reload') => this.link(replica.hostId).send({ t: 'navigate', tabId: replica.tabId, action });
    return {
      back: () => send('back'),
      forward: () => send('forward'),
      reload: () => send('reload'),
      canGoBack: () => true,
      canGoForward: () => true,
    };
  }

  private wire(replica: Replica) {
    const wc = replica.wc;
    const nav = this.navigation(replica);
    // New windows open on the owning machine (the same click arrives there) and show up as tabs.
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('will-prevent-unload', (event) => event.preventDefault());
    wc.on('context-menu', (_e, params) => showPageMenu(wc, params, this.uiWindow(), nav, { newTab: false }));
    wc.on('before-input-event', (event, input) => handlePageKeys(event, input, this.uiWindow(), nav));
    wc.on('did-start-loading', () => {
      replica.loading = true;
    });
    wc.on('did-stop-loading', () => {
      replica.loading = false;
      if (replica.snapshotted && replica.pending.size === 0 && replica.status === 'loading') this.setStatus(replica, 'synced');
    });
    wc.on('did-navigate', () => {
      if (replica.expectNavigation) replica.expectNavigation = false;
      else replica.navigatedSinceState = true;
      // The page's sockets went with it.
      for (const [id, copy] of replica.copySockets) this.dropCopySocket(replica, id, copy, false);
    });
    wc.on('did-frame-navigate', (_e, _url, _code, _status, isMainFrame, processId, routingId) => {
      if (isMainFrame) return;
      for (const [id, copy] of replica.copySockets) if (id.startsWith(`${processId}:${routingId}:`)) this.dropCopySocket(replica, id, copy, false);
    });
    // A site only the owning machine reaches (its DNS, VPN or certificates): show that tab live.
    wc.on('did-fail-load', (_e, code, _description, url, isMainFrame) => {
      if (!isMainFrame || replica.sameMachine || (!UNREACHABLE_ERRORS.has(code) && !(code <= -200 && code > -300))) return;
      const origin = originOf(url);
      if (!origin || origin === 'null') return;
      let origins = this.unreachableOrigins.get(replica.hostId);
      if (!origins) this.unreachableOrigins.set(replica.hostId, (origins = new Map()));
      origins.set(origin, Date.now() + UNREACHABLE_MS);
      debug('not reachable from here, shown live:', origin, code);
      for (const r of this.replicas.values()) if (r.hostId === replica.hostId) this.setStatus(r, r.status, r.error);
    });
    wc.once('destroyed', () => {
      if (this.replicas.get(key(replica.hostId, replica.tabId)) === replica) this.destroy(replica);
    });
  }

  setStatus(replica: Replica, status: ReplicaStatus, error: string | null = null) {
    replica.status = status;
    replica.error = error;
    this.emit('status', { hostId: replica.hostId, tabId: replica.tabId, status, error, pending: replica.pending.size, unreachable: this.ownerUnreachable(replica) });
  }

  // ---------- this copy → owner ----------

  private onRecorded(event: IpcMainEvent, json: string) {
    const replica = this.byContents.get(event.sender.id);
    if (!replica || replica.status === 'gone' || !replica.snapshotted) return;
    let action: SyncAction;
    try {
      // The frame is taken from where the event came from, never from the page.
      const frame = event.senderFrame;
      const frameRef: FrameRef | null = !frame || !frame.parent ? null : { url: frame.url, name: frame.name };
      action = { ...JSON.parse(json), frame: frameRef };
    } catch {
      return;
    }
    const now = Date.now();
    replica.replays = replica.replays.filter((r) => now - r.at < 2500);
    const echo = replica.replays.findIndex((r) => r.key === echoKey(action));
    if (echo >= 0) {
      replica.replays.splice(echo, 1);
      return;
    }
    replica.lastLocalInput = now;
    replica.lastActionAt = now;
    const id = crypto.randomUUID();
    replica.pending.set(id, action);
    if (this.link(replica.hostId).send({ t: 'action', tabId: replica.tabId, id, action })) this.setStatus(replica, 'syncing');
    else {
      replica.pending.delete(id);
      this.setStatus(replica, 'offline');
    }
  }

  // ---------- owner → this copy ----------

  /** Owner messages that change the page are applied strictly in the order they arrived. */
  private enqueue(replica: Replica, job: () => Promise<void>) {
    replica.work = replica.work.then(job).catch((err) => debug('sync step failed', err));
  }

  onHostMessage(hostId: string, msg: SyncHostMessage) {
    const replica = this.replicas.get(key(hostId, msg.tabId));
    debug('message', msg.t, msg.tabId, 'seq' in msg ? msg.seq : '', replica ? `(replica seq ${replica.seq})` : '(no replica)');
    if (!replica) return;
    switch (msg.t) {
      case 'snapshot':
        // A new subscription numbers actions, requests and sockets from scratch.
        replica.seq = msg.state.seq;
        replica.lastAckSeq = msg.state.seq;
        this.letGo(replica);
        for (const socket of msg.sockets ?? []) replica.ownerSockets.set(socket.id, { url: socket.url, origin: socket.origin, frames: socket.frames, bytes: 0, copy: null });
        this.enqueue(replica, () => this.applySnapshot(replica, msg.state, msg.cookies));
        return;
      case 'state':
        this.enqueue(replica, async () => {
          await this.applyCookies(replica, msg.cookies?.set ?? [], msg.cookies?.removed ?? [], false);
          await this.applyState(replica, msg.state);
        });
        return;
      case 'action':
        if (msg.seq <= replica.seq) return;
        replica.seq = msg.seq;
        this.enqueue(replica, () => this.replay(replica, msg.action));
        return;
      case 'ack':
        if (msg.error) debug('the owner could not replay an action:', msg.error);
        replica.pending.delete(msg.id);
        replica.lastAckSeq = Math.max(replica.lastAckSeq, msg.seq);
        replica.seq = Math.max(replica.seq, msg.seq);
        if (replica.pending.size === 0 && !replica.loading) this.setStatus(replica, msg.error ? 'syncing' : 'synced');
        return;
      case 'gone':
        this.letGo(replica);
        this.setStatus(replica, 'gone', msg.error ?? null);
        if (msg.error === 'The tab was closed') this.destroy(replica);
        return;
      case 'request': {
        const { t: _t, tabId: _tab, ...request } = msg;
        replica.owned.set(request.id, { ...request, at: Date.now(), answer: null, answeredAt: 0, claimed: false });
        this.match(replica);
        return;
      }
      case 'response': {
        const { t: _t, tabId: _tab, ...answer } = msg;
        this.onAnswer(replica, answer);
        return;
      }
      case 'dialog':
        this.onOwnerDialog(replica, msg);
        return;
      case 'socket':
        this.onOwnerSocket(replica, msg);
        return;
    }
  }

  /** Lets go of everything tied to the owner's current page session (its numbering restarts). */
  private letGo(replica: Replica) {
    for (const held of [...replica.held]) if (held.owner) this.release(replica, held);
    replica.owned.clear();
    for (const [id, copy] of replica.copySockets) this.dropCopySocket(replica, id, copy, true);
    replica.ownerSockets.clear();
    for (const wait of [...replica.dialogWaits]) this.answerDialog(replica, wait, false, null);
    replica.ownerDialogs = [];
    replica.dialogAnswers = [];
  }

  // ---------- requests that send data ----------

  /**
   * The copy's XHR/fetch requests and page loads pass through here (all frames). Requests that send
   * data right after an action are held: the owner sends them when it replays the action, and its
   * answer to the same request is given to the copy. A page the owner got by posting a form is
   * shown as the owner got it. Everything else goes to the network as usual.
   */
  private intercept(replica: Replica) {
    const dbg = replica.wc.debugger;
    try {
      dbg.attach('1.3');
    } catch {
      return;
    }
    const patterns = [
      { resourceType: 'XHR', requestStage: 'Request' },
      { resourceType: 'Fetch', requestStage: 'Request' },
      { resourceType: 'Document', requestStage: 'Request' },
    ];
    const send = (method: string, params: object, sessionId?: string) => dbg.sendCommand(method, params, sessionId).catch(() => {});
    dbg.on('message', (_event, method, params, sessionId) => {
      if (method === 'Fetch.requestPaused') this.onRequest(replica, params, sessionId || undefined);
      // Frames of other sites run in their own processes: intercept there too.
      else if (method === 'Target.attachedToTarget') void send('Fetch.enable', { patterns }, params.sessionId);
    });
    void send('Fetch.enable', { patterns });
    // Such frames are not held until then: Electron never lets a frame held for the debugger go on,
    // so it would never load (and neither would its page). Their navigations, form posts included,
    // are intercepted here anyway.
    void send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  }

  private onRequest(replica: Replica, params: { requestId: string; resourceType: string; request: PausedRequest }, sessionId?: string) {
    const dbg = replica.wc.debugger;
    const { requestId, request } = params;
    const proceed = () => void dbg.sendCommand('Fetch.continueRequest', { requestId }, sessionId).catch(() => {});
    if (params.resourceType === 'Document') {
      if (pathOf(request.url) === SEED_PATH) {
        const body = Buffer.from('<!doctype html><title></title>').toString('base64');
        void dbg.sendCommand('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/html' }], body }, sessionId).catch(() => {});
        return;
      }
      const owner = request.method === 'GET' ? [...replica.owned.values()].find((o) => o.doc && !o.claimed && sameDocument(o.doc, request.url)) : undefined;
      if (!owner) return proceed();
      this.hold(replica, { requestId, sessionId, key: owner.key, exact: null, loose: '', doc: true }, owner);
      return;
    }
    if (SAFE_METHODS.has(request.method) || Date.now() - replica.lastActionAt > ACTION_WINDOW_MS) return proceed();
    debug('waiting for the owner to answer', request.method, request.url);
    this.hold(replica, { requestId, sessionId, ...requestIdentity(request.method, request.url, bodyOf(request)), doc: false }, null);
  }

  private hold(replica: Replica, request: Omit<HeldRequest, 'at' | 'owner' | 'timer'>, owner: OwnerRequest | null) {
    // What the page sends because the owner's values were put into it has no counterpart there.
    const wait = Date.now() < replica.restoringUntil ? KEY_MATCH_DELAY_MS * 2 : ANSWER_WAIT_MS;
    const held: HeldRequest = { ...request, at: Date.now(), owner: null, timer: setTimeout(() => this.release(replica, held), wait) };
    replica.held.push(held);
    if (owner) return this.bind(replica, held, owner);
    this.match(replica);
    // Matching by address alone waits a moment for the owner's requests to come in.
    if (!held.owner) setTimeout(() => this.match(replica), KEY_MATCH_DELAY_MS + 100);
  }

  /**
   * Pairs this copy's held requests with the owner's: the same address and data, or the same apart
   * from numbers and tokens. What is left is paired by address in order, once both sides had time
   * to make their requests and only when their numbers agree.
   */
  private match(replica: Replica) {
    const free = (key: string) => [...replica.owned.values()].filter((o) => !o.claimed && !o.doc && o.key === key);
    for (const held of replica.held) {
      if (held.owner || held.doc) continue;
      const candidates = free(held.key);
      const owner = (held.exact && candidates.find((o) => o.exact === held.exact)) || candidates.find((o) => o.loose === held.loose);
      if (owner) this.bind(replica, held, owner);
    }
    const now = Date.now();
    const left = replica.held.filter((h) => !h.owner && !h.doc);
    for (const key of new Set(left.map((h) => h.key))) {
      const mine = left.filter((h) => h.key === key);
      const theirs = free(key);
      if (mine.length !== theirs.length || mine.some((h) => now - h.at < KEY_MATCH_DELAY_MS)) continue;
      mine.forEach((held, i) => this.bind(replica, held, theirs[i]));
    }
  }

  private bind(replica: Replica, held: HeldRequest, owner: OwnerRequest) {
    owner.claimed = true;
    held.owner = owner;
    clearTimeout(held.timer);
    if (owner.answer) return this.fulfill(replica, held, owner.answer);
    // The owner is still receiving it (a streamed response, maybe): keep waiting while it does.
    held.timer = setTimeout(() => this.release(replica, held), RESPONSE_WAIT_MS);
  }

  private onAnswer(replica: Replica, answer: SyncResponse) {
    const owner = replica.owned.get(answer.id);
    if (!owner) return;
    owner.answer = answer;
    owner.answeredAt = Date.now();
    const held = replica.held.find((h) => h.owner === owner);
    if (held) this.fulfill(replica, held, answer);
    else this.trimAnswers(replica);
  }

  /** Answers nobody here asked for are dropped after a while, and the oldest when they add up. */
  private trimAnswers(replica: Replica) {
    const now = Date.now();
    let bytes = 0;
    for (const owner of [...replica.owned.values()].reverse()) {
      if (owner.claimed) continue;
      bytes += owner.answer?.body.length ?? 0;
      const stale = owner.answer ? now - owner.answeredAt > ANSWER_KEEP_MS : now - owner.at > RESPONSE_WAIT_MS;
      if (stale || bytes > ANSWER_KEEP_BYTES) replica.owned.delete(owner.id);
    }
  }

  private fulfill(replica: Replica, held: HeldRequest, answer: SyncResponse) {
    clearTimeout(held.timer);
    replica.held = replica.held.filter((h) => h !== held);
    if (held.owner) replica.owned.delete(held.owner.id);
    if (replica.wc.isDestroyed()) return;
    debug('answered from the owner', held.key, answer.status);
    replica.lastAnsweredAt = Date.now();
    const dbg = replica.wc.debugger;
    if (answer.failed) {
      if (held.doc) void dbg.sendCommand('Fetch.continueRequest', { requestId: held.requestId }, held.sessionId).catch(() => {});
      else void dbg.sendCommand('Fetch.failRequest', { requestId: held.requestId, errorReason: 'Failed' }, held.sessionId).catch(() => {});
      return;
    }
    void dbg
      .sendCommand(
        'Fetch.fulfillRequest',
        { requestId: held.requestId, responseCode: answer.status, ...(answer.statusText ? { responsePhrase: answer.statusText } : {}), responseHeaders: answer.headers, body: answer.body },
        held.sessionId,
      )
      .catch(() => {});
  }

  /** No answer from the owner: a page load goes to the site, anything else fails. */
  private release(replica: Replica, held: HeldRequest) {
    if (!replica.held.includes(held)) return;
    this.fulfill(replica, held, { id: held.owner?.id ?? '', status: 0, statusText: '', headers: [], body: '', failed: true });
  }

  // ---------- dialogs ----------

  /**
   * alert/confirm/prompt in the copy's page. The same dialog shows on the owning machine (in the
   * panel), and the copy's page waits for the answer given there; without one it gets "Cancel" and
   * the copy reloads the owner's state.
   */
  private onDialog(event: IpcMainEvent, d: { type: string; message: string }) {
    const replica = this.byContents.get(event.sender.id);
    if (!replica || replica.status === 'gone' || (d.type !== 'confirm' && d.type !== 'prompt')) {
      event.returnValue = d.type === 'confirm' ? false : null;
      return;
    }
    const key: DialogKey = { type: d.type, message: d.message, origin: event.senderFrame?.origin ?? 'null' };
    const now = Date.now();
    replica.dialogAnswers = replica.dialogAnswers.filter((a) => now - a.at < 30000);
    const i = replica.dialogAnswers.findIndex((a) => sameDialog(a, key));
    if (i >= 0) {
      const [answer] = replica.dialogAnswers.splice(i, 1);
      event.returnValue = d.type === 'confirm' ? answer.accept : answer.accept ? (answer.value ?? '') : null;
      return;
    }
    // The same dialog already showing on the owner: someone is answering it there, however long it takes.
    const showing = replica.ownerDialogs.some((o) => sameDialog(o, key));
    const wait: DialogWait = { ...key, event, timer: setTimeout(() => this.dialogUnanswered(replica, wait), showing ? RESPONSE_WAIT_MS : DIALOG_WAIT_MS) };
    replica.dialogWaits.push(wait);
  }

  private onOwnerDialog(replica: Replica, msg: Extract<SyncHostMessage, { t: 'dialog' }>) {
    if (msg.type !== 'confirm' && msg.type !== 'prompt') return;
    const key: DialogKey = { type: msg.type, message: msg.message, origin: originOf(msg.url) || 'null' };
    const wait = replica.dialogWaits.find((w) => sameDialog(w, key));
    if (msg.open) {
      replica.ownerDialogs.push(key);
      if (replica.ownerDialogs.length > 10) replica.ownerDialogs.shift();
      if (wait) {
        clearTimeout(wait.timer);
        wait.timer = setTimeout(() => this.dialogUnanswered(replica, wait), RESPONSE_WAIT_MS);
      }
      return;
    }
    const showing = replica.ownerDialogs.findIndex((o) => sameDialog(o, key));
    if (showing >= 0) replica.ownerDialogs.splice(showing, 1);
    if (wait) return this.answerDialog(replica, wait, !!msg.accept, msg.value ?? null);
    replica.dialogAnswers.push({ ...key, accept: !!msg.accept, value: msg.value ?? null, at: Date.now() });
    if (replica.dialogAnswers.length > 10) replica.dialogAnswers.shift();
  }

  private answerDialog(replica: Replica, wait: DialogWait, accept: boolean, value: string | null) {
    clearTimeout(wait.timer);
    replica.dialogWaits = replica.dialogWaits.filter((w) => w !== wait);
    try {
      wait.event.returnValue = wait.type === 'confirm' ? accept : accept ? (value ?? '') : null;
    } catch {
      // the page is gone
    }
  }

  private dialogUnanswered(replica: Replica, wait: DialogWait) {
    this.answerDialog(replica, wait, false, null);
    replica.needsRefresh = true;
    this.refreshWhenQuiet(replica);
  }

  // ---------- WebSockets ----------

  /** The copy's page opened or closed a WebSocket (the preload's stand-in for the real one). */
  private onCopySocket(event: IpcMainEvent, msg: { op: 'open'; sid: number; url: string } | { op: 'close'; sid: number }) {
    const replica = this.byContents.get(event.sender.id);
    const frame = event.senderFrame;
    if (!replica || !frame) return;
    const id = `${event.processId}:${event.frameId}:${msg.sid}`;
    if (msg.op === 'close') {
      const copy = replica.copySockets.get(id);
      if (copy) this.dropCopySocket(replica, id, copy, false);
      return;
    }
    const copy: CopySocket = { sid: msg.sid, frame, origin: frame.origin, owner: null, url: msg.url, timer: null };
    replica.copySockets.set(id, copy);
    if (this.bindSocket(replica, copy)) return;
    copy.timer = setTimeout(() => this.dropCopySocket(replica, id, copy, true), SOCKET_WAIT_MS);
  }

  /** Connects a copy's socket to the owner's socket to the same address, opened by the same origin (one each). */
  private bindSocket(replica: Replica, copy: CopySocket) {
    const free = [...replica.ownerSockets.values()].filter((o) => !o.copy && o.origin === copy.origin && copy.origin !== 'null');
    const owner = free.find((o) => o.url === copy.url) ?? free.find((o) => sameEndpoint(o.url, copy.url));
    if (!owner) return false;
    owner.copy = copy;
    copy.owner = owner;
    if (copy.timer) clearTimeout(copy.timer);
    copy.timer = null;
    this.toCopySocket(copy, { event: 'open' });
    for (const frame of owner.frames) this.toCopySocket(copy, { event: 'message', ...frame });
    return true;
  }

  private dropCopySocket(replica: Replica, id: string, copy: CopySocket, notify: boolean) {
    replica.copySockets.delete(id);
    if (copy.timer) clearTimeout(copy.timer);
    if (copy.owner) copy.owner.copy = null;
    copy.owner = null;
    if (notify) this.toCopySocket(copy, { event: 'close' });
  }

  private toCopySocket(copy: CopySocket, msg: { event: 'open' | 'close' } | ({ event: 'message' } & SocketFrame)) {
    try {
      copy.frame.send('bc:replica-socket', { sid: copy.sid, ...msg });
    } catch {
      // the frame is gone
    }
  }

  private onOwnerSocket(replica: Replica, msg: Extract<SyncHostMessage, { t: 'socket' }>) {
    if (msg.event === 'open') {
      replica.ownerSockets.set(msg.id, { url: msg.url, origin: msg.origin, frames: [], bytes: 0, copy: null });
      for (const copy of replica.copySockets.values()) if (!copy.owner) this.bindSocket(replica, copy);
      return;
    }
    const owner = replica.ownerSockets.get(msg.id);
    if (!owner) return;
    if (msg.event === 'close') {
      replica.ownerSockets.delete(msg.id);
      const entry = [...replica.copySockets].find(([, c]) => c === owner.copy);
      if (entry) this.dropCopySocket(replica, entry[0], entry[1], true);
      return;
    }
    const frame: SocketFrame = msg.binary ? { data: msg.data, binary: true } : { data: msg.data };
    // The first frames (a handshake, usually) are kept for a copy socket that connects later.
    if (owner.frames.length < SOCKET_HANDSHAKE_FRAMES && owner.bytes + frame.data.length <= SOCKET_HANDSHAKE_BYTES) {
      owner.frames.push(frame);
      owner.bytes += frame.data.length;
    }
    if (owner.copy) this.toCopySocket(owner.copy, { event: 'message', ...frame });
  }

  /**
   * That machine's own servers and files, and sites this machine failed to reach (that machine's
   * DNS, VPN or certificates), are not reachable here: such pages are streamed instead.
   */
  private unreachable(replica: Replica, url: string) {
    if (replica.sameMachine) return false;
    if (onlyReachableThere(url)) return true;
    const until = this.unreachableOrigins.get(replica.hostId)?.get(originOf(url));
    return !!until && until > Date.now();
  }

  private ownerUnreachable(replica: Replica) {
    return !!replica.ownerUrl && this.unreachable(replica, replica.ownerUrl);
  }

  private async applySnapshot(replica: Replica, state: SyncState, cookies: SyncCookie[]) {
    this.setStatus(replica, 'loading');
    await this.applyCookies(replica, cookies, [], true);
    replica.nav = state.nav;
    replica.snapshotted = true;
    replica.ownerUrl = state.url;
    if (state.storage) this.rememberStorage(replica, state.storage);
    if (state.indexedDB) this.rememberIndexedDb(replica, state.indexedDB);
    // The page always loads fresh, with the owner's cookies and storage in place.
    replica.lastTarget = { url: state.url, nav: state.nav };
    replica.ownerScroll = null;
    replica.needsRefresh = false;
    if (!this.unreachable(replica, state.url)) {
      await this.seedIndexedDb(replica, state.url);
      await this.load(replica, () => replica.wc.loadURL(state.url));
    }
    await this.applyState(replica, { ...state, mutated: false });
  }

  private rememberIndexedDb(replica: Replica, dump: IndexedDbDump) {
    let byOrigin = this.indexedDB.get(replica.hostId);
    if (!byOrigin) this.indexedDB.set(replica.hostId, (byOrigin = new Map()));
    byOrigin.set(dump.origin, { dump, json: JSON.stringify(dump) });
  }

  /**
   * Writes the owner's IndexedDB of a page's origin (sign-ins often live there) into this profile
   * before the page loads, when it changed since last time. Pages cannot wait for that themselves,
   * so it is done on an empty page of the same origin; true when that page was opened.
   */
  private async seedIndexedDb(replica: Replica, url: string) {
    const origin = originOf(url);
    const latest = this.indexedDB.get(replica.hostId)?.get(origin);
    if (!latest || replica.wc.isDestroyed()) return false;
    let applied = this.indexedDBApplied.get(replica.hostId);
    if (!applied) this.indexedDBApplied.set(replica.hostId, (applied = new Map()));
    if (applied.get(origin) === latest.json) return false;
    await this.load(replica, () => replica.wc.loadURL(`${origin}${SEED_PATH}`));
    if (replica.wc.isDestroyed() || originOf(replica.wc.getURL()) !== origin) return true;
    // Recorded only once every database is written, so the next load tries again otherwise.
    const done = await replica.wc.mainFrame.executeJavaScript(`(${IDB_OP})('restore', ${JSON.stringify(latest.dump)})`).catch(() => false);
    if (done === true) applied.set(origin, latest.json);
    return true;
  }

  private rememberStorage(replica: Replica, storage: NonNullable<SyncState['storage']>) {
    let byOrigin = this.storage.get(replica.hostId);
    if (!byOrigin) this.storage.set(replica.hostId, (byOrigin = new Map()));
    byOrigin.set(storage.origin, storage.items);
  }

  private applyCookies(replica: Replica, set: SyncCookie[], removed: Array<Pick<SyncCookie, 'name' | 'domain' | 'path'>>, replaceAll: boolean) {
    const ses = replica.wc.session;
    const url = (c: Pick<SyncCookie, 'domain' | 'path'> & { secure?: boolean }) => `http${c.secure === false ? '' : 's'}://${c.domain.replace(/^\./, '')}${c.path || '/'}`;
    const job = async () => {
      if (replaceAll) await ses.clearStorageData({ storages: ['cookies'] }).catch(() => {});
      await Promise.all([
        ...set.map((c) =>
          ses.cookies
            .set({
              url: url(c),
              name: c.name,
              value: c.value,
              domain: c.domain.startsWith('.') ? c.domain : undefined,
              path: c.path,
              secure: c.secure,
              httpOnly: c.httpOnly,
              expirationDate: c.expires > 0 ? c.expires : undefined,
              sameSite: c.sameSite === 'Strict' ? 'strict' : c.sameSite === 'Lax' ? 'lax' : c.sameSite === 'None' ? 'no_restriction' : undefined,
            })
            .catch(() => {}),
        ),
        ...removed.map((c) => ses.cookies.remove(url(c), c.name).catch(() => {})),
      ]);
    };
    const next = (this.cookieWork.get(replica.hostId) ?? Promise.resolve()).then(job, job);
    this.cookieWork.set(replica.hostId, next);
    return next;
  }

  /** Converge to the owner: same page (or a fresh copy of it), same fields, same scroll. */
  private async applyState(replica: Replica, state: SyncState) {
    if (replica.wc.isDestroyed() || !replica.snapshotted) return;
    replica.lastState = state;
    if (replica.ownerUrl !== state.url) {
      replica.ownerUrl = state.url;
      this.setStatus(replica, replica.status, replica.error);
    }
    // When the copy's page got the owner's answers it already shows the result; otherwise refetch.
    if (state.mutated && Date.now() - replica.lastAnsweredAt > ACTION_WINDOW_MS + 5000) replica.needsRefresh = true;
    if (state.storage) this.rememberStorage(replica, state.storage);
    if (state.indexedDB) this.rememberIndexedDb(replica, state.indexedDB);
    if (this.unreachable(replica, state.url)) {
      replica.nav = state.nav;
      replica.needsRefresh = false;
      return;
    }
    await this.loaded(replica);
    // This copy's own actions are still on their way; the state that includes them comes next.
    if (replica.pending.size > 0 || state.seq < replica.lastAckSeq) return this.reconcileLater(replica);
    const wc = replica.wc;
    const tried = replica.lastTarget?.url === state.url && replica.lastTarget.nav === state.nav;
    if (wc.getURL() !== state.url && !tried) {
      replica.nav = state.nav;
      replica.lastTarget = { url: state.url, nav: state.nav };
      replica.ownerScroll = null;
      replica.needsRefresh = false;
      await this.seedIndexedDb(replica, state.url);
      await this.load(replica, () => wc.loadURL(state.url));
    } else if (state.nav !== replica.nav) {
      replica.nav = state.nav;
      // The owner navigated; if this copy navigated the same way by itself it is already there.
      if (!replica.navigatedSinceState) {
        replica.needsRefresh = false;
        const url = wc.getURL();
        const seeded = await this.seedIndexedDb(replica, url);
        await this.load(replica, () => (seeded ? wc.loadURL(url) : wc.reload()));
      }
    }
    replica.navigatedSinceState = false;
    // Fields and storage only go into the owner's very page, never into wherever a redirect led.
    if (wc.isDestroyed() || !sameDocument(wc.getURL(), state.url)) return;
    if (state.storage && sameOrigin(wc.getURL(), state.storage.origin)) await this.run(replica, wc.mainFrame, 'setStorage', null, state.storage.items);
    if (replica.needsRefresh) this.refreshWhenQuiet(replica);
    const quiet = Date.now() - replica.lastLocalInput > QUIET_MS;
    let skipped = false;
    for (const field of state.fields) {
      const frame = this.frameFor(wc, field.frame);
      if (!frame) continue;
      if (!quiet && (await this.run(replica, frame, 'isFocused', field.target))) {
        skipped = true;
        continue;
      }
      const current = (await this.run(replica, frame, 'read', field.target)) as Pick<SyncField, 'value' | 'checked' | 'values'> | null;
      if (!current || sameField(current, field)) continue;
      // The page reacts to the new value (an autosave, say): that was the owner's to send, and it did.
      replica.lastActionAt = Date.now();
      replica.restoringUntil = Date.now() + 1000;
      if (field.checked !== undefined) await this.run(replica, frame, 'setChecked', field.target, field.checked);
      else if (field.values) await this.run(replica, frame, 'select', field.target, field.values);
      else if (field.value !== undefined) await this.run(replica, frame, 'setValue', field.target, field.value);
    }
    // Follow the owner's scrolling (the agent's, usually), not its position: a copy someone scrolled
    // keeps its place even if the owner's page did not move along.
    const ownerScroll = `${state.scroll.x},${state.scroll.y}`;
    if (quiet && ownerScroll !== replica.ownerScroll) await this.run(replica, wc.mainFrame, 'scroll', null, state.scroll);
    if (quiet) replica.ownerScroll = ownerScroll;
    else skipped = true;
    if (skipped) this.reconcileLater(replica);
    if (replica.pending.size === 0 && replica.status !== 'gone') this.setStatus(replica, 'synced');
  }

  /** Applies the newest state again once the person is done typing and own actions are confirmed. */
  private reconcileLater(replica: Replica) {
    if (replica.reconcileTimer) clearTimeout(replica.reconcileTimer);
    replica.reconcileTimer = setTimeout(() => {
      replica.reconcileTimer = null;
      if (replica.wc.isDestroyed() || !replica.lastState) return;
      if (replica.pending.size > 0 || Date.now() - replica.lastLocalInput < QUIET_MS) return this.reconcileLater(replica);
      const state = replica.lastState;
      this.enqueue(replica, () => this.applyState(replica, state));
    }, QUIET_MS);
  }

  /** The owner changed data on the site; refetch the page once the person stops interacting. */
  private refreshWhenQuiet(replica: Replica) {
    if (replica.refreshTimer) clearTimeout(replica.refreshTimer);
    const wait = Math.max(100, QUIET_MS - (Date.now() - replica.lastLocalInput));
    replica.refreshTimer = setTimeout(() => {
      replica.refreshTimer = null;
      if (replica.wc.isDestroyed() || !replica.needsRefresh) return;
      if (replica.pending.size > 0 || Date.now() - replica.lastLocalInput < QUIET_MS) return this.refreshWhenQuiet(replica);
      this.enqueue(replica, async () => {
        if (!replica.needsRefresh || replica.wc.isDestroyed()) return;
        replica.needsRefresh = false;
        const url = replica.wc.getURL();
        const seeded = await this.seedIndexedDb(replica, url);
        await this.load(replica, () => (seeded ? replica.wc.loadURL(url) : replica.wc.reload()));
      });
    }, wait);
  }

  /** Loads a page in the copy because of the owner, and waits until it is there. */
  private async load(replica: Replica, go: () => Promise<void> | void) {
    replica.expectNavigation = true;
    replica.navigatedSinceState = false;
    this.setStatus(replica, 'loading');
    const stopped = new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        if (!replica.wc.isDestroyed()) replica.wc.off('did-stop-loading', done);
        resolve();
      };
      const timer = setTimeout(done, 20000);
      replica.wc.once('did-stop-loading', done);
    });
    await Promise.resolve(go()).catch(() => {});
    await stopped;
  }

  private frameFor(wc: WebContents, ref: FrameRef | null): WebFrameMain | null {
    if (!ref) return wc.mainFrame;
    return wc.mainFrame.framesInSubtree.find((f) => f.url === ref.url) ?? null;
  }

  private async run(replica: Replica, frame: WebFrameMain, op: string, ref: unknown, arg?: unknown): Promise<any> {
    if (replica.wc.isDestroyed()) return null;
    try {
      return await frame.executeJavaScript(`(${PAGE_OP})(${JSON.stringify(op)}, ${JSON.stringify(ref)}, ${JSON.stringify(arg ?? null)})`);
    } catch {
      return null;
    }
  }

  /** Does here what was done on the owning machine (only on the page it was done on). */
  private async replay(replica: Replica, action: SyncAction) {
    replica.lastActionAt = Date.now();
    await this.loaded(replica);
    if (replica.wc.isDestroyed()) return;
    const frame = this.frameFor(replica.wc, action.frame);
    if (!frame || (action.doc && !sameDocument(frame.url, action.doc))) return;
    const wc = replica.wc;
    const isMain = frame === wc.mainFrame;
    const expectEcho = (a: Pick<SyncAction, 'kind' | 'frame' | 'target'>) => replica.replays.push({ key: echoKey(a), at: Date.now() });
    switch (action.kind) {
      case 'click': {
        if (!isMain) {
          await this.run(replica, frame, 'syntheticClick', action.target, { fx: action.fx, fy: action.fy, clickCount: action.clickCount });
          return;
        }
        const box = (await this.run(replica, frame, 'box', action.target)) as Rect | null;
        if (!box) return;
        const x = Math.round(box.x + box.width * action.fx);
        const y = Math.round(box.y + box.height * action.fy);
        const modifiers = inputModifiers(action.modifiers);
        expectEcho(action);
        wc.sendInputEvent({ type: 'mouseMove', x, y, modifiers });
        wc.sendInputEvent({ type: 'mouseDown', x, y, button: action.button, clickCount: action.clickCount, modifiers });
        wc.sendInputEvent({ type: 'mouseUp', x, y, button: action.button, clickCount: action.clickCount, modifiers });
        return;
      }
      case 'input':
        // Someone typing in this very field here wins over the owner's slightly older value.
        if (Date.now() - replica.lastLocalInput < QUIET_MS && (await this.run(replica, frame, 'isFocused', action.target))) return this.reconcileLater(replica);
        await this.run(replica, frame, 'setValue', action.target, action.value);
        return;
      case 'check':
        await this.run(replica, frame, 'setChecked', action.target, action.checked);
        return;
      case 'select':
        await this.run(replica, frame, 'select', action.target, action.values);
        return;
      case 'key': {
        if (action.target) await this.run(replica, frame, 'focus', action.target);
        const keyCode = KEY_CODES[action.key] ?? action.key;
        const modifiers = inputModifiers(action.modifiers);
        expectEcho(action);
        wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
        if (action.key === 'Enter' || action.key === 'Space') wc.sendInputEvent({ type: 'char', keyCode: action.key === 'Enter' ? '\r' : ' ', modifiers });
        wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
        return;
      }
      case 'scroll':
        // The recorder reports scrolling only right after input here; then this one would come back.
        if (Date.now() - replica.lastLocalInput < QUIET_MS) expectEcho(action);
        await this.run(replica, frame, 'scroll', action.target, { x: action.x, y: action.y });
        return;
    }
  }

  /** Waits for a page that is still loading (up to a few seconds). */
  private loaded(replica: Replica) {
    if (!replica.loading) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        replica.wc.off('did-stop-loading', done);
        resolve();
      }, 8000);
      replica.wc.once('did-stop-loading', done);
    });
  }
}

const KEY_CODES: Record<string, string> = {
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
};

function inputModifiers(modifiers: Modifier[]) {
  return modifiers.map((m) => (m === 'Control' ? 'control' : m === 'Meta' ? 'meta' : m === 'Alt' ? 'alt' : 'shift')) as Array<'control' | 'meta' | 'alt' | 'shift'>;
}

function key(hostId: string, tabId: string) {
  return `${hostId}/${tabId}`;
}

function sameDialog(a: DialogKey, b: DialogKey) {
  return a.type === b.type && a.message === b.message && a.origin === b.origin;
}

function sameField(current: Pick<SyncField, 'value' | 'checked' | 'values'>, field: Pick<SyncField, 'value' | 'checked' | 'values'>) {
  if (field.checked !== undefined) return current.checked === field.checked;
  if (field.values) return !!current.values && current.values.length === field.values.length && current.values.every((v) => field.values!.includes(v));
  return current.value === field.value;
}

function sameOrigin(url: string, origin: string) {
  return originOf(url) === origin;
}

function originOf(url: string) {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

function pathOf(url: string) {
  try {
    return new URL(url).pathname;
  } catch {
    return '';
  }
}

/** Same socket server: address without the query (which often carries tokens). */
function sameEndpoint(a: string, b: string) {
  try {
    const x = new URL(a);
    const y = new URL(b);
    return x.origin === y.origin && x.pathname === y.pathname;
  } catch {
    return false;
  }
}

interface PausedRequest {
  method: string;
  url: string;
  postData?: string;
  postDataEntries?: Array<{ bytes?: string }>;
}

/** The data a paused request sends; null when there is none (or the protocol left it out). */
function bodyOf(request: PausedRequest): Buffer | null {
  if (request.postDataEntries) return Buffer.concat(request.postDataEntries.map((e) => Buffer.from(e.bytes ?? '', 'base64')));
  if (request.postData !== undefined) return Buffer.from(request.postData, 'utf8');
  return null;
}
