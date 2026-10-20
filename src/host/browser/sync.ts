import type { CDPSession, ElementHandle, Frame, Page, Request, Response } from 'playwright-core';
import type { WebSocket } from 'ws';
import {
  ACTION_WINDOW_MS,
  indexedDbOp,
  installSyncRecorder,
  requestIdentity,
  requestKey,
  sameDocument,
  syncPageOp,
  type FrameRef,
  type IndexedDbDump,
  type SocketEvent,
  type SyncAction,
  type SyncClientMessage,
  type SyncCookie,
  type SyncField,
  type SyncHostMessage,
  type SyncState,
} from '../../shared/syncPage.js';
import { errorMessage, log } from '../log.js';
import type { BrowserManager } from './manager.js';

/** The recorder runs in its own JavaScript world, out of reach of page scripts. */
const WORLD = 'bettercodex-sync';
const BINDING = '__bettercodexSyncEmit';
const RECORDER = `(${installSyncRecorder.toString()})((json) => ${BINDING}(json), false)`;
const PAGE_OP = syncPageOp.toString();
const IDB_OP = indexedDbOp.toString();
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
/** What the page does right after a replayed action is that action's doing, not news. */
const REPLAY_TAIL_MS = 600;
/** Answers larger than this are not handed to copies (their request then fails there). */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const HOP_HEADERS = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive']);

interface Client {
  ws: WebSocket;
  tabs: Set<string>;
  /** Cookies this client has, so only changes are sent. */
  cookies: Map<string, string> | null;
  /** Last localStorage sent per tab. */
  storage: Map<string, string>;
  /** Origin and IndexedDB last read for this client, per tab. */
  indexedDB: Map<string, { origin: string; json: string }>;
}

interface TabSync {
  tabId: string;
  seq: number;
  /** Counts top-document navigations, so a copy also reloads when the URL stayed the same. */
  nav: number;
  subscribers: Set<Client>;
  page: Page | null;
  /** Set up once per page; everyone subscribing waits for the same one. */
  ready: Promise<void> | null;
  dead: boolean;
  frames: Map<string, { url: string; name: string; parentId?: string }>;
  contexts: Map<number, string>;
  /** Fields someone changed; their current values travel with every state. */
  touched: Map<string, { frame: FrameRef | null; target: SyncField['target'] }>;
  /** Recorder output is ignored until then (a replay in progress and its aftermath). */
  muteUntil: number;
  lastActionAt: number;
  mutated: boolean;
  queue: Promise<void>;
  publishTimer: NodeJS.Timeout | null;
  publishDeadline: number;
  cleanups: Array<() => void>;
  requestSeq: number;
  /** The frame showing the page's dialog, if one is open. */
  dialogUrl: string;
}

/**
 * Keeps copies of this machine's tabs on other machines in step, without streaming pixels: the
 * page here records what happens (people and the agent alike) and those actions are replayed on
 * the copies; actions done on a copy are replayed here. After things settle, the tab's state (URL,
 * field values, scroll, cookies, localStorage) is published so every copy converges to this one.
 */
export class SyncHub {
  private tabs = new Map<string, TabSync>();

  constructor(private browser: BrowserManager) {
    browser.on('tabs', (tabs: Array<{ id: string }>) => {
      for (const ts of [...this.tabs.values()]) {
        if (!tabs.some((t) => t.id === ts.tabId)) this.end(ts, 'The tab was closed');
        else if (ts.page && (ts.page.isClosed() || this.browser.get(ts.tabId)?.page !== ts.page)) this.end(ts, 'The tab went to sleep');
      }
    });
    // Copies never connect WebSockets themselves; they get what the owner's page receives.
    browser.on('socket', (e: { tabId: string; id: string } & SocketEvent) => {
      const ts = this.tabs.get(e.tabId);
      if (ts) this.broadcast(ts, { t: 'socket', ...e }, null);
    });
    // A copy runs the same dialog and waits for the answer given here (see instrument for openings).
    browser.on('dialogClosed', (e: { tabId: string; type: string; message: string; accept: boolean; promptText: string | null }) => {
      const ts = this.tabs.get(e.tabId);
      if (ts) this.broadcast(ts, { t: 'dialog', tabId: e.tabId, open: false, type: e.type, message: e.message, url: ts.dialogUrl, accept: e.accept, value: e.promptText }, null);
    });
  }

