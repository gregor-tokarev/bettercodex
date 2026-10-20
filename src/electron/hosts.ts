import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { HOST_VERSION, type HostRuntimeInfo } from '../shared/types.js';

export interface HostEntry {
  id: string;
  name: string;
  type: 'local' | 'ssh';
  /** ssh destination, e.g. "me@devbox" or an alias from ~/.ssh/config */
  target?: string;
  sshPort?: number;
  /** Private key for this machine; otherwise ssh-agent / ~/.ssh/config decide. */
  identityFile?: string;
  /** Node binary on the remote machine (defaults to `node` from the login shell). */
  nodePath?: string;
}

export type HostState = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface HostStatus {
  id: string;
  state: HostState;
  message: string | null;
  /** Where the renderer reaches the host (a local port, tunneled for SSH hosts). */
  endpoint: { port: number; token: string } | null;
}

const REMOTE_DIR = `.bettercodex/host/${HOST_VERSION.replace(/[^\w.+-]/g, '_')}`;

/** Noise from running an interactive shell without a terminal. */
const SHELL_NOISE = /^(bash: cannot set terminal process group.*|bash: no job control in this shell|logout|zsh: no job control.*)$/;

function cleanStderr(stderr: string) {
  return stderr
    .split('\n')
    .filter((line) => line.trim() && !SHELL_NOISE.test(line.trim()))
    .join('\n')
    .trim();
}

function run(cmd: string, args: string[], opts: { input?: Buffer; timeout?: number } = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { timeout: opts.timeout ?? 60000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(cleanStderr(stderr) || stdout.trim().split('\n').slice(-3).join('\n') || err.message));
      else resolve({ stdout, stderr });
    });
    if (opts.input) child.stdin?.end(opts.input);
  });
}

