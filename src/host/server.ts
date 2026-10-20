import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  HOST_VERSION,
  WS_SUBPROTOCOL,
  type AppBrowserRegistration,
  type ClientMessage,
  type HostConfig,
  type HostInfo,
  type HostMessage,
  type RelayMachine,
  type RelayRequest,
} from '../shared/types.js';
import { CodexBridge, RpcError, TIMEOUT } from './codex.js';
import { loadConfig, paths, readJson, saveConfig, writeJson } from './config.js';
import { errorMessage, log } from './log.js';
import { findInPage } from './browser/find.js';
import { BrowserManager } from './browser/manager.js';
import { StreamHub } from './browser/stream.js';
import { SyncHub } from './browser/sync.js';
import { BrowserTools } from './mcp/tools.js';
import { handleMcp, MCP_SERVER_NAME, SCHEDULER_SERVER_NAME, TurnCalls } from './mcp/server.js';
import { ScheduleTools } from './mcp/scheduleTools.js';
import { browseHereInstructions } from './mcp/instructions.js';
import { Scheduler } from './scheduler.js';

interface Client {
  id: number;
  ws: WebSocket;
  /** Set once the client offers to relay requests to the other machines it is connected to. */
  relaySince: number | null;
}

class RelayUnavailable extends Error {}

const OFFICIAL_BROWSER_PLUGINS = ['browser@openai-bundled', 'chrome@openai-bundled', 'unified-computer-use@openai-bundled'];

