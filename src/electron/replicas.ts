import { ipcMain, session, WebContentsView, type BrowserWindow, type IpcMainEvent, type Session, type WebContents, type WebFrameMain } from 'electron';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { WS_SUBPROTOCOL } from '../shared/types.js';
import {
  ACTION_WINDOW_MS,
  echoKey,
  onlyReachableThere,
  requestKey,
  sameDocument,
  syncPageOp,
  type FrameRef,
  type Modifier,
  type SyncAction,
  type SyncClientMessage,
  type SyncCookie,
  type SyncHostMessage,
  type SyncResponse,
  type SyncState,
} from '../shared/syncPage.js';
import type { HostManager } from './hosts.js';
import { handlePageKeys, showPageMenu, type PageNavigation } from './pageChrome.js';
import { ViewStage, type Rect } from './stage.js';

const PAGE_OP = syncPageOp.toString();
const debug = process.env.BETTERCODEX_DEBUG ? (...args: unknown[]) => console.log('[sync]', ...args) : () => {};
/** Copies kept around (hidden) so switching back to a tab is instant. */
const MAX_REPLICAS = 8;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
/** While the person types or scrolls in a copy, the other machine's state does not overwrite it. */
const QUIET_MS = 1500;
/** How long a copy's request waits for the owner's answer before it fails. */
const ANSWER_WAIT_MS = 30000;

