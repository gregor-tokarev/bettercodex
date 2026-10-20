// Typed access to the API exposed by the Electron preload script.

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
  openExternal(url: string): Promise<void>;
  appInfo(): Promise<{ platform: string; version: string }>;
}

declare global {
  interface Window {
    bc: Bridge;
  }
}

export const bc: Bridge = window.bc;
export const isMac = navigator.platform.toLowerCase().includes('mac');