  handle(ws: WebSocket) {
    const client: Client = { ws, tabs: new Set(), cookies: null, storage: new Map(), indexedDB: new Map() };
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let msg: SyncClientMessage;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.t === 'subscribe') void this.subscribe(client, msg.tabId);
      else if (msg.t === 'unsubscribe') this.unsubscribe(client, msg.tabId);
      else if (msg.t === 'action') this.clientAction(client, msg.tabId, msg.id, msg.action);
      else if (msg.t === 'navigate') this.navigate(client, msg.tabId, msg.action);
    });
    ws.on('close', () => {
      for (const tabId of [...client.tabs]) this.unsubscribe(client, tabId);
    });
  }

  // ---------- subscriptions ----------

  private async subscribe(client: Client, tabId: string) {
    let ts = this.tabs.get(tabId);
    if (!ts) {
      ts = {
        tabId,
        seq: 0,
        nav: 0,
        subscribers: new Set(),
        page: null,
        ready: null,
        dead: false,
        frames: new Map(),
        contexts: new Map(),
        touched: new Map(),
        muteUntil: 0,
        lastActionAt: 0,
        mutated: false,
        queue: Promise.resolve(),
        publishTimer: null,
        publishDeadline: 0,
        cleanups: [],
        requestSeq: 0,
        dialogUrl: '',
      };
      this.tabs.set(tabId, ts);
    }
    ts.subscribers.add(client);
    client.tabs.add(tabId);
    this.browser.setRemoteViewers(tabId, 'sync', ts.subscribers.size);
    try {
      ts.ready ??= this.instrument(ts);
      await ts.ready;
      if (ts.dead || !ts.subscribers.has(client)) return;
      const state = await this.state(ts, client, true, await this.indexedDb(ts));
      const cookies = await this.cookies();
      if (ts.dead || !ts.subscribers.has(client)) return;
      client.cookies = new Map(cookies.map((c) => [cookieKey(c), JSON.stringify(c)]));
      const sockets = [...(this.browser.get(tabId)?.sockets ?? [])].map(([id, socket]) => ({ id, url: socket.url, origin: socket.origin, frames: socket.frames }));
      send(client, { t: 'snapshot', tabId, state, cookies, sockets });
    } catch (err) {
      log.warn('sync subscribe', tabId, errorMessage(err));
      send(client, { t: 'gone', tabId, error: errorMessage(err) });
      this.unsubscribe(client, tabId);
    }
  }

  private unsubscribe(client: Client, tabId: string) {
    client.tabs.delete(tabId);
    client.storage.delete(tabId);
    client.indexedDB.delete(tabId);
    const ts = this.tabs.get(tabId);
    if (!ts) return;
    ts.subscribers.delete(client);
    this.browser.setRemoteViewers(tabId, 'sync', ts.subscribers.size);
    if (ts.subscribers.size === 0) this.teardown(ts);
  }

  private end(ts: TabSync, error: string) {
    for (const client of ts.subscribers) {
      send(client, { t: 'gone', tabId: ts.tabId, error });
      client.tabs.delete(ts.tabId);
    }
    ts.subscribers.clear();
    this.browser.setRemoteViewers(ts.tabId, 'sync', 0);
    this.teardown(ts);
  }

  private teardown(ts: TabSync) {
    ts.dead = true;
    for (const cleanup of ts.cleanups.splice(0)) cleanup();
    if (ts.publishTimer) clearTimeout(ts.publishTimer);
    if (this.tabs.get(ts.tabId) === ts) this.tabs.delete(ts.tabId);
  }

  /** Puts the recorder into the page (its own world) and watches navigations and requests. */
  private async instrument(ts: TabSync) {
    const page = await this.browser.page(ts.tabId);
    const context = this.browser.context;
    if (!context) throw new Error('The browser is not running');
    if (ts.dead) return;
    const cdp: CDPSession = await context.newCDPSession(page);
    // Cleanups are registered as soon as there is something to clean up, so a subscriber leaving
    // halfway through still releases everything.
    ts.cleanups.push(() => void cdp.detach().catch(() => {}));
    if (ts.dead) return void cdp.detach().catch(() => {});
    ts.page = page;
    const on = cdp.on.bind(cdp) as (event: string, fn: (e: any) => void) => void;
    on('Runtime.executionContextCreated', (e) => {
      if (e.context.name === WORLD && e.context.auxData?.frameId) ts.contexts.set(e.context.id, e.context.auxData.frameId);
    });
    on('Runtime.executionContextDestroyed', (e) => ts.contexts.delete(e.executionContextId));
    on('Runtime.executionContextsCleared', () => ts.contexts.clear());
    on('Runtime.bindingCalled', (e) => {
      if (e.name === BINDING) this.recorded(ts, ts.contexts.get(e.executionContextId), e.payload);
    });
    on('Page.frameNavigated', (e) => {
      ts.frames.set(e.frame.id, { url: e.frame.url + (e.frame.urlFragment ?? ''), name: e.frame.name ?? '', parentId: e.frame.parentId });
    });
    on('Page.navigatedWithinDocument', (e) => {
      const frame = ts.frames.get(e.frameId);
      if (frame) frame.url = e.url;
    });
    on('Page.frameDetached', (e) => ts.frames.delete(e.frameId));
    // Which frame shows a dialog: a copy gives the answer only to a frame of the same origin.
    on('Page.javascriptDialogOpening', (e) => {
      ts.dialogUrl = e.url ?? '';
      this.broadcast(ts, { t: 'dialog', tabId: ts.tabId, open: true, type: e.type, message: e.message ?? '', url: ts.dialogUrl }, null);
    });

    // Sending data to a site makes copies refetch once the request is done (and new cookies are in).
    const unsafeAfterAction = (req: Request) =>
      !SAFE_METHODS.has(req.method()) && Date.now() - ts.lastActionAt < 15000 && ['fetch', 'xhr', 'document', 'other'].includes(req.resourceType());
    const onNavigated = (frame: Frame) => {
      if (frame !== page.mainFrame()) return;
      ts.nav++;
      // Fields of the previous document are gone.
      ts.touched.clear();
      this.schedulePublish(ts);
    };
    // Requests that send data right after an action: they are announced to the copies, which make
    // the same requests when they replay the action, and the answers follow once complete (a copy
    // keeps waiting while a response streams). Pages the owner got by posting a form go the same way.
    const announced = new WeakMap<Request, string>();
    const handedOver = (req: Request) =>
      !SAFE_METHODS.has(req.method()) && ['xhr', 'fetch'].includes(req.resourceType()) && Date.now() - ts.lastActionAt < ACTION_WINDOW_MS + 4000;
    const announce = (req: Request, doc?: string) => {
      const id = `${++ts.requestSeq}`;
      announced.set(req, id);
      const identity = doc ? { key: requestKey('GET', doc), exact: null, loose: '' } : requestIdentity(req.method(), req.url(), req.postDataBuffer());
      this.broadcast(ts, { t: 'request', tabId: ts.tabId, id, ...identity, ...(doc ? { doc } : {}) }, null);
    };
    const onRequest = (req: Request) => {
      if (ts.subscribers.size > 0 && handedOver(req)) announce(req);
    };
    const onResponse = (res: Response) => {
      const req = res.request();
      if (ts.subscribers.size === 0 || SAFE_METHODS.has(req.method()) || !req.isNavigationRequest() || res.status() < 200 || (res.status() >= 300 && res.status() < 400)) return;
      let main = false;
      try {
        main = req.frame() === page.mainFrame();
      } catch {
        // not a page's request
      }
      if (main) announce(req, req.url());
    };
    const failed = (id: string) => this.broadcast(ts, { t: 'response', tabId: ts.tabId, id, status: 0, statusText: '', headers: [], body: '', failed: true }, null);
    const deliver = async (req: Request, id: string) => {
      const res = await req.response().catch(() => null);
      if (!res) return failed(id);
      const headers = (await res.headersArray().catch(() => [])).filter((h) => !HOP_HEADERS.has(h.name.toLowerCase()));
      // A redirect has no body; the copy follows it like the owner did.
      if (res.status() >= 300 && res.status() < 400) {
        return this.broadcast(ts, { t: 'response', tabId: ts.tabId, id, status: res.status(), statusText: res.statusText(), headers, body: '' }, null);
      }
      // Oversized answers are not read at all; the copy's request fails instead.
      const sizes = await req.sizes().catch(() => null);
      if (Number(res.headers()['content-length'] ?? 0) > MAX_RESPONSE_BYTES || (sizes?.responseBodySize ?? 0) > MAX_RESPONSE_BYTES) return failed(id);
      const body = await res.body().catch(() => null);
      if (!body || body.length > MAX_RESPONSE_BYTES) return failed(id);
      this.broadcast(ts, { t: 'response', tabId: ts.tabId, id, status: res.status(), statusText: res.statusText(), headers, body: body.toString('base64') }, null);
    };
    const onRequestFinished = (req: Request) => {
      if (unsafeAfterAction(req)) {
        ts.mutated = true;
        this.schedulePublish(ts);
      }
      const id = announced.get(req);
      if (id) void deliver(req, id).catch(() => failed(id));
    };
    const onRequestFailed = (req: Request) => {
      if (unsafeAfterAction(req)) {
        ts.mutated = true;
        this.schedulePublish(ts);
      }
      const id = announced.get(req);
      if (id) failed(id);
    };
    page.on('request', onRequest);
    page.on('response', onResponse);
    page.on('requestfinished', onRequestFinished);
    page.on('requestfailed', onRequestFailed);
    page.on('framenavigated', onNavigated);
    ts.cleanups.push(() => {
      page.off('request', onRequest);
      page.off('response', onResponse);
      page.off('requestfinished', onRequestFinished);
      page.off('requestfailed', onRequestFailed);
      page.off('framenavigated', onNavigated);
    });

    const sendCdp = cdp.send.bind(cdp) as (method: string, params?: object) => Promise<any>;
    await sendCdp('Page.enable');
    const tree = await sendCdp('Page.getFrameTree');
    const walk = (node: any) => {
      ts.frames.set(node.frame.id, { url: node.frame.url + (node.frame.urlFragment ?? ''), name: node.frame.name ?? '', parentId: node.frame.parentId });
      for (const child of node.childFrames ?? []) walk(child);
    };
    walk(tree.frameTree);
    await sendCdp('Runtime.enable');
    await sendCdp('Runtime.addBinding', { name: BINDING, executionContextName: WORLD });
    await sendCdp('Page.addScriptToEvaluateOnNewDocument', { source: RECORDER, worldName: WORLD, runImmediately: true });
  }

  // ---------- actions ----------

  private frameRef(ts: TabSync, frameId: string | undefined): FrameRef | null {
    const frame = frameId ? ts.frames.get(frameId) : undefined;
    if (!frame || !frame.parentId) return null;
    return { url: frame.url, name: frame.name };
  }

  /** Something happened in the page here (a person at this machine, or the agent). */
  private recorded(ts: TabSync, frameId: string | undefined, payload: string) {
    if (Date.now() < ts.muteUntil) return;
    let action: SyncAction;
    try {
      action = { ...JSON.parse(payload), frame: this.frameRef(ts, frameId) };
    } catch {
      return;
    }
    ts.lastActionAt = Date.now();
    this.remember(ts, action);
    ts.seq++;
    this.broadcast(ts, { t: 'action', tabId: ts.tabId, seq: ts.seq, action }, null);
    this.schedulePublish(ts);
  }

  /** A copy did something; do the same here, then pass it on to the other copies. */
  private clientAction(client: Client, tabId: string, id: string, action: SyncAction) {
    const ts = this.tabs.get(tabId);
    if (!ts || !ts.subscribers.has(client)) {
      send(client, { t: 'ack', tabId, id, seq: ts?.seq ?? 0, error: 'Not subscribed to this tab' });
      return;
    }
    ts.queue = ts.queue.then(async () => {
      let error: string | undefined;
      ts.lastActionAt = Date.now();
      // A click that opens a dialog blocks the page until someone answers it (the dialog shows in
      // the panel); that must not hold up everything else queued for this tab.
      let onDialog: (e: { tabId: string }) => void = () => {};
      const dialog = new Promise<void>((resolve) => {
        onDialog = (e) => e.tabId === tabId && resolve();
        this.browser.on('dialog', onDialog);
      });
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('The action timed out')), 20000);
      });
      // Whatever the page reports while the replay runs is that replay's doing; the action itself
      // goes to the other copies below, and they replay its consequences themselves.
      ts.muteUntil = Number.POSITIVE_INFINITY;
      try {
        await Promise.race([this.replay(ts, action), dialog, timeout]);
      } catch (err) {
        error = errorMessage(err).split('\n')[0];
      } finally {
        clearTimeout(timer);
        this.browser.off('dialog', onDialog);
        ts.muteUntil = Date.now() + REPLAY_TAIL_MS;
      }
      if (!error) {
        this.remember(ts, action);
        ts.seq++;
        this.broadcast(ts, { t: 'action', tabId, seq: ts.seq, action }, client);
      }
      send(client, { t: 'ack', tabId, id, seq: ts.seq, error });
      this.schedulePublish(ts);
    });
  }

  /** Back/forward/reload pressed in a copy; the owner navigates and the copies follow. */
  private navigate(client: Client, tabId: string, action: 'back' | 'forward' | 'reload') {
    const ts = this.tabs.get(tabId);
    if (!ts || !ts.subscribers.has(client)) return;
    ts.queue = ts.queue.then(async () => {
      const page = ts.page;
      if (!page || page.isClosed()) return;
      ts.lastActionAt = Date.now();
      const opts = { waitUntil: 'commit' as const, timeout: 15000 };
      if (action === 'back') await page.goBack(opts).catch(() => {});
      else if (action === 'forward') await page.goForward(opts).catch(() => {});
      else await page.reload(opts).catch(() => {});
      this.schedulePublish(ts);
    });
  }

  /** Frames are matched by their exact URL (never by name alone: that could be another site). */
  private frameFor(page: Page, ref: FrameRef | null): Frame {
    if (!ref) return page.mainFrame();
    const frame = page.frames().find((f) => f.url() === ref.url);
    if (!frame) throw new Error(`Frame ${ref.url} is not in this page`);
    return frame;
  }

  private async replay(ts: TabSync, action: SyncAction) {
    const page = ts.page;
    if (!page || page.isClosed()) throw new Error('The tab is not open');
    if (this.browser.get(ts.tabId)?.dialog) throw new Error('A dialog is open in this tab');
    // The copy may be ahead (this page is still loading): give it a moment to reach the same page.
    // An action meant for one page must never land on whatever other page is open by then.
    let frame = this.frameFor(page, action.frame);
    for (const until = Date.now() + 8000; action.doc && !sameDocument(frame.url(), action.doc) && Date.now() < until; ) {
      await new Promise((r) => setTimeout(r, 200));
      frame = this.frameFor(page, action.frame);
    }
    if (action.doc && !sameDocument(frame.url(), action.doc)) throw new Error('The page changed before this action arrived');
    const handles: ElementHandle[] = [];
    const element = async () => {
      // A page that just loaded may not have built the element yet.
      for (const until = Date.now() + 5000; ; ) {
        const handle = (await frame.evaluateHandle(`(${PAGE_OP})('element', ${JSON.stringify(action.target)})`)).asElement() as ElementHandle<Element> | null;
        if (handle) {
          handles.push(handle);
          return handle;
        }
        if (Date.now() > until) throw new Error(`Element ${action.target?.label || action.target?.css} is not on this page`);
        await new Promise((r) => setTimeout(r, 250));
      }
    };
    try {
      switch (action.kind) {
        case 'click': {
          const el = await element();
          await el.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
          const box = await el.boundingBox();
          if (!box) throw new Error('The element is not visible');
          const x = box.x + box.width * action.fx;
          const y = box.y + box.height * action.fy;
          for (const m of action.modifiers) await page.keyboard.down(m);
          try {
            await page.mouse.move(x, y);
            await page.mouse.down({ button: action.button, clickCount: action.clickCount });
            await page.mouse.up({ button: action.button, clickCount: action.clickCount });
          } finally {
            for (const m of [...action.modifiers].reverse()) await page.keyboard.up(m);
          }
          return;
        }
        case 'input':
          await (await element()).fill(action.value, { timeout: 5000 });
          return;
        case 'check':
          await (await element()).setChecked(action.checked, { timeout: 5000 });
          return;
        case 'select':
          await (await element()).selectOption(action.values, { timeout: 5000 });
          return;
        case 'key':
          if (action.target) await (await element()).focus();
          await page.keyboard.press([...action.modifiers, action.key].join('+'));
          return;
        case 'scroll':
          await frame.evaluate(`(${PAGE_OP})('scroll', ${JSON.stringify(action.target)}, ${JSON.stringify({ x: action.x, y: action.y })})`);
          return;
      }
    } finally {
      for (const handle of handles) await handle.dispose().catch(() => {});
    }
  }

  private remember(ts: TabSync, action: SyncAction) {
    if (action.kind === 'input' || action.kind === 'check' || action.kind === 'select') this.touch(ts, action.frame, action.target);
  }

  private touch(ts: TabSync, frame: FrameRef | null, target: SyncField['target']) {
    ts.touched.set(`${frame?.url ?? ''}|${target.css}`, { frame, target });
    if (ts.touched.size > 60) ts.touched.delete(ts.touched.keys().next().value!);
  }

  private broadcast(ts: TabSync, msg: SyncHostMessage, except: Client | null) {
    for (const client of ts.subscribers) if (client !== except) send(client, msg);
  }

  // ---------- state ----------

  /** Publishes the tab's state once things calm down (and at least every 1.5 s while busy). */
  private schedulePublish(ts: TabSync) {
    if (ts.dead) return;
    const now = Date.now();
    if (!ts.publishTimer) ts.publishDeadline = now + 1500;
    if (ts.publishTimer) clearTimeout(ts.publishTimer);
    ts.publishTimer = setTimeout(
      () => {
        ts.publishTimer = null;
        void this.publish(ts);
      },
      Math.max(0, Math.min(400, ts.publishDeadline - now)),
    );
  }

  private async publish(ts: TabSync) {
    if (!ts.page || ts.dead || ts.subscribers.size === 0) return;
    // Let replays queued for this tab finish first, so the state includes them.
    await ts.queue;
    const cookies = await this.cookies().catch(() => null);
    const mutated = ts.mutated;
    ts.mutated = false;
    // IndexedDB is read again after data was sent (a sign-in, say) or when the page changed sites.
    const origin = originOf(ts.page.url());
    const stale = mutated || [...ts.subscribers].some((c) => c.indexedDB.get(ts.tabId)?.origin !== origin);
    const indexedDB = stale ? await this.indexedDb(ts) : undefined;
    for (const client of ts.subscribers) {
      const state = await this.state(ts, client, false, indexedDB).catch(() => null);
      if (!state) continue;
      state.mutated = mutated;
      send(client, { t: 'state', tabId: ts.tabId, state, cookies: cookies ? this.cookieDelta(client, cookies) : undefined });
    }
  }

  /** `indexedDB`: just read (null: nothing to copy), or undefined when it was not read this time. */
  private async state(ts: TabSync, client: Client, full: boolean, indexedDB?: IndexedDbDump | null): Promise<SyncState> {
    const page = ts.page!;
    const tab = this.browser.get(ts.tabId);
    const state: SyncState = { seq: ts.seq, nav: ts.nav, url: page.url(), title: tab?.title ?? '', scroll: { x: 0, y: 0 }, fields: [], mutated: false };
    // A page showing a dialog cannot run scripts; the rest of the state waits for the next round.
    if (tab?.dialog) return state;
    const run = <T>(frame: Frame, op: string, ref: unknown = null) =>
      Promise.race([frame.evaluate(`(${PAGE_OP})(${JSON.stringify(op)}, ${JSON.stringify(ref)})`) as Promise<T>, new Promise<null>((r) => setTimeout(() => r(null), 2000))]).catch(
        () => null,
      );
    state.scroll = (await run<{ x: number; y: number }>(page.mainFrame(), 'scrollPos')) ?? state.scroll;
    if (full) {
      // Fields filled before anyone watched (the recorder was not there yet) count as touched too.
      for (const frame of page.frames()) {
        const ref: FrameRef | null = frame === page.mainFrame() ? null : { url: frame.url(), name: frame.name() };
        const filled = await run<Array<Omit<SyncField, 'frame'>>>(frame, 'dirtyFields');
        for (const field of filled ?? []) this.touch(ts, ref, field.target);
      }
    }
    for (const { frame, target } of ts.touched.values()) {
      let f: Frame;
      try {
        f = this.frameFor(page, frame);
      } catch {
        continue;
      }
      const value = await run<Omit<SyncField, 'frame' | 'target'>>(f, 'read', target);
      if (value) state.fields.push({ frame, target, ...value });
    }
    const storage = await run<{ origin: string; items: Record<string, string> }>(page.mainFrame(), 'storage');
    if (storage) {
      const json = JSON.stringify(storage);
      if (full || client.storage.get(ts.tabId) !== json) {
        state.storage = storage;
        client.storage.set(ts.tabId, json);
      }
    }
    if (indexedDB !== undefined) {
      const json = indexedDB ? JSON.stringify(indexedDB) : '';
      if (indexedDB && (full || client.indexedDB.get(ts.tabId)?.json !== json)) state.indexedDB = indexedDB;
      client.indexedDB.set(ts.tabId, { origin: originOf(page.url()), json });
    }
    return state;
  }

  /** The page's IndexedDB (its own origin), or null when there is none or it cannot be read now. */
  private async indexedDb(ts: TabSync): Promise<IndexedDbDump | null> {
    const page = ts.page;
    if (!page || page.isClosed() || this.browser.get(ts.tabId)?.dialog || !/^https?:/.test(page.url())) return null;
    const dump = await Promise.race([
      page.mainFrame().evaluate(`(${IDB_OP})('dump')`) as Promise<IndexedDbDump | null>,
      new Promise<null>((r) => setTimeout(() => r(null), 5000)),
    ]).catch(() => null);
    return dump?.databases.length ? dump : null;
  }

  private async cookies(): Promise<SyncCookie[]> {
    const context = this.browser.context;
    if (!context) return [];
    return (await context.cookies()).map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      expires: c.expires,
      httpOnly: c.httpOnly,
      secure: c.secure,
      sameSite: c.sameSite,
    }));
  }

  private cookieDelta(client: Client, cookies: SyncCookie[]) {
    const next = new Map(cookies.map((c) => [cookieKey(c), JSON.stringify(c)]));
    const previous = client.cookies ?? new Map<string, string>();
    const set = cookies.filter((c) => previous.get(cookieKey(c)) !== next.get(cookieKey(c)));
    const removed = [...previous.keys()].filter((k) => !next.has(k)).map((k) => JSON.parse(previous.get(k)!) as SyncCookie);
    client.cookies = next;
    if (!set.length && !removed.length) return undefined;
    return { set, removed: removed.map(({ name, domain, path }) => ({ name, domain, path })) };
  }
}

function originOf(url: string) {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

function cookieKey(c: Pick<SyncCookie, 'name' | 'domain' | 'path'>) {
  return `${c.domain}|${c.path}|${c.name}`;
}

function send(client: Client, msg: SyncHostMessage) {
  if (client.ws.readyState === client.ws.OPEN) client.ws.send(JSON.stringify(msg));
}