function lastJsonLine(out: string): HostRuntimeInfo {
  const line = out
    .trim()
    .split('\n')
    .reverse()
    .find((l) => l.trim().startsWith('{'));
  if (!line) throw new Error(`Unexpected host output: ${out.slice(-400)}`);
  return JSON.parse(line);
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function healthy(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 2000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

/** Single-quote for a POSIX shell. */
function sq(s: string) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Connects to BetterCodex hosts: the local one is started as a detached daemon from the
 * bundled host; SSH hosts get the host copied over, started remotely and tunneled.
 */
export class HostManager extends EventEmitter {
  private statuses = new Map<string, HostStatus>();
  private tunnels = new Map<string, ChildProcess>();
  private connecting = new Map<string, Promise<HostStatus>>();
  private file: string;
  hosts: HostEntry[] = [];

  constructor(
    userData: string,
    private hostBundleDir: string,
  ) {
    super();
    this.file = path.join(userData, 'hosts.json');
    try {
      this.hosts = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      this.hosts = [];
    }
    if (!this.hosts.some((h) => h.type === 'local')) this.hosts.unshift({ id: 'local', name: os.hostname(), type: 'local' });
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.hosts, null, 2));
  }

  list() {
    return this.hosts.map((h) => ({ ...h, status: this.status(h.id) }));
  }

  status(id: string): HostStatus {
    return this.statuses.get(id) ?? { id, state: 'disconnected', message: null, endpoint: null };
  }

  add(entry: Omit<HostEntry, 'id'>) {
    const host = { ...entry, id: `ssh-${Date.now().toString(36)}` };
    this.hosts.push(host);
    this.save();
    this.emit('changed');
    return host;
  }

  update(id: string, patch: Partial<HostEntry>) {
    this.hosts = this.hosts.map((h) => (h.id === id ? { ...h, ...patch, id } : h));
    this.save();
    this.emit('changed');
  }

  remove(id: string) {
    this.disconnect(id);
    this.hosts = this.hosts.filter((h) => h.id !== id || h.type === 'local');
    this.save();
    this.emit('changed');
  }

  private set(id: string, patch: Partial<HostStatus>) {
    const next = { ...this.status(id), ...patch };
    this.statuses.set(id, next);
    this.emit('status', next);
    return next;
  }

  connect(id: string): Promise<HostStatus> {
    const current = this.status(id);
    if (current.state === 'connected') return Promise.resolve(current);
    const existing = this.connecting.get(id);
    if (existing) return existing;
    const host = this.hosts.find((h) => h.id === id);
    if (!host) return Promise.reject(new Error(`Unknown host ${id}`));
    const job = (host.type === 'local' ? this.connectLocal(host) : this.connectSsh(host))
      .catch((err: Error) => this.set(id, { state: 'error', message: err.message, endpoint: null }))
      .finally(() => this.connecting.delete(id));
    this.connecting.set(id, job);
    return job;
  }

  disconnect(id: string) {
    const tunnel = this.tunnels.get(id);
    this.tunnels.delete(id);
    tunnel?.kill();
    this.set(id, { state: 'disconnected', message: null, endpoint: null });
  }

  dispose() {
    for (const tunnel of this.tunnels.values()) tunnel.kill();
  }

  /** Called by the renderer when its socket to a host drops. */
  async verify(id: string) {
    const status = this.status(id);
    if (status.state !== 'connected' || !status.endpoint) return this.connect(id);
    if (await healthy(status.endpoint.port)) return status;
    if (this.hosts.find((h) => h.id === id)?.type === 'ssh') this.disconnect(id);
    else this.set(id, { state: 'disconnected', endpoint: null });
    return this.connect(id);
  }

  // ---------- local ----------

  private async startLocal(command: 'start' | 'stop') {
    const { stdout } = await new Promise<{ stdout: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(this.hostBundleDir, 'host.mjs'), command], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      child.stdout.on('data', (c) => (out += c));
      child.stderr.on('data', (c) => (err += c));
      child.on('exit', (code) => (code === 0 ? resolve({ stdout: out }) : reject(new Error(err.trim() || `host ${command} exited ${code}`))));
      child.on('error', reject);
    });
    return stdout;
  }

  private async connectLocal(host: HostEntry) {
    this.set(host.id, { state: 'connecting', message: 'Starting local host…' });
    let info = lastJsonLine(await this.startLocal('start'));
    if (info.version !== HOST_VERSION) {
      this.set(host.id, { message: `Upgrading host ${info.version} → ${HOST_VERSION}…` });
      await this.startLocal('stop');
      info = lastJsonLine(await this.startLocal('start'));
    }
    return this.set(host.id, { state: 'connected', message: null, endpoint: { port: info.port, token: info.token } });
  }

  // ---------- ssh ----------

  private sshArgs(host: HostEntry, extra: string[] = []) {
    const args = [
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=15',
      '-o', 'ServerAliveInterval=15',
      '-o', 'ServerAliveCountMax=3',
      '-o', 'StrictHostKeyChecking=accept-new',
    ];
    if (host.sshPort) args.push('-p', String(host.sshPort));
    if (host.identityFile) args.push('-i', host.identityFile.replace(/^~(?=\/)/, os.homedir()), '-o', 'IdentitiesOnly=yes');
    // Extra options for debugging, e.g. BETTERCODEX_SSH_OPTS="-o UserKnownHostsFile=/tmp/known_hosts"
    const envOpts = process.env.BETTERCODEX_SSH_OPTS?.split(/\s+/).filter(Boolean) ?? [];
    return [...args, ...envOpts, ...extra, host.target!];
  }

  /**
   * Runs a command in the remote user's interactive login shell, so PATH includes node from
   * nvm/fnm/homebrew even when it is only set up in .bashrc/.zshrc. Output is framed by markers
   * because interactive shells may print banners or job-control warnings.
   */
  private async remote(host: HostEntry, script: string, input?: Buffer, timeout = 120000) {
    const framed = `echo __BC_BEGIN__; ${script}; status=$?; echo __BC_END__; exit $status`;
    const wrapped = `sh -c ${sq(`exec "\${SHELL:-/bin/sh}" -ilc ${sq(framed)}`)}`;
    const res = await run('ssh', [...this.sshArgs(host), wrapped], { input, timeout });
    const start = res.stdout.indexOf('__BC_BEGIN__\n');
    const end = res.stdout.lastIndexOf('__BC_END__');
    const stdout = start >= 0 ? res.stdout.slice(start + 13, end >= 0 ? end : undefined) : res.stdout;
    return { stdout, stderr: res.stderr };
  }

  private async connectSsh(host: HostEntry) {
    if (!host.target) throw new Error('SSH host has no target');
    this.set(host.id, { state: 'connecting', message: `Connecting to ${host.target}…` });
    const node = host.nodePath ? sq(host.nodePath) : 'node';
    const dir = `"$HOME/${REMOTE_DIR}"`;
    const hostJs = `${dir}/host.mjs`;
    const probe = await this.remote(
      host,
      `if ! command -v ${node} >/dev/null 2>&1; then echo NO_NODE; else echo "NODE_VERSION=$(${node} -p process.versions.node)"; fi; ` +
        `if [ -f ${dir}/.installed ]; then echo HOST_PRESENT; else echo HOST_MISSING; fi`,
    );
    if (probe.stdout.includes('NO_NODE')) {
      throw new Error(`Node.js was not found on ${host.target}. Install Node 20+ there (it runs the BetterCodex host) or set its path in the machine settings.`);
    }
    const nodeVersion = /NODE_VERSION=(\d+)\.[\d.]+/.exec(probe.stdout);
    if (!nodeVersion) throw new Error(`Could not run Node.js on ${host.target}: ${probe.stdout.trim().slice(0, 300)}`);
    if (Number(nodeVersion[1]) < 20) throw new Error(`Node ${nodeVersion[1]} on ${host.target} is too old; BetterCodex needs Node 20+.`);
    if (!probe.stdout.includes('HOST_PRESENT')) {
      this.set(host.id, { message: `Installing BetterCodex host on ${host.target}…` });
      const archive = await new Promise<Buffer>((resolve, reject) => {
        const tar = spawn('tar', ['-C', this.hostBundleDir, '-czf', '-', '--exclude=*.map', '.']);
        const chunks: Buffer[] = [];
        tar.stdout.on('data', (c) => chunks.push(c));
        tar.on('exit', (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error('tar failed'))));
        tar.on('error', reject);
      });
      // Unpack into a staging folder and move it into place only when complete, so an interrupted
      // upload never leaves a half-installed host that later looks valid.
      await this.remote(
        host,
        `set -e; base="$HOME/.bettercodex/host"; stage="$base/.staging-$$"; mkdir -p "$stage"; tar -xzf - -C "$stage"; ` +
          `test -f "$stage/host.mjs"; touch "$stage/.installed"; rm -rf ${dir}; mv "$stage" ${dir}`,
        archive,
        300000,
      );
    }
    this.set(host.id, { message: `Starting host on ${host.target}…` });
    let info = lastJsonLine((await this.remote(host, `${node} ${hostJs} start`)).stdout);
    if (info.version !== HOST_VERSION) {
      this.set(host.id, { message: `Upgrading host on ${host.target}…` });
      await this.remote(host, `${node} ${hostJs} stop`);
      info = lastJsonLine((await this.remote(host, `${node} ${hostJs} start`)).stdout);
    }
    // Older host builds are no longer needed once this one runs.
    void this.remote(host, `cd "$HOME/.bettercodex/host" && rm -rf .staging-*; for d in *; do [ "$d" = ${sq(path.basename(REMOTE_DIR))} ] || rm -rf "$d"; done`).catch(() => {});
    const localPort = await freePort();
    this.set(host.id, { message: 'Opening tunnel…' });
    const tunnel = spawn('ssh', this.sshArgs(host, ['-N', '-o', 'ExitOnForwardFailure=yes', '-L', `127.0.0.1:${localPort}:127.0.0.1:${info.port}`]), {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    tunnel.stderr.on('data', (c) => (stderr += c));
    this.tunnels.set(host.id, tunnel);
    tunnel.on('exit', () => {
      if (this.tunnels.get(host.id) !== tunnel) return;
      this.tunnels.delete(host.id);
      this.set(host.id, { state: 'disconnected', message: stderr.trim() || 'SSH tunnel closed', endpoint: null });
      this.emit('dropped', host.id);
    });
    for (let i = 0; i < 60; i++) {
      if (await healthy(localPort)) {
        return this.set(host.id, { state: 'connected', message: null, endpoint: { port: localPort, token: info.token } });
      }
      if (tunnel.exitCode !== null) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    tunnel.kill();
    throw new Error(`Could not open a tunnel to ${host.target}: ${stderr.trim() || 'timed out'}`);
  }
}
