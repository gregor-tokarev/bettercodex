import { app, dialog, ipcMain, session, WebContentsView, type BrowserWindow, type DownloadItem, type IpcMainEvent, type Session, type WebContents } from 'electron';
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { handlePageKeys, localNavigation, showPageMenu } from './pageChrome.js';
import { ViewStage, type Rect } from './stage.js';

/** One persistent profile for every tab; the app's own UI uses the default session. */
const PARTITION = 'persist:browser';
const BIG_MESSAGE = 64 * 1024;
/** Pages may never be sent to these: they talk to the browser itself. */
const PRIVILEGED_URL = /^\s*(devtools|chrome|chrome-devtools|chrome-untrusted):/i;
/** Targets that live inside a tab and are allowed whenever their profile matches. */
const TAB_CHILD_TYPES = new Set(['iframe', 'worker', 'service_worker', 'shared_worker', 'auction_worklet', 'shared_storage_worklet', 'worklet']);
/** Target commands a page session may use (child frames and workers only). */
const PAGE_TARGET_COMMANDS = new Set(['Target.setAutoAttach', 'Target.detachFromTarget', 'Target.getTargetInfo']);

interface Tab {
  view: WebContentsView;
  wc: WebContents;
  /** Kept because a destroyed WebContents no longer tells its id. */
  wcId: number;
  targetId: string | null;
  ready: Promise<string>;
  size: { width: number; height: number };
}

interface PendingDialog {
  id: string;
  event: IpcMainEvent;
  tab: Tab;
  type: 'alert' | 'confirm' | 'prompt';
  message: string;
  defaultValue: string;
  url: string;
  fallback: NodeJS.Timeout | null;
}

type Json = Record<string, any>;

/**
 * The machine's browser when BetterCodex runs on it: every tab is a WebContentsView that the
 * app window shows natively, parked in a hidden window while nobody looks at it. The host drives
 * the tabs through a CDP bridge that only exposes tab targets, never the app's own UI.
 */
export class AppBrowser extends EventEmitter {
  readonly instanceId = crypto.randomUUID();
  readonly ready: Promise<void>;
  contextId: string | null = null;
  downloadsDir = app.getPath('downloads');

