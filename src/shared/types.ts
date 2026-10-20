// Wire types shared by the host daemon, the Electron main process and the renderer.

import type { ScheduleSpec } from './schedule.js';

declare const __BUILD_ID__: string | undefined;

/** Includes a hash of the host sources so clients redeploy/restart hosts after any change. */
export const HOST_VERSION = `0.1.0+${typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'dev'}`;
export const WS_SUBPROTOCOL = 'bettercodex.v1';
export const DEFAULT_HOST_PORT = 47821;

/** Written by a running host to ~/.bettercodex/host.json. */
export interface HostRuntimeInfo {
  pid: number;
  port: number;
  token: string;
  version: string;
  startedAt: number;
}

export type BrowserMode = 'auto' | 'headless' | 'headful';

/**
 * Which browser holds the machine's tabs: the BetterCodex app itself (native views, used when the
 * app is installed on that machine) or a Chromium the host starts and streams to clients.
 */
export type BrowserEngine = 'auto' | 'app' | 'chromium';

export interface HostConfig {
  browser: {
    engine: BrowserEngine;
    /** How the host-run Chromium is started (engine "chromium"). */
    mode: BrowserMode;
    /** Explicit Chrome/Chromium binary. Empty = auto-detect. */
    executablePath: string;
    deviceScaleFactor: number;
    jpegQuality: number;
  };
  codex: {
    /** Explicit codex binary. Empty = auto-detect. */
    path: string;
    /** Hide the official Codex browser / computer-use plugins inside BetterCodex threads. */
    disableOfficialBrowser: boolean;
  };
}

export interface HostInfo {
  hostname: string;
  platform: NodeJS.Platform;
  arch: string;
  homedir: string;
  version: string;
  codex: { status: 'starting' | 'ready' | 'error' | 'stopped'; path: string | null; version: string | null; error: string | null; userAgent: string | null };
  browser: BrowserStatus;
  config: HostConfig;
}

export interface BrowserStatus {
  state: 'idle' | 'launching' | 'running' | 'error';
  engine?: 'app' | 'chromium' | null;
  /** The BetterCodex app process whose window can show the tabs natively (engine "app"). */
  appInstanceId?: string | null;
  executablePath: string | null;
  mode: 'headless' | 'headful' | 'app' | null;
  version: string | null;
  error: string | null;
  profileDir: string;
  /** Whether Chromium's own process sandbox is active. */
  sandboxed?: boolean;
}

export interface TabInfo {
  id: string;
  threadId: string | null;
  url: string;
  title: string;
  faviconUrl: string | null;
  loading: boolean;
  /** No live page; it is recreated from `url` when someone looks at it. */
  sleeping: boolean;
  createdBy: 'user' | 'agent' | 'page';
  createdAt: number;
  lastActiveAt: number;
  /** Set while an agent tool call is acting on the tab. */
  agentActive: boolean;
  dialog: TabDialog | null;
  /** DevTools target of the live page; the app uses it to show the tab natively (engine "app"). */
  targetId?: string | null;
}

export interface TabDialog {
  type: 'alert' | 'confirm' | 'prompt' | 'beforeunload';
  message: string;
  defaultValue: string;
}

export interface DownloadInfo {
  id: string;
  tabId: string | null;
  threadId: string | null;
  url: string;
  filename: string;
  path: string;
  state: 'inProgress' | 'completed' | 'failed';
  error: string | null;
  createdAt: number;
}

/** How a BetterCodex app offers itself as the machine's browser (POST /app-browser). */
export interface AppBrowserRegistration {
  /** CDP endpoint of the app's tab bridge, including its secret path. */
  url: string;
  instanceId: string;
  pid: number;
  /** Command that starts the app again, used to bring it back in the background. */
  launch: { exec: string; args: string[] };
  background: boolean;
  /** Whether Chromium's process sandbox protects the tab pages (off when started with --no-sandbox). */
  sandboxed?: boolean;
}

// ---- scheduled tasks ----

/** Permissions of a scheduled run, like the composer's: read only, default (workspace write) or full access. */
export type TaskAccess = 'read-only' | 'auto' | 'full';

export type TaskTarget =
  /** Sends the prompt to an existing thread, which keeps its context and settings. */
  | { type: 'thread'; threadId: string }
  /** Starts a fresh thread in `cwd` for every run. */
  | { type: 'newThread'; cwd: string };

/** The agent thread that created or last changed a task; null when the user did it in the app. */
export interface TaskActor {
  /** Hostname, for people. */
  machine: string;
  /** Stable id of the agent's BetterCodex host. */
  machineId: string;
  threadId: string;
  sandboxMode: string | null;
}

/** What a thread may do: its sandbox level, network access and the folders it can write. */
export interface TaskPermissions {
  level: TaskAccess;
  network: boolean;
  roots: string[];
}

/** The permissions of the agent thread that last set a task's prompt or destination. */
export type TaskGrant = TaskPermissions & { machineId: string; threadId: string };