export type ReplicaStatus = 'connecting' | 'loading' | 'synced' | 'syncing' | 'offline' | 'gone';

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
  /** Requests waiting for the owner's answer, and answers that came before the request. */
  waiting: Array<{ key: string; requestId: string; sessionId?: string; timer: NodeJS.Timeout }>;
  answers: Array<SyncResponse & { at: number }>;
  /** When the copy last got one of the owner's answers (its page then saw the same result). */
  lastAnsweredAt: number;
  snapshotted: boolean;
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

  constructor(
    private stage: ViewStage,
    private hosts: HostManager,
    private preloadPath: string,
    private uiWindow: () => BrowserWindow | null,
  ) {
    super();
    ipcMain.on('bc:sync-record', (event, json: string) => this.onRecorded(event, json));
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
    return replica ? { status: replica.status, error: replica.error, pending: replica.pending.size } : null;
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
      waiting: [],
      answers: [],
      lastAnsweredAt: 0,
      snapshotted: false,
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
    for (const w of replica.waiting) clearTimeout(w.timer);
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
    // is answered by the owner (see intercept); form posts and sockets only ever run on the owner.
    ses.webRequest.onBeforeRequest((details, callback) => {
      const socket = details.resourceType === 'webSocket' || /^wss?:/i.test(details.url);
      const formPost = !SAFE_METHODS.has(details.method) && (details.resourceType === 'mainFrame' || details.resourceType === 'subFrame');
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
    });
    wc.once('destroyed', () => {
      if (this.replicas.get(key(replica.hostId, replica.tabId)) === replica) this.destroy(replica);
    });
  }

  setStatus(replica: Replica, status: ReplicaStatus, error: string | null = null) {
    replica.status = status;
    replica.error = error;
    this.emit('status', { hostId: replica.hostId, tabId: replica.tabId, status, error, pending: replica.pending.size });
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
        this.setStatus(replica, 'gone', msg.error ?? null);
        if (msg.error === 'The tab was closed') this.destroy(replica);
        return;
      case 'response':
        this.onAnswer(replica, msg);
        return;
    }
  }

  // ---------- requests that send data ----------

  /**
   * The copy's XHR/fetch requests pass through here (all frames). Requests that send data right
   * after an action are not sent: the owner sends them when it replays the action, and its answer
   * is given to the copy. Everything else goes to the network as usual.
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
    ];
    const send = (method: string, params: object, sessionId?: string) => dbg.sendCommand(method, params, sessionId).catch(() => {});
    dbg.on('message', (_event, method, params, sessionId) => {
      if (method === 'Fetch.requestPaused') this.onRequest(replica, params, sessionId || undefined);
      else if (method === 'Target.attachedToTarget') {
        // Frames of other sites run in their own processes: intercept there too, then let them start.
        void send('Fetch.enable', { patterns }, params.sessionId).then(() => send('Runtime.runIfWaitingForDebugger', {}, params.sessionId));
      }
    });
    void send('Fetch.enable', { patterns });
    void send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  }

  private onRequest(replica: Replica, params: { requestId: string; request: { method: string; url: string } }, sessionId?: string) {
    const dbg = replica.wc.debugger;
    const { requestId, request } = params;
    if (SAFE_METHODS.has(request.method) || Date.now() - replica.lastActionAt > ACTION_WINDOW_MS) {
      void dbg.sendCommand('Fetch.continueRequest', { requestId }, sessionId).catch(() => {});
      return;
    }
    const key = requestKey(request.method, request.url);
    const now = Date.now();
    replica.answers = replica.answers.filter((a) => now - a.at < ANSWER_WAIT_MS);
    const ready = replica.answers.findIndex((a) => a.key === key);
    if (ready >= 0) {
      const [answer] = replica.answers.splice(ready, 1);
      this.answer(replica, requestId, sessionId, answer);
      return;
    }
    debug('waiting for the owner to answer', key);
    const timer = setTimeout(() => {
      replica.waiting = replica.waiting.filter((w) => w.requestId !== requestId);
      void dbg.sendCommand('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }, sessionId).catch(() => {});
    }, ANSWER_WAIT_MS);
    replica.waiting.push({ key, requestId, sessionId, timer });
  }

  private onAnswer(replica: Replica, answer: SyncResponse) {
    const i = replica.waiting.findIndex((w) => w.key === answer.key);
    if (i < 0) {
      replica.answers.push({ ...answer, at: Date.now() });
      if (replica.answers.length > 100) replica.answers.shift();
      return;
    }
    const [waiting] = replica.waiting.splice(i, 1);
    clearTimeout(waiting.timer);
    this.answer(replica, waiting.requestId, waiting.sessionId, answer);
  }

  private answer(replica: Replica, requestId: string, sessionId: string | undefined, answer: SyncResponse) {
    debug('answered from the owner', answer.key, answer.status);
    replica.lastAnsweredAt = Date.now();
    const dbg = replica.wc.debugger;
    if (replica.wc.isDestroyed()) return;
    if (answer.failed) {
      void dbg.sendCommand('Fetch.failRequest', { requestId, errorReason: 'Failed' }, sessionId).catch(() => {});
      return;
    }
    void dbg
      .sendCommand(
        'Fetch.fulfillRequest',
        { requestId, responseCode: answer.status, ...(answer.statusText ? { responsePhrase: answer.statusText } : {}), responseHeaders: answer.headers, body: answer.body },
        sessionId,
      )
      .catch(() => {});
  }

  /** That machine's own servers and files are not this machine's: such pages are streamed instead. */
  private unreachable(replica: Replica, url: string) {
    return !replica.sameMachine && onlyReachableThere(url);
  }

  private async applySnapshot(replica: Replica, state: SyncState, cookies: SyncCookie[]) {
    this.setStatus(replica, 'loading');
    await this.applyCookies(replica, cookies, [], true);
    replica.seq = Math.max(replica.seq, state.seq);
    replica.lastAckSeq = state.seq;
    replica.nav = state.nav;
    replica.snapshotted = true;
    if (state.storage) this.rememberStorage(replica, state.storage);
    // The page always loads fresh, with the owner's cookies and storage in place.
    replica.lastTarget = { url: state.url, nav: state.nav };
    replica.ownerScroll = null;
    replica.needsRefresh = false;
    if (!this.unreachable(replica, state.url)) await this.load(replica, () => replica.wc.loadURL(state.url));
    await this.applyState(replica, { ...state, mutated: false });
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
    // When the copy's page got the owner's answers it already shows the result; otherwise refetch.
    if (state.mutated && Date.now() - replica.lastAnsweredAt > ACTION_WINDOW_MS + 5000) replica.needsRefresh = true;
    if (state.storage) this.rememberStorage(replica, state.storage);
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
      await this.load(replica, () => wc.loadURL(state.url));
    } else if (state.nav !== replica.nav) {
      replica.nav = state.nav;
      // The owner navigated; if this copy navigated the same way by itself it is already there.
      if (!replica.navigatedSinceState) {
        replica.needsRefresh = false;
        await this.load(replica, () => wc.reload());
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
        if (!replica.needsRefresh) return;
        replica.needsRefresh = false;
        await this.load(replica, () => replica.wc.reload());
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

function sameOrigin(url: string, origin: string) {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}