export class HostServer {
  config: HostConfig = loadConfig();
  readonly codex = new CodexBridge(() => this.config.codex.path);
  readonly browser = new BrowserManager(() => this.config);
  readonly streams = new StreamHub(this.browser);
  readonly sync = new SyncHub(this.browser);
  readonly tools = new BrowserTools(this.browser);
  readonly scheduler = new Scheduler(this.codex, (method, params) => this.openThread(method, params));
  readonly scheduleTools = new ScheduleTools(
    this.scheduler,
    {
      machines: () => this.relay({ op: 'machines' }).then((list) => list as RelayMachine[], (err) => (err instanceof RelayUnavailable ? null : Promise.reject(err))),
      call: (machine, method, params) => this.relay({ op: 'call', machine, method, params }) as Promise<any>,
    },
    this.codex,
  );
  /** Tool calls in flight per turn, ended when the turn is (Codex leaves a stopped turn's calls open). */
  private readonly turnCalls = new TurnCalls();
  private clients = new Set<Client>();
  private relays = new Map<number, { client: Client; resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private nextRelayId = 1;
  private nextClientId = 1;
  private http = http.createServer((req, res) => void this.onHttp(req, res));
  private wss = new WebSocketServer({ noServer: true, handleProtocols: () => WS_SUBPROTOCOL, perMessageDeflate: false });
  private hasNodeRepl = false;
  private browseRule = crypto.createHash('sha256').update(browseHereInstructions()).digest('hex').slice(0, 16);
  private briefed = this.loadBriefed();
  port = 0;

  constructor(
    private clientToken: string,
    private mcpToken: string,
  ) {
    this.codex.on('notification', (method: string, params: any) => {
      if (method === 'turn/completed' && params?.turn?.id) this.turnCalls.ended(params.turn.id);
      this.broadcast({ t: 'notif', method, params });
    });
    this.codex.on('serverRequest', (req) => this.broadcast({ t: 'req', id: req.id, method: req.method, params: req.params }));
    this.codex.on('status', () => {
      if (this.codex.status !== 'ready') this.turnCalls.endAll();
      this.broadcast({ t: 'notif', method: 'host/info', params: this.info() });
      if (this.codex.status === 'ready') void this.inspectCodexConfig();
    });
    this.scheduler.on('changed', (snapshot) => this.broadcast({ t: 'notif', method: 'schedule/changed', params: snapshot }));
    this.browser.on('tabs', (tabs) => this.broadcast({ t: 'notif', method: 'browser/tabs', params: { tabs } }));
    this.browser.on('status', () => this.broadcast({ t: 'notif', method: 'host/info', params: this.info() }));
    for (const event of ['download', 'dialog', 'filechooser', 'popup']) {
      this.browser.on(event, (params) => this.broadcast({ t: 'notif', method: `browser/${event}`, params }));
    }
    this.http.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (!this.authorized(req, this.clientToken) || !['/ws', '/stream', '/sync'].includes(url.pathname)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        if (url.pathname === '/stream') this.streams.handle(ws);
        else if (url.pathname === '/sync') this.sync.handle(ws);
        else this.onClient(ws);
      });
    });
  }

  async listen(preferredPort: number) {
    for (let port = preferredPort; port < preferredPort + 30; port++) {
      const ok = await new Promise<boolean>((resolve) => {
        const onError = () => resolve(false);
        this.http.once('error', onError);
        this.http.listen(port, '127.0.0.1', () => {
          this.http.off('error', onError);
          resolve(true);
        });
      });
      if (ok) {
        this.port = port;
        this.browser.setHostEndpoint(port, this.clientToken);
        return port;
      }
    }
    throw new Error(`No free port in ${preferredPort}-${preferredPort + 30}`);
  }

  async start() {
    this.scheduler.load();
    this.scheduler.start();
    void this.codex.start();
  }

  async shutdown() {
    this.scheduler.stop();
    for (const client of this.clients) client.ws.close();
    this.codex.stop();
    await this.browser.shutdown();
    this.http.close();
  }

  info(): HostInfo {
    return {
      hostname: os.hostname(),
      platform: process.platform,
      arch: process.arch,
      homedir: os.homedir(),
      version: HOST_VERSION,
      codex: {
        status: this.codex.status,
        path: this.codex.codexPath,
        version: this.codex.version,
        error: this.codex.error,
        userAgent: this.codex.userAgent,
      },
      browser: this.browser.status,
      config: this.config,
    };
  }

  // ---------- auth ----------

  private authorized(req: http.IncomingMessage, token: string) {
    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ') && safeEqual(header.slice(7), token)) return true;
    const protocols = String(req.headers['sec-websocket-protocol'] ?? '')
      .split(',')
      .map((p) => p.trim());
    return protocols.some((p) => p.startsWith('auth.') && safeEqual(p.slice(5), token));
  }

  // ---------- HTTP ----------

  private async onHttp(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (url.pathname === '/health') {
        return json(res, 200, { ok: true, name: 'bettercodex-host', version: HOST_VERSION, pid: process.pid });
      }
      if (url.pathname === '/mcp' || url.pathname === `/mcp/${SCHEDULER_SERVER_NAME}`) {
        if (!this.authorized(req, this.mcpToken)) return json(res, 401, { error: 'unauthorized' });
        return await handleMcp(req, res, url.pathname === '/mcp' ? this.tools : this.scheduleTools, this.turnCalls);
      }
      if (!this.authorized(req, this.clientToken)) return json(res, 401, { error: 'unauthorized' });
      if (url.pathname === '/file' && req.method === 'GET') {
        const file = url.searchParams.get('path') ?? '';
        if (!path.isAbsolute(file) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return json(res, 404, { error: 'not found' });
        res.writeHead(200, { 'Content-Type': mimeFor(file), 'Content-Length': fs.statSync(file).size });
        await pipeline(fs.createReadStream(file), res).catch(() => res.destroy());
        return;
      }
      if (url.pathname === '/app-browser' && req.method === 'POST') {
        const reg = JSON.parse(await readBody(req, 64 * 1024)) as AppBrowserRegistration;
        if (typeof reg?.url !== 'string' || !/^ws:\/\/127\.0\.0\.1:\d+\//.test(reg.url) || !reg.instanceId || !reg.pid || !reg.launch?.exec) {
          return json(res, 400, { error: 'bad registration' });
        }
        this.browser.registerApp(reg);
        return json(res, 200, { ok: true });
      }
      if (url.pathname === '/upload' && req.method === 'POST') {
        const name = path.basename(url.searchParams.get('name') || 'upload.bin');
        const dir = path.join(paths.uploads, crypto.randomUUID());
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, name);
        try {
          await pipeline(req, fs.createWriteStream(file));
        } catch (err) {
          fs.rmSync(dir, { recursive: true, force: true });
          throw err;
        }
        return json(res, 200, { path: file });
      }
      json(res, 404, { error: 'not found' });
    } catch (err) {
      log.error('http', url.pathname, errorMessage(err));
      if (!res.headersSent) json(res, 500, { error: errorMessage(err) });
    }
  }

  // ---------- client websocket ----------

  private onClient(ws: WebSocket) {
    const client: Client = { id: this.nextClientId++, ws, relaySince: null };
    this.clients.add(client);
    log.info(`client ${client.id} connected (${this.clients.size} total)`);
    this.send(client, { t: 'notif', method: 'host/info', params: this.info() });
    this.send(client, { t: 'notif', method: 'browser/tabs', params: { tabs: this.browser.list() } });
    for (const req of this.codex.pendingServerRequests.values()) this.send(client, { t: 'req', id: req.id, method: req.method, params: req.params });
    ws.on('message', (data) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.t === 'rpc') void this.onRpc(client, msg.id, msg.method, msg.params);
      else if (msg.t === 'reqres') this.codex.respond(msg.id, msg.result, msg.error);
      else if (msg.t === 'relay-ready') client.relaySince = Date.now();
      else if (msg.t === 'relayres') this.onRelayResult(msg.id, msg.result, msg.error);
    });
    ws.on('close', () => {
      this.clients.delete(client);
      for (const [id, pending] of this.relays) {
        if (pending.client !== client) continue;
        this.relays.delete(id);
        clearTimeout(pending.timer);
        pending.reject(new Error('The BetterCodex app disconnected'));
      }
      log.info(`client ${client.id} disconnected`);
    });
  }

  // ---------- relay to other machines (through the app) ----------

  /** Asks the most recently connected app to reach another machine for us. */
  private relay(request: RelayRequest, timeoutMs = 60_000): Promise<unknown> {
    const client = [...this.clients]
      .filter((c) => c.relaySince !== null && c.ws.readyState === c.ws.OPEN)
      .sort((a, b) => b.relaySince! - a.relaySince!)[0];
    if (!client) return Promise.reject(new RelayUnavailable('Other machines are reachable only while the BetterCodex app is open and connected to this machine.'));
    const id = this.nextRelayId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.relays.delete(id);
        reject(new Error('The BetterCodex app did not answer in time'));
      }, timeoutMs);
      this.relays.set(id, { client, resolve, reject, timer });
      this.send(client, { t: 'relay', id, request });
    });
  }

  private onRelayResult(id: number, result: unknown, error?: { code: number; message: string }) {
    const pending = this.relays.get(id);
    if (!pending) return;
    this.relays.delete(id);
    clearTimeout(pending.timer);
    if (error) pending.reject(new RpcError(error.code, error.message));
    else pending.resolve(result);
  }

  private async onRpc(client: Client, id: number, method: string, params: any) {
    try {
      const result = await this.dispatch(method, params ?? {});
      this.send(client, { t: 'res', id, result });
    } catch (err) {
      const e = err as RpcError;
      this.send(client, { t: 'res', id, error: { code: e.code ?? -32000, message: errorMessage(err), data: e.data } });
    }
  }

  private async dispatch(method: string, params: any): Promise<unknown> {
    if (method.startsWith('host/')) return this.hostMethod(method, params);
    if (method.startsWith('browser/')) return this.browserMethod(method, params);
    if (method.startsWith('schedule/')) return this.scheduler.rpc(method, params);
    if (method === 'turn/interrupt') return this.interrupt(params);
    const opensThread = method === 'thread/start' || method === 'thread/resume' || method === 'thread/fork';
    const result = opensThread ? await this.openThread(method, params) : await this.codex.request(method, params);
    // The scheduler checks thread permissions before letting agents message other threads.
    if (opensThread) this.scheduler.noteThread(result?.thread?.id, result?.sandbox, result?.cwd);
    else if (method === 'turn/start' || method === 'thread/settings/update') this.scheduler.noteThread(params.threadId, params.sandboxPolicy, params.cwd);
    return result;
  }

  /**
   * Stops the turn running in a thread. The app's idea of which turn runs can be out of date (an
   * event missed while reconnecting, a turn started by a scheduled task), so whatever turn Codex
   * reports as running is the one stopped (`turnId`). `idle` means nothing was running at all, which
   * lets the app drop a "working" state that no longer matches Codex.
   */
  private async interrupt(params: { threadId: string; turnId?: string }) {
    let turnId = params.turnId ?? '';
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        // Codex answers once the turn has actually stopped; a turn that ended meanwhile gets no answer.
        await this.codex.request('turn/interrupt', { threadId: params.threadId, turnId }, 10_000);
        return { idle: false, turnId };
      } catch (err) {
        const message = errorMessage(err);
        const running = /but found (\S+)/.exec(message)?.[1];
        if (running && running !== turnId) {
          turnId = running;
          continue;
        }
        if (/no active turn|thread not found|not loaded/i.test(message)) return { idle: true };
        if ((err as RpcError).code !== TIMEOUT) throw err;
        const res = await this.codex.request('thread/read', { threadId: params.threadId }).catch(() => null);
        return { idle: res?.thread?.status?.type !== 'active', turnId };
      }
    }
    throw new RpcError(-32000, 'The running turn kept changing; try again');
  }

  /**
   * Opens a thread with the host's tools plugged in. New threads get the browser rule with their
   * developer instructions; resumed and forked ones keep the context they started with, so threads
   * from before the rule or from other Codex clients get it appended once.
   */
  private async openThread(method: 'thread/start' | 'thread/resume' | 'thread/fork', params: any) {
    const result = await this.codex.request(method, { ...params, config: await this.threadConfig(params.config, params.cwd) });
    const threadId: string | undefined = result?.thread?.id;
    if (!threadId || this.briefed.has(threadId)) return result;
    // A fork cut at an earlier turn may end before the rule was appended to its parent.
    const wholeFork = method === 'thread/fork' && !params.lastTurnId && !params.beforeTurnId && this.briefed.has(params.threadId);
    if (method === 'thread/start' || wholeFork) this.markBriefed(threadId, true);
    else await this.brief(threadId);
    return result;
  }

  private async brief(threadId: string) {
    // Marked first so a second client opening the thread meanwhile does not add it again.
    this.markBriefed(threadId, true);
    try {
      const text = browseHereInstructions();
      await this.codex.request('thread/inject_items', { threadId, items: [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text }] }] });
    } catch (err) {
      this.markBriefed(threadId, false);
      log.warn(`could not add the browser rule to thread ${threadId}`, errorMessage(err));
    }
  }

  private loadBriefed() {
    const stored = readJson<{ rule?: string; threads?: string[] }>(paths.briefed, {});
    return new Set(stored.rule === this.browseRule ? (stored.threads ?? []) : []);
  }

  private markBriefed(threadId: string, briefed: boolean) {
    if (briefed) this.briefed.add(threadId);
    else this.briefed.delete(threadId);
    writeJson(paths.briefed, { rule: this.browseRule, threads: [...this.briefed] });
  }

  /** Per-thread overrides that plug the host's browser tools into Codex. */
  private async threadConfig(base: Record<string, unknown> | null | undefined, cwd?: string | null) {
    const config: Record<string, unknown> = { ...(base ?? {}) };
    config.developer_instructions = await this.developerInstructions(config.developer_instructions, cwd);
    const key = `mcp_servers.${MCP_SERVER_NAME}`;
    config[`${key}.url`] = `http://127.0.0.1:${this.port}/mcp`;
    config[`${key}.http_headers`] = { Authorization: `Bearer ${this.mcpToken}` };
    config[`${key}.default_tools_approval_mode`] = 'approve';
    config[`${key}.startup_timeout_sec`] = 30;
    config[`${key}.tool_timeout_sec`] = 660;
    const scheduler = `mcp_servers.${SCHEDULER_SERVER_NAME}`;
    config[`${scheduler}.url`] = `http://127.0.0.1:${this.port}/mcp/${SCHEDULER_SERVER_NAME}`;
    config[`${scheduler}.http_headers`] = { Authorization: `Bearer ${this.mcpToken}` };
    config[`${scheduler}.default_tools_approval_mode`] = 'approve';
    config[`${scheduler}.startup_timeout_sec`] = 30;
    config[`${scheduler}.tool_timeout_sec`] = 120;
    if (this.config.codex.disableOfficialBrowser) {
      for (const plugin of OFFICIAL_BROWSER_PLUGINS) config[`plugins.${plugin}.enabled`] = false;
      if (this.hasNodeRepl) config['mcp_servers.node_repl.enabled'] = false;
    }
    return config;
  }

  /** The override replaces the user's own developer instructions, so keep theirs in front of the browser rule. */
  private async developerInstructions(base: unknown, cwd?: string | null) {
    let own = typeof base === 'string' ? base : null;
    if (own === null) {
      const res = await this.codex.request('config/read', { cwd: cwd ?? null }).catch((err) => log.warn('config/read failed', errorMessage(err)));
      own = res?.config?.developer_instructions ?? null;
    }
    return [own?.trim(), browseHereInstructions()].filter(Boolean).join('\n\n');
  }

  private async inspectCodexConfig() {
    try {
      const res = await this.codex.request('config/read', {});
      this.hasNodeRepl = !!res?.config?.mcp_servers?.node_repl;
    } catch (err) {
      log.warn('config/read failed', errorMessage(err));
    }
  }

  private async hostMethod(method: string, params: any) {
    switch (method) {
      case 'host/info':
        return this.info();
      case 'host/config/set': {
        const patch = params.config as Partial<HostConfig>;
        const engineBefore = this.config.browser.engine;
        this.config = {
          browser: { ...this.config.browser, ...(patch.browser ?? {}) },
          codex: { ...this.config.codex, ...(patch.codex ?? {}) },
        };
        saveConfig(this.config);
        if (this.config.browser.engine !== engineBefore && this.browser.context) void this.browser.reset().catch((err) => log.warn('browser reset', errorMessage(err)));
        this.broadcast({ t: 'notif', method: 'host/info', params: this.info() });
        return this.info();
      }
      case 'host/codex/restart':
        this.codex.stop();
        void this.codex.start();
        return {};
      case 'host/listDir': {
        const dir = params.path || os.homedir();
        const entries = fs
          .readdirSync(dir, { withFileTypes: true })
          .filter((e) => e.isDirectory() && (params.hidden || !e.name.startsWith('.')))
          .map((e) => e.name)
          .sort((a, b) => a.localeCompare(b));
        return { path: path.resolve(dir), parent: path.dirname(path.resolve(dir)), entries };
      }
      case 'host/shutdown':
        setTimeout(() => process.kill(process.pid, 'SIGTERM'), 100);
        return {};
    }
    throw new RpcError(-32601, `Unknown method ${method}`);
  }

  private async browserMethod(method: string, params: any) {
    const b = this.browser;
    switch (method) {
      case 'browser/tabs/list':
        return { tabs: b.list(params.threadId) };
      case 'browser/tabs/new': {
        const tab = await b.newTab(params.threadId ?? null, params.url, 'user');
        return { tab: b.info(tab) };
      }
      case 'browser/tabs/close':
        await b.close(params.tabId);
        return {};
      case 'browser/tabs/select':
        b.setCurrent(params.threadId, params.tabId);
        return {};
      case 'browser/tabs/wake': {
        // A client is about to show the tab (natively in the app): make sure it has a live page.
        await b.page(params.tabId);
        b.touch(params.tabId);
        const tab = b.get(params.tabId);
        return { tab: tab ? b.info(tab) : null };
      }
      case 'browser/tabs/assign':
        b.assign(params.tabId, params.threadId ?? null);
        return {};
      case 'browser/tabs/navigate': {
        const tab = b.get(params.tabId);
        if (!tab) throw new RpcError(-32602, 'no such tab');
        const page = await b.page(tab.id);
        const action = params.action ?? 'goto';
        const run = async () => {
          if (action === 'back') await page.goBack({ timeout: 30000 });
          else if (action === 'forward') await page.goForward({ timeout: 30000 });
          else if (action === 'reload') await page.reload({ timeout: 30000 });
          else if (action === 'stop') await page.evaluate(() => window.stop());
          else await b.goto(tab, params.url);
        };
        // Navigation can take a while; answer right away and let tab events report progress.
        run().catch((err) => log.warn('navigate', errorMessage(err)));
        return {};
      }
      case 'browser/tabs/find': {
        // Streamed tabs only: the app finds in the pages it renders itself.
        if (!b.get(params.tabId)) throw new RpcError(-32602, 'no such tab');
        const page = await b.page(params.tabId);
        const context = b.context;
        if (!context) throw new RpcError(-32000, 'browser is not running');
        return findInPage(params.tabId, () => context.newCDPSession(page), { text: String(params.text ?? ''), forward: params.forward !== false, again: !!params.again });
      }
      case 'browser/dialog/respond':
        await b.handleDialog(params.tabId, !!params.accept, params.promptText);
        return {};
      case 'browser/filechooser/respond':
        await b.resolveFileChooser(params.tabId, params.paths ?? []);
        return {};
      case 'browser/downloads/list':
        return { downloads: b.downloads };
      case 'browser/start':
        await b.ensure();
        return { status: b.status };
      case 'browser/restart':
        await b.restart();
        return { status: b.status };
    }
    throw new RpcError(-32601, `Unknown method ${method}`);
  }

  private send(client: Client, msg: HostMessage) {
    if (client.ws.readyState === client.ws.OPEN) client.ws.send(JSON.stringify(msg));
  }

  private broadcast(msg: HostMessage) {
    const data = JSON.stringify(msg);
    for (const client of this.clients) if (client.ws.readyState === client.ws.OPEN) client.ws.send(data);
  }
}

function safeEqual(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function readBody(req: http.IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > limit) {
        reject(new Error('request too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
}

function mimeFor(file: string) {
  const ext = path.extname(file).toLowerCase();
  const types: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain; charset=utf-8',
    '.json': 'application/json',
    '.html': 'text/html; charset=utf-8',
  };
  return types[ext] ?? 'application/octet-stream';
}