  private ses!: Session;
  private tabs = new Set<Tab>();
  private byTarget = new Map<string, Tab>();
  private byContents = new Map<number, Tab>();
  private devtoolsUrl = '';
  private token = crypto.randomBytes(24).toString('base64url');
  private server = http.createServer((_req, res) => res.writeHead(404).end());
  private wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 1024 * 1024 * 1024 });
  private port = 0;
  private bridges = new Set<Bridge>();
  private dialogs = new Map<string, PendingDialog>();

  constructor(
    private stage: ViewStage,
    private preloadPath: string,
    private uiWindow: () => BrowserWindow | null,
  ) {
    super();
    this.setMaxListeners(100);
    this.ready = this.start();
    this.ready.catch(() => {});
  }

  get url() {
    return `ws://127.0.0.1:${this.port}/${this.token}`;
  }

  get clientCount() {
    return this.bridges.size;
  }

  private async start() {
    await app.whenReady();
    this.ses = session.fromPartition(PARTITION);
    this.configureSession();
    ipcMain.on('bc:dialog', (event, d) => this.onDialog(event, d));
    this.devtoolsUrl = await readDevToolsEndpoint(app.getPath('userData'));
    this.contextId = await this.probeContextId();
    this.server.on('upgrade', (req, socket, head) => {
      if (req.url !== `/${this.token}`) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onClient(ws));
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.port = (this.server.address() as { port: number }).port;
  }

  // ---------- session ----------

  private configureSession() {
    // Sites treat "Electron/…" user agents as embedded browsers (Google refuses sign-in in them).
    this.ses.setUserAgent(this.ses.getUserAgent().replace(/\s(Electron|BetterCodex|bettercodex)\/\S+/g, ''));
    const allowed = new Set(['clipboard-sanitized-write', 'fullscreen', 'pointerLock', 'keyboardLock', 'storage-access', 'top-level-storage-access']);
    this.ses.setPermissionRequestHandler((_wc, permission, callback) => callback(allowed.has(permission)));
    this.ses.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));
    this.ses.on('will-download', (_event, item, wc) => this.onDownload(item, wc));
  }

  private tabPreferences() {
    return {
      session: this.ses,
      preload: this.preloadPath,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: true,
      backgroundThrottling: false,
      plugins: true,
      spellcheck: true,
    };
  }

  /** The partition's DevTools browser context id, which tells tab targets from the app's own. */
  private async probeContextId() {
    const probe = new WebContentsView({ webPreferences: { session: this.ses } });
    try {
      await probe.webContents.loadURL('about:blank');
      return (await targetInfo(probe.webContents)).browserContextId as string;
    } finally {
      probe.webContents.close();
    }
  }

  // ---------- tabs ----------

  createTab(url: string, webContents?: WebContents): Tab {
    const view = new WebContentsView(webContents ? { webContents } : { webPreferences: this.tabPreferences() });
    view.setBackgroundColor('#ffffff');
    const tab: Tab = { view, wc: view.webContents, wcId: view.webContents.id, targetId: null, ready: Promise.resolve(''), size: ViewStage.defaultSize() };
    this.tabs.add(tab);
    this.byContents.set(tab.wcId, tab);
    this.stage.add(tab);
    tab.ready = targetInfo(tab.wc).then((info) => {
      tab.targetId = info.targetId;
      this.byTarget.set(info.targetId, tab);
      this.emit('tab', info.targetId);
      return info.targetId as string;
    });
    tab.ready.catch(() => {});
    this.wire(tab);
    if (!webContents) void tab.wc.loadURL(url || 'about:blank').catch(() => {});
    return tab;
  }

  private wire(tab: Tab) {
    const wc = tab.wc;
    wc.setWindowOpenHandler(() => ({
      action: 'allow',
      outlivesOpener: true,
      overrideBrowserWindowOptions: { webPreferences: this.tabPreferences() },
      createWindow: (options) => this.createTab('', (options as { webContents?: WebContents }).webContents).wc,
    }));
    // Pages cannot hold the user (or the agent) hostage with "Leave site?".
    wc.on('will-prevent-unload', (event) => event.preventDefault());
    const nav = localNavigation(wc);
    wc.on('context-menu', (_e, params) => showPageMenu(wc, params, this.uiWindow(), nav, { newTab: true }));
    wc.on('before-input-event', (event, input) => handlePageKeys(event, input, this.uiWindow(), nav));
    wc.once('destroyed', () => this.removeTab(tab));
  }

  private removeTab(tab: Tab) {
    if (!this.tabs.delete(tab)) return;
    this.byContents.delete(tab.wcId);
    if (tab.targetId) this.byTarget.delete(tab.targetId);
    this.stage.remove(tab);
    for (const d of [...this.dialogs.values()]) if (d.tab === tab) this.forgetDialog(d);
  }

  tabForTarget(targetId: string | undefined) {
    return targetId ? this.byTarget.get(targetId) : undefined;
  }

  /** Resolves once a view this app created is known under `targetId`, or false after `ms`. */
  waitForTab(targetId: string, ms: number) {
    if (this.byTarget.has(targetId)) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const onTab = (id: string) => {
        if (id !== targetId) return;
        clearTimeout(timer);
        this.off('tab', onTab);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.off('tab', onTab);
        resolve(false);
      }, ms);
      this.on('tab', onTab);
    });
  }

  async closeTarget(targetId: string) {
    const tab = this.byTarget.get(targetId);
    if (!tab) return { success: false };
    tab.wc.close({ waitForBeforeUnload: false });
    return { success: true };
  }

  async createTarget(url: string | undefined) {
    if (url && PRIVILEGED_URL.test(url)) throw new Error('This URL cannot be opened in a tab');
    const tab = this.createTab(url ?? '');
    return { targetId: await tab.ready };
  }

  /** Shows a tab over the app window's browser panel at `bounds`, or hides the shown view. */
  show(win: BrowserWindow, targetId: string | null, bounds: Rect | null) {
    const tab = targetId ? (this.byTarget.get(targetId) ?? null) : null;
    return this.stage.show(win, tab, bounds);
  }

  /** Resizes a tab that is not on screen (a remote client streams it at its own size). */
  setTabSize(targetId: string, width: number, height: number) {
    const tab = this.byTarget.get(targetId);
    if (tab) this.stage.resize(tab, width, height);
  }

  isShown(targetId: string) {
    const tab = this.byTarget.get(targetId);
    return !!tab && this.stage.isShown(tab);
  }

  async capture(targetId: string) {
    const tab = this.byTarget.get(targetId);
    if (!tab) return null;
    const image = await tab.wc.capturePage(undefined, { stayHidden: true, stayAwake: true });
    return image.isEmpty() ? null : image.toDataURL();
  }

  /**
   * CDP screenshots of hidden views never complete, so the bridge answers them with Electron's
   * capture, which works whether the tab is on screen or parked.
   */
  async screenshot(targetId: string, params: Json) {
    const tab = this.byTarget.get(targetId);
    if (!tab) throw new Error('No such tab');
    let rect: Rect | undefined;
    let scale = 1;
    if (params.clip) {
      // Playwright passes document coordinates; capturePage wants viewport ones.
      const [sx, sy] = (await tab.wc.executeJavaScript('[scrollX, scrollY]', false).catch(() => [0, 0])) as number[];
      rect = {
        x: Math.max(0, Math.round(params.clip.x - sx)),
        y: Math.max(0, Math.round(params.clip.y - sy)),
        width: Math.max(1, Math.round(params.clip.width)),
        height: Math.max(1, Math.round(params.clip.height)),
      };
      scale = params.clip.scale ?? 1;
    }
    let image = await tab.wc.capturePage(rect, { stayHidden: true, stayAwake: true });
    return encodeImage(image, scale, params);
  }

  /**
   * A full-page capture of a tab that is not on screen: the hidden view is made as tall as the
   * page for a moment, so the whole document is in its viewport.
   */
  async fullPageScreenshot(targetId: string, params: Json) {
    const tab = this.byTarget.get(targetId);
    if (!tab) throw new Error('No such tab');
    if (this.stage.isShown(tab)) throw new Error('shown');
    const before = { ...tab.size };
    const height = (await tab.wc.executeJavaScript('Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)', false)) as number;
    const tall = clamp(Math.ceil(height), before.height, 16384);
    try {
      this.stage.setParkedBounds(tab, before.width, tall);
      await new Promise((r) => setTimeout(r, 150));
      const clip = params.clip;
      const rect = clip
        ? { x: Math.max(0, Math.round(clip.x)), y: Math.max(0, Math.round(clip.y)), width: Math.max(1, Math.round(clip.width)), height: Math.max(1, Math.round(Math.min(clip.height, tall))) }
        : undefined;
      const image = await tab.wc.capturePage(rect, { stayHidden: true, stayAwake: true });
      return encodeImage(image, clip?.scale ?? 1, params);
    } finally {
      this.stage.setParkedBounds(tab, before.width, before.height);
    }
  }

  // ---------- cookies (the partition is not a DevTools browser context, so Storage.* cannot reach it) ----------

  async getCookies() {
    const cookies = await this.ses.cookies.get({});
    return {
      cookies: cookies.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain ?? '',
        path: c.path ?? '/',
        expires: c.session || c.expirationDate == null ? -1 : c.expirationDate,
        size: c.name.length + c.value.length,
        httpOnly: !!c.httpOnly,
        secure: !!c.secure,
        session: !!c.session,
        sameSite: c.sameSite === 'strict' ? 'Strict' : c.sameSite === 'lax' ? 'Lax' : c.sameSite === 'no_restriction' ? 'None' : undefined,
        priority: 'Medium',
        sameParty: false,
        sourceScheme: c.secure ? 'Secure' : 'NonSecure',
        sourcePort: c.secure ? 443 : 80,
      })),
    };
  }

  async setCookies(cookies: Json[]) {
    for (const c of cookies ?? []) {
      const domain = String(c.domain ?? '');
      const host = domain.replace(/^\./, '');
      const url = c.url ?? `http${c.secure ? 's' : ''}://${host}${c.path ?? '/'}`;
      // Playwright deletes cookies by setting them already expired.
      if (typeof c.expires === 'number' && c.expires >= 0 && c.expires * 1000 <= Date.now()) {
        await this.ses.cookies.remove(url, c.name);
        continue;
      }
      await this.ses.cookies.set({
        url,
        name: c.name,
        value: c.value,
        // Only a leading dot makes a domain cookie; anything else stays host-only.
        domain: !c.url && domain.startsWith('.') ? domain : undefined,
        path: c.path,
        secure: c.secure,
        httpOnly: c.httpOnly,
        expirationDate: typeof c.expires === 'number' && c.expires > 0 ? c.expires : undefined,
        sameSite: c.sameSite === 'Strict' ? 'strict' : c.sameSite === 'Lax' ? 'lax' : c.sameSite === 'None' ? 'no_restriction' : undefined,
      });
    }
    return {};
  }

  async clearCookies() {
    await this.ses.clearStorageData({ storages: ['cookies'] });
    return {};
  }

  // ---------- downloads ----------

  /**
   * Chromium's own download events are not available for Electron's profiles, so downloads are
   * reported to the client in the same shape (Playwright then sees normal downloads).
   */
  private onDownload(item: DownloadItem, wc: WebContents | undefined) {
    const tab = wc ? this.byContents.get(wc.id) : undefined;
    const sink = tab?.targetId ? [...this.bridges].find((b) => b.downloads) : undefined;
    if (!sink?.downloads || !tab?.targetId) {
      fs.mkdirSync(this.downloadsDir, { recursive: true });
      item.setSavePath(uniquePath(this.downloadsDir, item.getFilename()));
      return;
    }
    const { behavior, downloadPath } = sink.downloads;
    if (behavior === 'deny') {
      item.cancel();
      return;
    }
    const guid = crypto.randomUUID();
    fs.mkdirSync(downloadPath, { recursive: true });
    item.setSavePath(path.join(downloadPath, behavior === 'allowAndName' ? guid : path.basename(uniquePath(downloadPath, item.getFilename()))));
    sink.downloadEvent('Browser.downloadWillBegin', { frameId: tab.targetId, guid, url: item.getURL(), suggestedFilename: item.getFilename() });
    item.once('done', (_e, state) => {
      sink.downloadEvent('Browser.downloadProgress', {
        guid,
        totalBytes: item.getTotalBytes(),
        receivedBytes: item.getReceivedBytes(),
        state: state === 'completed' ? 'completed' : 'canceled',
      });
    });
  }

  // ---------- dialogs ----------

  /**
   * alert/confirm/prompt from the tab preload. They are reported as the usual CDP dialog events
   * on the clients' page sessions, so Playwright (and the host) handle them like Chrome's.
   */
  private onDialog(event: IpcMainEvent, d: { type: PendingDialog['type']; message: string; defaultValue: string }) {
    const tab = this.byContents.get(event.sender.id);
    if (!tab?.targetId || !['alert', 'confirm', 'prompt'].includes(d.type)) {
      event.returnValue = d.type === 'prompt' ? null : d.type === 'confirm' ? false : undefined;
      return;
    }
    const pending: PendingDialog = {
      id: crypto.randomUUID(),
      event,
      tab,
      type: d.type,
      message: d.message,
      defaultValue: d.defaultValue,
      url: event.senderFrame?.url ?? tab.wc.getURL(),
      fallback: null,
    };
    this.dialogs.set(pending.id, pending);
    let reported = false;
    for (const bridge of this.bridges) reported = bridge.dialogOpened(tab.targetId, pending) || reported;
    if (!reported) this.dialogWithoutClient(pending, 0);
  }

  dialogFor(targetId: string) {
    for (const d of this.dialogs.values()) if (d.tab.targetId === targetId) return d;
    return undefined;
  }

  respondDialog(d: PendingDialog, accept: boolean, promptText?: string) {
    if (!this.dialogs.has(d.id)) return false;
    this.forgetDialog(d);
    d.event.returnValue = d.type === 'confirm' ? accept : d.type === 'prompt' ? (accept ? (promptText ?? d.defaultValue) : null) : undefined;
    for (const bridge of this.bridges) bridge.dialogClosed(d, accept, promptText);
    return true;
  }

  private forgetDialog(d: PendingDialog) {
    this.dialogs.delete(d.id);
    if (d.fallback) clearTimeout(d.fallback);
  }

  /** Nobody is connected to answer: the user does (in the window), or the dialog is dismissed. */
  dialogWithoutClient(d: PendingDialog, delay: number) {
    if (d.fallback) clearTimeout(d.fallback);
    d.fallback = setTimeout(() => {
      d.fallback = null;
      if (!this.dialogs.has(d.id) || !d.tab.targetId || [...this.bridges].some((b) => b.watchesDialogs(d.tab.targetId!))) return;
      const win = this.uiWindow();
      if (!win) {
        this.respondDialog(d, false);
        return;
      }
      const buttons = d.type === 'alert' ? ['OK'] : ['OK', 'Cancel'];
      void dialog
        .showMessageBox(win, { type: 'question', message: d.message || ' ', buttons, defaultId: 0, cancelId: buttons.length - 1, noLink: true })
        .then((result) => this.respondDialog(d, result.response === 0, d.defaultValue));
    }, delay);
  }

  // ---------- bridge ----------

  private onClient(ws: WebSocket) {
    const bridge = new Bridge(this, ws, this.devtoolsUrl);
    this.bridges.add(bridge);
    this.emit('clients', this.bridges.size);
    ws.on('close', () => {
      this.bridges.delete(bridge);
      this.emit('clients', this.bridges.size);
      // Give a reconnecting host a moment before the user (or a default answer) takes over.
      for (const d of this.dialogs.values()) this.dialogWithoutClient(d, 3000);
    });
  }

  /** Top-level tab targets need to be views this app created (DevTools share their profile). */
  async allowsTarget(info: Json | undefined, wait: boolean) {
    if (!info || !this.contextId || info.browserContextId !== this.contextId) return false;
    if (TAB_CHILD_TYPES.has(info.type)) return true;
    if (info.type !== 'page' || PRIVILEGED_URL.test(info.url ?? '')) return false;
    if (this.byTarget.has(info.targetId)) return true;
    return wait ? this.waitForTab(info.targetId, 1500) : false;
  }

  broadcast(method: string, params: Json) {
    for (const bridge of this.bridges) bridge.event(method, params);
  }

  /** Commands the host sends on its control session. */
  async command(bridge: Bridge, method: string, params: Json, sessionId: string | undefined) {
    switch (method) {
      case 'BetterCodex.enable':
        bridge.controlSession = sessionId ?? '';
        if (typeof params.downloadsDir === 'string' && params.downloadsDir) this.downloadsDir = params.downloadsDir;
        return { instanceId: this.instanceId };
      case 'BetterCodex.setTabSize':
        this.setTabSize(params.targetId, params.width, params.height);
        return {};
    }
    throw new Error(`Unknown method ${method}`);
  }
}

