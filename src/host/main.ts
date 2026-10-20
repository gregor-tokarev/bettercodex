import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_HOST_PORT, HOST_VERSION, type HostRuntimeInfo } from '../shared/types.js';
import { ensureDirs, isPidAlive, loadSecrets, paths, readRuntimeInfo, writeJson } from './config.js';
import { errorMessage, log } from './log.js';
import { HostServer } from './server.js';

/**
 * GUI apps on macOS and non-interactive SSH sessions start with a minimal PATH,
 * so borrow the login shell's PATH to find `codex`, `node` and browsers.
 */
function adoptLoginShellPath() {
  const shell = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
  try {
    const out = execFileSync(shell, ['-ilc', 'printf "__PATH__%s" "$PATH"'], { timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const loginPath = out.split('__PATH__').pop()?.trim();
    if (loginPath) {
      const merged = new Set([...(process.env.PATH ?? '').split(path.delimiter), ...loginPath.split(path.delimiter)]);
      process.env.PATH = [...merged].filter(Boolean).join(path.delimiter);
    }
  } catch {
    // keep the inherited PATH
  }
}

function health(port: number): Promise<{ pid: number } | null> {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 2000 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          resolve(parsed?.name === 'bettercodex-host' ? parsed : null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

async function running(): Promise<HostRuntimeInfo | null> {
  const info = readRuntimeInfo();
  if (!info || !isPidAlive(info.pid)) return null;
  const h = await health(info.port);
  return h && h.pid === info.pid ? info : null;
}

async function serve(port: number) {
  ensureDirs();
  const existing = await running();
  if (existing) {
    log.info(`host already running (pid ${existing.pid}, port ${existing.port})`);
    process.exit(0);
  }
  adoptLoginShellPath();
  const secrets = loadSecrets();
  const server = new HostServer(secrets.clientToken, secrets.mcpToken);
  const actualPort = await server.listen(port);
  const info: HostRuntimeInfo = { pid: process.pid, port: actualPort, token: secrets.clientToken, version: HOST_VERSION, startedAt: Date.now() };
  writeJson(paths.runtime, info);
  log.info(`bettercodex host ${HOST_VERSION} listening on 127.0.0.1:${actualPort} (pid ${process.pid})`);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    log.info('shutting down');
    const current = readRuntimeInfo();
    if (current?.pid === process.pid) fs.rmSync(paths.runtime, { force: true });
    await Promise.race([server.shutdown(), new Promise((r) => setTimeout(r, 5000))]);
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  process.on('SIGHUP', () => {}); // survive the SSH session that started us
  process.on('uncaughtException', (err) => log.error('uncaught', err.stack ?? err));
  process.on('unhandledRejection', (err) => log.error('unhandled rejection', errorMessage(err)));
  await server.start();
}

/** Starts a detached daemon (if needed) and prints its connection info as one JSON line. */
async function start(port: number) {
  ensureDirs();
  let info = await running();
  if (!info) {
    const out = fs.openSync(paths.log, 'a');
    const self = fileURLToPath(import.meta.url);
    const child = spawn(process.execPath, [self, 'serve', '--port', String(port)], {
      detached: true,
      stdio: ['ignore', out, out],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    child.unref();
    for (let i = 0; i < 100 && !info; i++) {
      await new Promise((r) => setTimeout(r, 150));
      info = await running();
    }
    if (!info) {
      console.error(`host did not start; see ${paths.log}`);
      process.exit(1);
    }
  }
  process.stdout.write(`${JSON.stringify(info)}\n`);
}

async function main() {
  const [command = 'start', ...rest] = process.argv.slice(2);
  const portArg = rest.indexOf('--port');
  const port = portArg >= 0 ? Number(rest[portArg + 1]) : Number(process.env.BETTERCODEX_PORT) || DEFAULT_HOST_PORT;
  switch (command) {
    case 'serve':
      return serve(port);
    case 'start':
      return start(port);
    case 'status': {
      const info = await running();
      process.stdout.write(`${info ? JSON.stringify(info) : 'not running'}\n`);
      return;
    }
    case 'stop': {
      const info = readRuntimeInfo();
      if (!info || !isPidAlive(info.pid)) {
        process.stdout.write('not running\n');
        return;
      }
      process.kill(info.pid, 'SIGTERM');
      // Wait for it to really go away so a following `start` does not find the old daemon.
      for (let i = 0; i < 80 && isPidAlive(info.pid); i++) await new Promise((r) => setTimeout(r, 125));
      if (isPidAlive(info.pid)) process.kill(info.pid, 'SIGKILL');
      process.stdout.write(`stopped ${info.pid}\n`);
      return;
    }
    case 'version':
      process.stdout.write(`${HOST_VERSION}\n`);
      return;
    default:
      console.error('usage: host.mjs [start|serve|status|stop|version] [--port N]');
      process.exit(2);
  }
}

void main();