export interface ScheduledTask {
  id: string;
  name: string;
  prompt: string;
  schedule: ScheduleSpec;
  target: TaskTarget;
  /** New-thread runs; null uses the machine's Codex defaults. */
  model: string | null;
  effort: string | null;
  /** New-thread runs get these permissions; for a thread target, the thread's own when the task was made. */
  access: TaskAccess;
  status: 'active' | 'paused' | 'completed';
  nextRunAt: number | null;
  lastRunAt: number | null;
  createdAt: number;
  updatedAt: number;
  createdBy: TaskActor | null;
  /** Messages into another thread must stay within this; null when the user set the prompt and destination. */
  grant: TaskGrant | null;
}

export interface ScheduledRun {
  id: string;
  taskId: string;
  taskName: string;
  trigger: 'schedule' | 'manual';
  scheduledFor: number;
  startedAt: number | null;
  finishedAt: number | null;
  /** waiting = the target thread is busy; the message goes in once its turn ends. */
  status: 'waiting' | 'running' | 'completed' | 'failed' | 'interrupted';
  threadId: string | null;
  turnId: string | null;
  /** The run's last agent message. */
  summary: string | null;
  error: string | null;
  read: boolean;
}

/** Everything the app shows for one machine's schedule (`schedule/list`, `schedule/changed`). */
export interface ScheduleSnapshot {
  hostname: string;
  timezone: string;
  now: number;
  tasks: ScheduledTask[];
  runs: ScheduledRun[];
}

/**
 * A host asks the app to reach the other machines it is connected to, so agents can manage
 * tasks everywhere. `current` marks the machine that asked.
 */
export type RelayRequest = { op: 'machines' } | { op: 'call'; machine: string; method: string; params: unknown };

export interface RelayMachine {
  name: string;
  hostname: string | null;
  type: 'local' | 'ssh';
  connected: boolean;
  current: boolean;
}

// ---- main websocket (/ws): JSON text frames ----

export type ClientMessage =
  | { t: 'rpc'; id: number; method: string; params?: unknown }
  | { t: 'reqres'; id: string | number; result?: unknown; error?: { code: number; message: string } }
  /** The client can relay requests to the other machines it is connected to. */
  | { t: 'relay-ready' }
  | { t: 'relayres'; id: number; result?: unknown; error?: { code: number; message: string } };

export type HostMessage =
  | { t: 'res'; id: number; result?: unknown; error?: { code: number; message: string; data?: unknown } }
  | { t: 'notif'; method: string; params: unknown }
  | { t: 'req'; id: string | number; method: string; params: unknown }
  | { t: 'relay'; id: number; request: RelayRequest };

// ---- browser stream websocket (/stream) ----

export type StreamClientMessage =
  | { t: 'attach'; tabId: string; width: number; height: number }
  | { t: 'detach' }
  | { t: 'resize'; width: number; height: number }
  | {
      t: 'mouse';
      type: 'mousePressed' | 'mouseReleased' | 'mouseMoved' | 'mouseWheel';
      x: number;
      y: number;
      button?: 'none' | 'left' | 'middle' | 'right' | 'back' | 'forward';
      buttons?: number;
      clickCount?: number;
      modifiers?: number;
      deltaX?: number;
      deltaY?: number;
    }
  | { t: 'key'; type: 'down' | 'up'; key: string; code: string }
  | { t: 'text'; text: string }
  | { t: 'copy'; cut?: boolean };

/** Binary frames are: u32 header length (LE) + JSON FrameHeader + JPEG bytes. */
export interface FrameHeader {
  tabId: string;
  /** Size of the page viewport in CSS pixels the frame represents. */
  cssWidth: number;
  cssHeight: number;
  /** Encoded image size. */
  width: number;
  height: number;
  seq: number;
}

export type StreamHostMessage =
  | { t: 'attached'; tabId: string }
  | { t: 'cursor'; cursor: string }
  | { t: 'clipboard'; text: string }
  | { t: 'error'; message: string };

/** The app's self-update, as shown in the renderer. */
export interface UpdateStatus {
  /** This build's release name, e.g. v0.0.1-660c757e94 (the bare version for builds made outside CI). */
  current: string;
  /**
   * How this copy updates: in place (the .app on macOS, the AppImage on Linux), from the release page
   * (a .deb install, a quarantined Mac app) or not at all (development builds, builds made outside CI).
   */
  mode: 'inPlace' | 'manual' | 'off';
  /** Why the copy cannot update in place. */
  note: string | null;
  /** `ready`: downloaded and unpacked, waiting for the restart that puts it in place. */
  state: 'idle' | 'checking' | 'downloading' | 'installing' | 'ready';
  /** A newer release than this build, if there is one. */
  available: { name: string; url: string; compareUrl: string | null; publishedAt: string } | null;
  /** Downloaded fraction while downloading. */
  progress: number | null;
  /** The last failed check. */
  error: string | null;
  /** The last failed install, including one that rolled back after a restart. */
  installError: string | null;
  checkedAt: number | null;
}

/** A page view the app shows: a tab of its own browser, or a synced copy of another machine's tab. */
export type PageViewRef = { targetId: string } | { hostId: string; tabId: string };

/** Search suggestions for what is typed in the address bar. */
export interface Suggestions {
  queries: string[];
  links: Array<{ url: string; title: string }>;
}