/**
 * One host connection, proxied to Chromium's DevTools endpoint. Targets outside the tab profile
 * (the app UI, DevTools windows) are invisible; tab creation, closing, screenshots, cookies,
 * downloads and dialogs are answered by the app because Chromium cannot do them for Electron views.
 */
class Bridge {
  controlSession: string | null = null;
  /** Where the client wants downloads (Browser.setDownloadBehavior). */
  downloads: { behavior: string; downloadPath: string; sessionId?: string } | null = null;
  private upstream: WebSocket;
  private queue: string[] = [];
  /** Sessions attached to tab targets (pages, their frames and workers) → target id. */
  private sessions = new Map<string, string>();
  /** Sessions attached to the browser target; they behave like the root connection. */
  private browserSessions = new Set<string>();
  private allowedTargets = new Set<string>();
  /** Page sessions of top-level tabs that enabled the Page domain (they get dialog events). */
  private pageSessions = new Map<string, string>();
  private frameTreeIds = new Map<number, string>();
  private filterIds = new Map<number, 'getTargets' | 'browserSession'>();
  private own = new Map<number, (msg: Json) => void>();
  private nextOwnId = 1_000_000_000;
  /** Created tabs whose auto-attach the client has not seen yet. */
  private attachWaiters = new Map<string, () => void>();
  /** Upstream messages are handled in order; deciding about a new target may take a moment. */
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private owner: AppBrowser,
    private client: WebSocket,
    devtoolsUrl: string,
  ) {
    this.upstream = new WebSocket(devtoolsUrl, { perMessageDeflate: false, maxPayload: 1024 * 1024 * 1024 });
    this.upstream.on('open', () => {
      for (const msg of this.queue) this.upstream.send(msg);
      this.queue = [];
    });
    this.upstream.on('message', (data) => {
      this.chain = this.chain.then(() => this.fromUpstream(data)).catch(() => {});
    });
    this.upstream.on('close', () => this.client.close());
    this.upstream.on('error', () => this.client.close());
    this.client.on('message', (data) => void this.fromClient(data));
    this.client.on('close', () => this.upstream.close());
    this.client.on('error', () => this.upstream.close());
  }

  event(method: string, params: Json) {
    if (this.controlSession === null) return;
    this.send({ method, params, ...(this.controlSession ? { sessionId: this.controlSession } : {}) });
  }

  downloadEvent(method: string, params: Json) {
    if (!this.downloads) return;
    this.send({ method, params, ...(this.downloads.sessionId ? { sessionId: this.downloads.sessionId } : {}) });
  }

  watchesDialogs(targetId: string) {
    return [...this.pageSessions.values()].includes(targetId);
  }

  /** Reports a page dialog on every page session of its tab; false when nobody listens. */
  dialogOpened(targetId: string, d: { type: string; message: string; defaultValue: string; url: string }) {
    let sent = false;
    for (const [sessionId, id] of this.pageSessions) {
      if (id !== targetId) continue;
      this.sendDialogOpening(sessionId, d);
      sent = true;
    }
    return sent;
  }

  private sendDialogOpening(sessionId: string, d: { type: string; message: string; defaultValue: string; url: string }) {
    this.send({
      method: 'Page.javascriptDialogOpening',
      params: { url: d.url, message: d.message, type: d.type, hasBrowserHandler: false, defaultPrompt: d.defaultValue },
      sessionId,
    });
  }

  dialogClosed(d: { tab: { targetId: string | null } }, accept: boolean, promptText?: string) {
    for (const [sessionId, id] of this.pageSessions) {
      if (id === d.tab.targetId) this.send({ method: 'Page.javascriptDialogClosed', params: { result: accept, userInput: promptText ?? '' }, sessionId });
    }
    this.event('BetterCodex.dialogClosed', { targetId: d.tab.targetId, accept, promptText });
  }

  private send(msg: Json | string) {
    if (this.client.readyState === WebSocket.OPEN) this.client.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }

  private toUpstream(msg: string) {
    if (this.upstream.readyState === WebSocket.OPEN) this.upstream.send(msg);
    else if (this.upstream.readyState === WebSocket.CONNECTING) this.queue.push(msg);
  }

  private ownCommand(method: string, params: Json, sessionId?: string): { id: number; result: Promise<Json> } {
    const id = this.nextOwnId++;
    const result = new Promise<Json>((resolve) => {
      this.own.set(id, resolve);
      this.toUpstream(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
    return { id, result };
  }

  private async fromClient(data: RawData) {
    const raw = data.toString();
    let msg: Json;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const { id, method, params = {}, sessionId } = msg as { id: number; method: string; params?: Json; sessionId?: string };
    const reply = (work: Promise<unknown> | unknown) =>
      Promise.resolve(work).then(
        (result) => this.send({ id, result: result ?? {}, ...(sessionId ? { sessionId } : {}) }),
        (err: Error) => this.send({ id, error: { code: -32000, message: err?.message ?? String(err) }, ...(sessionId ? { sessionId } : {}) }),
      );
    const refuse = (message: string) => reply(Promise.reject(new Error(message)));
    if (typeof method !== 'string') return;
    if (method.startsWith('BetterCodex.')) return reply(this.owner.command(this, method, params, sessionId));

    const browserLevel = !sessionId || this.browserSessions.has(sessionId);
    if (!browserLevel) return this.fromPageSession(raw, id, method, params, sessionId!, reply, refuse);

    const target = params.targetId as string | undefined;
    const hidden = target !== undefined && !this.allowedTargets.has(target) && !this.owner.tabForTarget(target);
    switch (method) {
      case 'Target.createTarget':
        // Chrome reports the new target as attached before it answers; Playwright relies on that order.
        return reply(
          this.owner.createTarget(params.url).then(async (result) => {
            if (![...this.sessions.values()].includes(result.targetId)) {
              await new Promise<void>((resolve) => {
                this.attachWaiters.set(result.targetId, resolve);
                setTimeout(resolve, 5000);
              });
              this.attachWaiters.delete(result.targetId);
            }
            return result;
          }),
        );
      case 'Target.closeTarget':
        if (hidden || !target) return refuse('No target with given id found');
        return reply(this.owner.closeTarget(target));
      case 'Target.activateTarget':
        return reply({});
      case 'Target.attachToTarget':
      case 'Target.getTargetInfo':
      case 'Target.autoAttachRelated':
        if (hidden) return refuse('No target with given id found');
        break;
      case 'Target.exposeDevToolsProtocol':
      case 'Target.createBrowserContext':
      case 'Target.disposeBrowserContext':
      case 'Target.setRemoteLocations':
      case 'Target.sendMessageToTarget':
        return refuse(`${method} is not available in the BetterCodex browser`);
      case 'Target.attachToBrowserTarget':
        this.filterIds.set(id, 'browserSession');
        break;
      case 'Target.getTargets':
        this.filterIds.set(id, 'getTargets');
        break;
      case 'Browser.setDownloadBehavior':
        this.downloads = params.behavior === 'default' ? null : { behavior: params.behavior, downloadPath: params.downloadPath ?? '', sessionId };
        return reply({});
      case 'Browser.close':
      case 'Browser.crash':
      case 'Browser.crashGpuProcess':
      case 'Browser.grantPermissions':
      case 'Browser.resetPermissions':
        return reply({});
      case 'Storage.getCookies':
        return reply(this.owner.getCookies());
      case 'Storage.setCookies':
        return reply(this.owner.setCookies(params.cookies));
      case 'Storage.clearCookies':
        return reply(this.owner.clearCookies());
    }
    this.toUpstream(raw);
  }

  private fromPageSession(
    raw: string,
    id: number,
    method: string,
    params: Json,
    sessionId: string,
    reply: (work: Promise<unknown> | unknown) => Promise<void>,
    refuse: (message: string) => Promise<void>,
  ) {
    const targetId = this.sessions.get(sessionId);
    if (!targetId) return refuse('Session is not available');
    if (method.startsWith('Target.') && (!PAGE_TARGET_COMMANDS.has(method) || params.targetId !== undefined)) {
      return refuse(`${method} is not available on a page session in the BetterCodex browser`);
    }
    const tab = this.owner.tabForTarget(targetId);
    if (!tab) return this.toUpstream(raw);
    switch (method) {
      case 'Page.enable':
        this.pageSessions.set(sessionId, targetId);
        break;
      case 'Page.disable':
        this.pageSessions.delete(sessionId);
        break;
      case 'Page.getFrameTree':
        // A dialog that was already open is reported once the client knows the page's frames.
        this.frameTreeIds.set(id, sessionId);
        break;
      case 'Page.navigate':
        if (PRIVILEGED_URL.test(params.url ?? '')) return refuse('This URL cannot be opened in a tab');
        break;
      case 'Page.bringToFront':
        return reply({});
      case 'Page.close':
        return reply(this.owner.closeTarget(targetId));
      case 'Page.handleJavaScriptDialog': {
        const d = this.owner.dialogFor(targetId);
        if (!d) return refuse('No dialog is showing');
        this.owner.respondDialog(d, !!params.accept, params.promptText);
        return reply({});
      }
      case 'Page.captureScreenshot': {
        if (!params.captureBeyondViewport) return reply(this.owner.screenshot(targetId, params));
        if (!this.owner.isShown(targetId)) return reply(this.owner.fullPageScreenshot(targetId, params));
        // On screen Chromium can render beyond the viewport itself.
        const command = this.ownCommand(method, params, sessionId);
        return reply(
          Promise.race([
            command.result.then((r) => {
              if (r.error) throw new Error(r.error.message);
              return r.result;
            }),
            new Promise((_, reject) =>
              setTimeout(() => {
                this.own.delete(command.id);
                reject(new Error('The full-page screenshot timed out'));
              }, 15000),
            ),
          ]),
        );
      }
    }
    this.toUpstream(raw);
  }

  private async fromUpstream(data: RawData) {
    const raw = data.toString();
    // Screencast frames and screenshots are large and never need inspection; route them by peeking.
    if (raw.length > BIG_MESSAGE) {
      const idMatch = /^\{"id":(\d+)/.exec(raw);
      const id = idMatch ? Number(idMatch[1]) : undefined;
      if (id === undefined || (!this.own.has(id) && !this.filterIds.has(id) && !this.frameTreeIds.has(id))) {
        const session = /"sessionId":"([^"]+)"\}$/.exec(raw.slice(-120))?.[1];
        if (session && !this.sessions.has(session) && !this.browserSessions.has(session)) return;
        if (id === undefined && /^\{"method":"Target\./.test(raw)) return this.onEvent(JSON.parse(raw), raw);
        return this.send(raw);
      }
    }
    let msg: Json;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof msg.id === 'number') {
      const own = this.own.get(msg.id);
      if (own) {
        this.own.delete(msg.id);
        return own(msg);
      }
      const frameTreeSession = this.frameTreeIds.get(msg.id);
      if (frameTreeSession) {
        this.frameTreeIds.delete(msg.id);
        this.send(raw);
        const targetId = this.sessions.get(frameTreeSession);
        const d = targetId ? this.owner.dialogFor(targetId) : undefined;
        if (d && this.pageSessions.has(frameTreeSession)) this.sendDialogOpening(frameTreeSession, d);
        return;
      }
      const filter = this.filterIds.get(msg.id);
      if (filter) {
        this.filterIds.delete(msg.id);
        if (filter === 'browserSession' && msg.result?.sessionId) this.browserSessions.add(msg.result.sessionId);
        if (filter === 'getTargets' && Array.isArray(msg.result?.targetInfos)) {
          const visible = [];
          for (const info of msg.result.targetInfos) if (this.allowedTargets.has(info.targetId) || (await this.owner.allowsTarget(info, false))) visible.push(info);
          msg.result.targetInfos = visible;
          return this.send(msg);
        }
      }
      return this.send(raw);
    }
    return this.onEvent(msg, raw);
  }

  private async onEvent(msg: Json, raw: string) {
    const { method, params = {}, sessionId } = msg as { method: string; params?: Json; sessionId?: string };
    if (sessionId && !this.sessions.has(sessionId) && !this.browserSessions.has(sessionId)) return;
    switch (method) {
      case 'Target.attachedToTarget': {
        // Sessions on the browser target itself (Playwright's CDP sessions) are fine.
        if (params.targetInfo?.type === 'browser') {
          this.browserSessions.add(params.sessionId);
          return this.send(raw);
        }
        // Children of an allowed page (frames, workers) come in on that page's session.
        const child = sessionId !== undefined && this.sessions.has(sessionId) && TAB_CHILD_TYPES.has(params.targetInfo?.type);
        if (child || (await this.owner.allowsTarget(params.targetInfo, true))) {
          this.sessions.set(params.sessionId, params.targetInfo.targetId);
          this.allowedTargets.add(params.targetInfo.targetId);
          this.send(raw);
          this.attachWaiters.get(params.targetInfo.targetId)?.();
          return;
        }
        // Not ours to see: let it run and let go of it.
        if (params.waitingForDebugger) void this.ownCommand('Runtime.runIfWaitingForDebugger', {}, params.sessionId);
        void this.ownCommand('Target.detachFromTarget', { sessionId: params.sessionId }, sessionId);
        return;
      }
      case 'Target.detachedFromTarget':
        if (!this.sessions.has(params.sessionId)) return;
        this.sessions.delete(params.sessionId);
        this.pageSessions.delete(params.sessionId);
        return this.send(raw);
      case 'Target.targetCreated':
      case 'Target.targetInfoChanged':
        if (!this.allowedTargets.has(params.targetInfo?.targetId) && !(await this.owner.allowsTarget(params.targetInfo, false))) return;
        this.allowedTargets.add(params.targetInfo.targetId);
        return this.send(raw);
      case 'Target.targetDestroyed':
      case 'Target.targetCrashed':
        if (!this.allowedTargets.has(params.targetId)) return;
        if (method === 'Target.targetDestroyed') this.allowedTargets.delete(params.targetId);
        return this.send(raw);
    }
    this.send(raw);
  }
}

function encodeImage(image: Electron.NativeImage, scale: number, params: Json) {
  if (scale !== 1 && !image.isEmpty()) {
    const size = image.getSize();
    image = image.resize({ width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)), quality: 'best' });
  }
  const data = params.format === 'png' ? image.toPNG() : image.toJPEG(params.quality ?? 80);
  return { data: data.toString('base64') };
}

async function targetInfo(wc: WebContents): Promise<Json> {
  const dbg = wc.debugger;
  const attached = dbg.isAttached();
  if (!attached) dbg.attach('1.3');
  try {
    return (await dbg.sendCommand('Target.getTargetInfo')).targetInfo;
  } finally {
    if (!attached && dbg.isAttached()) dbg.detach();
  }
}

/** Chromium writes the DevTools port into the profile once its server is up. */
async function readDevToolsEndpoint(userData: string) {
  const file = path.join(userData, 'DevToolsActivePort');
  for (let i = 0; i < 200; i++) {
    try {
      const [port, wsPath] = fs.readFileSync(file, 'utf8').split('\n');
      if (port && wsPath) return `ws://127.0.0.1:${port.trim()}${wsPath.trim()}`;
    } catch {
      // not written yet
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('The DevTools endpoint did not come up');
}

function uniquePath(dir: string, filename: string) {
  const safe = filename.replace(/[/\\]/g, '_') || 'download';
  const ext = path.extname(safe);
  const base = safe.slice(0, safe.length - ext.length);
  let candidate = path.join(dir, safe);
  for (let i = 1; fs.existsSync(candidate); i++) candidate = path.join(dir, `${base} (${i})${ext}`);
  return candidate;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}
