// Typed access to the API exposed by the Electron preload script.

import type { BrowserAction } from '../../shared/browserKeys';
import type { PageViewRef, Suggestions, UpdateStatus } from '../../shared/types';

export interface HostEntry {
  id: string;
  name: string;
  type: 'local' | 'ssh';
  target?: string;
  sshPort?: number;
  identityFile?: string;
  nodePath?: string;
}

export interface HostStatus {
  id: string;
  state: 'disconnected' | 'connecting' | 'connected' | 'error';
  message: string | null;
  endpoint: { port: number; token: string } | null;
}

export type HostListEntry = HostEntry & { status: HostStatus };

export interface ReplicaStatus {
  status: 'connecting' | 'loading' | 'synced' | 'syncing' | 'offline' | 'gone';
  error: string | null;
  pending: number;
  /** This machine cannot load the page (only the owning machine reaches it): it is streamed. */
  unreachable?: boolean;
}

interface Bridge {
  hosts: {
    list(): Promise<HostListEntry[]>;
    connect(id: string): Promise<HostStatus>;
    verify(id: string): Promise<HostStatus>;
    disconnect(id: string): Promise<void>;
    add(entry: Omit<HostEntry, 'id'>): Promise<HostEntry>;
    update(id: string, patch: Partial<HostEntry>): Promise<void>;
    remove(id: string): Promise<void>;
    onStatus(cb: (status: HostStatus) => void): () => void;
    onChanged(cb: (hosts: HostListEntry[]) => void): () => void;
  };
  clipboard: { read(): Promise<string>; write(text: string): Promise<void> };
  files: {
    pickAndUpload(hostId: string, opts: { multiple?: boolean; images?: boolean }): Promise<string[]>;
    upload(hostId: string, name: string, data: Uint8Array): Promise<string>;
    read(hostId: string, file: string): Promise<{ data: Uint8Array; mime: string }>;
  };
  appBrowser: {
    /** Shows a tab of this app's own browser over the window at `bounds` (CSS pixels), or hides it. */
    show(targetId: string | null, bounds: { x: number; y: number; width: number; height: number } | null): Promise<boolean>;
    capture(targetId: string): Promise<string | null>;
  };
  replica: {
    /** Shows this app's synced copy of another machine's tab over the window at `bounds`, or hides it. */
    show(hostId: string, tabId: string, bounds: { x: number; y: number; width: number; height: number } | null, sameMachine?: boolean): Promise<boolean>;
    capture(hostId: string, tabId: string): Promise<string | null>;
    reload(hostId: string, tabId: string): Promise<void>;
    status(hostId: string, tabId: string): Promise<ReplicaStatus | null>;
    onStatus(cb: (status: ReplicaStatus & { hostId: string; tabId: string }) => void): () => void;
  };
  updates: {
    status(): Promise<UpdateStatus>;
    check(): Promise<UpdateStatus>;
    /** Downloads and unpacks the update (or opens the download page when this copy cannot replace itself). */
    install(): Promise<UpdateStatus>;
    /** Quits and starts the downloaded update. */
    restart(): Promise<void>;
    onStatus(cb: (status: UpdateStatus) => void): () => void;
  };
  /** Find, zoom and focus in the page view the browser panel shows. */
  pageView: {
    /** Searches the page (`again`: goes to the next match of the same search); results arrive through `onFound`. */
    find(view: PageViewRef, text: string, opts: { forward?: boolean; again?: boolean }): Promise<number | null>;
    stopFind(view: PageViewRef): Promise<void>;
    /** Changes the zoom by `step` (0 resets it); without a step it only reports it. */
    zoom(view: PageViewRef, step?: 1 | -1 | 0): Promise<number>;
    focus(view: PageViewRef): Promise<void>;
    onFound(cb: (r: { requestId: number; matches: number; activeMatchOrdinal: number; finalUpdate: boolean }) => void): () => void;
    /** The page shown was zoomed with the keyboard. */
    onZoomed(cb: (e: { factor: number }) => void): () => void;
  };
  suggest(text: string): Promise<Suggestions>;
  /** Browser shortcuts pressed while a page view has the keyboard. */
  onBrowserAction(cb: (action: BrowserAction) => void): () => void;
  onShortcut(cb: (e: { key: string; shift: boolean }) => void): () => void;
  openExternal(url: string): Promise<void>;
  appInfo(): Promise<{ platform: string; version: string; instanceId: string }>;
}

declare global {
  interface Window {
    bc: Bridge;
  }
}

export const bc: Bridge = window.bc;
export const isMac = navigator.platform.toLowerCase().includes('mac');
