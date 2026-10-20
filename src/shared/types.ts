// Wire types shared by the host daemon, the Electron main process and the renderer.

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

export interface HostConfig {
  browser: {
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
  executablePath: string | null;
  mode: 'headless' | 'headful' | null;
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

// ---- main websocket (/ws): JSON text frames ----

export type ClientMessage =
  | { t: 'rpc'; id: number; method: string; params?: unknown }
  | { t: 'reqres'; id: string | number; result?: unknown; error?: { code: number; message: string } };

export type HostMessage =
  | { t: 'res'; id: number; result?: unknown; error?: { code: number; message: string; data?: unknown } }
  | { t: 'notif'; method: string; params: unknown }
  | { t: 'req'; id: string | number; method: string; params: unknown };

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
