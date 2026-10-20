import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { HOST_VERSION } from '../shared/types.js';
import { errorMessage, log } from './log.js';

type Pending = { resolve: (v: unknown) => void; reject: (e: RpcError) => void; method: string };

/** Error code of a request that got no answer in time. */
export const TIMEOUT = -32001;

export class RpcError extends Error {
  constructor(
    public code: number,
    message: string,
    public data?: unknown,
  ) {
    super(message);
  }
}

export interface ServerRequest {
  id: string | number;
  method: string;
  params: any;
}

function candidates(configured: string): string[] {
  const home = os.homedir();
  const list = [
    configured,
    process.env.BETTERCODEX_CODEX ?? '',
    ...(process.env.PATH ?? '').split(path.delimiter).map((dir) => path.join(dir, 'codex')),
    '/Applications/Codex.app/Contents/Resources/codex',
    path.join(home, 'Applications/Codex.app/Contents/Resources/codex'),
    '/usr/lib/chatgpt/resources/codex',
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
    path.join(home, '.local/bin/codex'),
    path.join(home, '.npm-global/bin/codex'),
    path.join(home, '.bun/bin/codex'),
  ];
  return list.filter(Boolean);
}

export function findCodex(configured: string): string | null {
  for (const file of candidates(configured)) {
    try {
      fs.accessSync(file, fs.constants.X_OK);
      if (fs.statSync(file).isFile()) return file;
    } catch {
      // keep looking
    }
  }
  return null;
}

/**
 * Owns one `codex app-server` child process and speaks newline-delimited JSON-RPC with it.
 * Restarts it if it dies; listeners get a `status` event so they can re-resume threads.
 */
export class CodexBridge extends EventEmitter {
  status: 'starting' | 'ready' | 'error' | 'stopped' = 'stopped';
  codexPath: string | null = null;
  version: string | null = null;
  error: string | null = null;
  userAgent: string | null = null;
  initializeResult: unknown = null;
  readonly pendingServerRequests = new Map<string | number, ServerRequest>();

  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private restartDelay = 1000;
  private stopping = false;
  private readyWaiters: Array<() => void> = [];

  constructor(private getConfiguredPath: () => string) {
    super();
  }

  async start() {
    this.stopping = false;
    this.setStatus('starting');
    this.codexPath = findCodex(this.getConfiguredPath());
    if (!this.codexPath) {
      this.fail('Could not find the `codex` CLI. Install it (npm i -g @openai/codex) or set its path in BetterCodex settings.');
      return;
    }
    this.version = await new Promise<string | null>((resolve) => {
      execFile(this.codexPath!, ['--version'], { timeout: 15000 }, (err, stdout) => resolve(err ? null : stdout.trim()));
    });
    log.info('starting codex app-server', this.codexPath, this.version);
    const proc = spawn(this.codexPath, ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
    this.proc = proc;
    readline.createInterface({ input: proc.stdout }).on('line', (line) => this.onLine(line));
    readline.createInterface({ input: proc.stderr }).on('line', (line) => log.debug('[codex]', line));
    proc.on('error', (err) => this.fail(`codex app-server failed to start: ${err.message}`));
    proc.on('exit', (code, signal) => this.onExit(proc, code, signal));
    try {
      this.initializeResult = await this.send('initialize', {
        clientInfo: { name: 'bettercodex', title: 'BetterCodex', version: HOST_VERSION },
        capabilities: { experimentalApi: true },
      });
      this.userAgent = (this.initializeResult as { userAgent?: string })?.userAgent ?? null;
      this.write({ jsonrpc: '2.0', method: 'initialized' });
      this.restartDelay = 1000;
      this.error = null;
      this.setStatus('ready');
      for (const waiter of this.readyWaiters.splice(0)) waiter();
    } catch (err) {
      this.fail(`codex app-server initialize failed: ${errorMessage(err)}`);
      proc.kill();
    }
  }

  stop() {
    this.stopping = true;
    this.proc?.kill();
    this.setStatus('stopped');
  }

  whenReady(): Promise<void> {
    if (this.status === 'ready') return Promise.resolve();
    return new Promise((resolve) => this.readyWaiters.push(resolve));
  }

  /** `timeoutMs` gives up waiting (with a `TIMEOUT` error) for calls Codex may never answer. */
  async request<T = any>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    if (this.status !== 'ready') {
      if (this.status === 'error') throw new RpcError(-32000, this.error ?? 'codex is not available');
      await this.whenReady();
    }
    return this.send(method, params, timeoutMs) as Promise<T>;
  }

  /** Answer a server-initiated request (approvals, user input, elicitation). */
  respond(id: string | number, result: unknown, error?: { code: number; message: string }) {
    if (!this.pendingServerRequests.has(id)) return false;
    this.pendingServerRequests.delete(id);
    this.write(error ? { jsonrpc: '2.0', id, error } : { jsonrpc: '2.0', id, result });
    return true;
  }

  private send(method: string, params?: unknown, timeoutMs?: number) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs
        ? setTimeout(() => {
            this.pending.delete(id);
            reject(new RpcError(TIMEOUT, `${method} got no answer in ${timeoutMs}ms`));
          }, timeoutMs)
        : null;
      this.pending.set(id, {
        resolve: (v) => {
          if (timer) clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          if (timer) clearTimeout(timer);
          reject(e);
        },
        method,
      });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  private write(msg: unknown) {
    if (!this.proc || !this.proc.stdin.writable) throw new RpcError(-32000, 'codex app-server is not running');
    this.proc.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  private onLine(line: string) {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      log.warn('codex: unparsable line', line.slice(0, 200));
      return;
    }
    if (msg.id !== undefined && msg.method === undefined) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if (msg.error) pending.reject(new RpcError(msg.error.code ?? -32000, msg.error.message ?? 'error', msg.error.data));
      else pending.resolve(msg.result);
      return;
    }
    if (msg.id !== undefined && msg.method) {
      const req: ServerRequest = { id: msg.id, method: msg.method, params: msg.params };
      this.pendingServerRequests.set(msg.id, req);
      this.emit('serverRequest', req);
      return;
    }
    if (msg.method) {
      if (msg.method === 'serverRequest/resolved') {
        const id = msg.params?.requestId;
        if (id !== undefined) this.pendingServerRequests.delete(id);
      }
      this.emit('notification', msg.method, msg.params);
    }
  }

  private onExit(proc: ChildProcessWithoutNullStreams, code: number | null, signal: NodeJS.Signals | null) {
    if (this.proc !== proc) return;
    this.proc = null;
    for (const [, p] of this.pending) p.reject(new RpcError(-32000, `codex app-server exited (${code ?? signal})`));
    this.pending.clear();
    for (const id of this.pendingServerRequests.keys()) this.emit('notification', 'serverRequest/resolved', { requestId: id });
    this.pendingServerRequests.clear();
    if (this.stopping) return;
    log.warn(`codex app-server exited (${code ?? signal}); restarting in ${this.restartDelay}ms`);
    this.setStatus('starting');
    setTimeout(() => void this.start(), this.restartDelay);
    this.restartDelay = Math.min(this.restartDelay * 2, 30000);
  }

  private fail(message: string) {
    log.error(message);
    this.error = message;
    this.setStatus('error');
  }

  private setStatus(status: CodexBridge['status']) {
    this.status = status;
    this.emit('status', status);
  }
}
