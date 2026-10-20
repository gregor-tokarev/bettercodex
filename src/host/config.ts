import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { HostConfig, HostRuntimeInfo } from '../shared/types.js';

export const BC_HOME = process.env.BETTERCODEX_HOME || path.join(os.homedir(), '.bettercodex');

export const paths = {
  home: BC_HOME,
  runtime: path.join(BC_HOME, 'host.json'),
  secrets: path.join(BC_HOME, 'secrets.json'),
  config: path.join(BC_HOME, 'config.json'),
  tabs: path.join(BC_HOME, 'tabs.json'),
  profile: path.join(BC_HOME, 'browser-profile'),
  downloads: path.join(BC_HOME, 'downloads'),
  uploads: path.join(BC_HOME, 'uploads'),
  screenshots: path.join(BC_HOME, 'screenshots'),
  log: path.join(BC_HOME, 'host.log'),
  /** How to start the BetterCodex app installed on this machine, recorded when it registers. */
  app: path.join(BC_HOME, 'app.json'),
  /** Scheduled tasks and their recent runs. */
  schedules: path.join(BC_HOME, 'schedules.json'),
  /** Per-task folders holding the memory file new-thread runs keep between runs. */
  tasks: path.join(BC_HOME, 'tasks'),
};

export function ensureDirs() {
  for (const dir of [paths.home, paths.profile, paths.downloads, paths.uploads, paths.screenshots]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

export const defaultConfig: HostConfig = {
  browser: { engine: 'auto', mode: 'auto', executablePath: '', deviceScaleFactor: 1, jpegQuality: 75 },
  codex: { path: '', disableOfficialBrowser: true },
};

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/** Atomic write so a crash never leaves a half-written file behind. */
export function writeJson(file: string, value: unknown, mode = 0o600) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode });
  fs.renameSync(tmp, file);
}

export function loadConfig(): HostConfig {
  const stored = readJson<Partial<HostConfig>>(paths.config, {});
  return {
    browser: { ...defaultConfig.browser, ...(stored.browser ?? {}) },
    codex: { ...defaultConfig.codex, ...(stored.codex ?? {}) },
  };
}

export function saveConfig(config: HostConfig) {
  writeJson(paths.config, config);
}

interface Secrets {
  clientToken: string;
  mcpToken: string;
}

/** Tokens survive restarts so already-loaded Codex threads keep a working MCP endpoint. */
export function loadSecrets(): Secrets {
  const existing = readJson<Partial<Secrets>>(paths.secrets, {});
  if (existing.clientToken && existing.mcpToken) return existing as Secrets;
  const secrets = {
    clientToken: crypto.randomBytes(24).toString('base64url'),
    mcpToken: crypto.randomBytes(24).toString('base64url'),
  };
  writeJson(paths.secrets, secrets);
  return secrets;
}

export function readRuntimeInfo(): HostRuntimeInfo | null {
  return readJson<HostRuntimeInfo | null>(paths.runtime, null);
}

export function isPidAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
