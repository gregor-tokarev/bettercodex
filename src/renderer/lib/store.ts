import { useRef, useSyncExternalStore } from 'react';
import type { ScheduleInput } from '../../shared/schedule';
import type {
  DownloadInfo,
  HostInfo,
  HostMessage,
  RelayMachine,
  RelayRequest,
  ScheduledRun,
  ScheduledTask,
  ScheduleSnapshot,
  TabInfo,
  TaskAccess,
  UpdateStatus,
} from '../../shared/types';
import type { Model } from '../../shared/codex-protocol/v2/Model';
import type { Thread } from '../../shared/codex-protocol/v2/Thread';
import type { ThreadItem } from '../../shared/codex-protocol/v2/ThreadItem';
import type { Turn } from '../../shared/codex-protocol/v2/Turn';
import type { ThreadTokenUsage } from '../../shared/codex-protocol/v2/ThreadTokenUsage';
import type { TurnPlanStep } from '../../shared/codex-protocol/v2/TurnPlanStep';
import type { UserInput } from '../../shared/codex-protocol/v2/UserInput';
import { bc, type HostListEntry, type HostStatus } from './bridge';
import { HostConnection, type RpcFailure } from './connection';
import { noteTabs } from './history';

export type AccessMode = 'read-only' | 'auto' | 'full';

export interface ServerReq {
  id: string | number;
  method: string;
  params: any;
}

export interface HostView {
  id: string;
  name: string;
  type: 'local' | 'ssh';
  target?: string;
  nodePath?: string;
  status: HostStatus;
  info: HostInfo | null;
  models: Model[];
  /** Model and effort from the host's Codex config.toml, used for new threads. */
  defaults: { model: string | null; effort: string | null };
  threads: Thread[];
  threadsLoaded: boolean;
  /** Cursor for older threads beyond the loaded pages. */
  threadsCursor: string | null;
  loadedOlderThreads: boolean;
  tabs: TabInfo[];
  requests: ServerReq[];
  downloads: DownloadInfo[];
  /** Scheduled tasks and recent runs on this machine. */
  schedule: ScheduleSnapshot | null;
  /** This computer's clock minus the machine's, for "in 5 min" labels. */
  clockSkew: number;
}

export interface TurnView {
  id: string;
  status: Turn['status'];
  items: ThreadItem[];
  startedAt: number | null;
  completedAt: number | null;
  durationMs: number | null;
  error: string | null;
}

export interface ThreadView {
  hostId: string;
  threadId: string;
  turns: TurnView[];
  olderCursor: string | null;
  loading: boolean;
  loadingOlder: boolean;
  error: string | null;
  activeTurnId: string | null;
  /** Stop was pressed and the running turn has not ended yet. */
  stopping: boolean;
  plan: { explanation: string | null; steps: TurnPlanStep[] } | null;
  tokenUsage: ThreadTokenUsage | null;
  retrying: string | null;
  resumed: boolean;
}

export interface Prefs {
  model: string | null;
  effort: string | null;
  access: AccessMode;
  browserOpen: boolean;
  browserWidth: number;
  sidebarWidth: number;
  autoOpenBrowser: boolean;
  /** Tabs of other machines: a synced copy rendered here, or a live stream of that machine's screen. */
  remoteTabs: 'sync' | 'stream';
  theme: 'system' | 'dark' | 'light';
  /** Last project folder per host. */
  cwd: Record<string, string>;
  collapsedProjects: Record<string, boolean>;
}

export interface Selection {
  hostId: string;
  /** null = composing a new thread */
  threadId: string | null;
}

/** What the task editor opens with: an existing task, or a new one with some fields filled in. */
export interface TaskDraft {
  hostId: string;
  taskId: string | null;
  prompt?: string;
  threadId?: string | null;
  /** Called once the editor has saved the task. */
  onSaved?: () => void;
}

export interface AppState {
  hosts: Record<string, HostView>;
  hostOrder: string[];
  selection: Selection | null;
  /** The main area shows the selected thread or the scheduled tasks of all machines. */
  view: 'thread' | 'scheduled';
  taskDraft: TaskDraft | null;
  threads: Record<string, ThreadView>;
  /** Per-thread composer overrides (model/effort/access). */
  threadSettings: Record<string, { model?: string | null; effort?: string | null; access?: AccessMode }>;
  /** Tab selected in the browser panel, per thread key (or `${hostId}:draft`). */
  browserTab: Record<string, string>;
  /** Tabs opened while composing a new thread; they move into the thread once it exists. */
  draftTabs: Record<string, string[]>;
  prefs: Prefs;
  settingsOpen: boolean;
  toast: string | null;
  /** This app process; a host whose browser is this app shows its tabs natively. */
  appInstanceId: string | null;
  update: UpdateStatus | null;
}

const PREFS_KEY = 'bettercodex.prefs';
const defaultPrefs: Prefs = {
  model: null,
  effort: null,
  access: 'auto',
  browserOpen: false,
  browserWidth: 620,
  sidebarWidth: 280,
  autoOpenBrowser: true,
  remoteTabs: 'sync',
  theme: 'system',
  cwd: {},
  collapsedProjects: {},
};

function loadPrefs(): Prefs {
  try {
    return { ...defaultPrefs, ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') };
  } catch {
    return defaultPrefs;
  }
}

// ---------- tiny store ----------

type Listener = () => void;
let state: AppState = {
  hosts: {},
  hostOrder: [],
  selection: null,
  view: 'thread',
  taskDraft: null,
  threads: {},
  threadSettings: {},
  browserTab: {},
  draftTabs: {},
  prefs: loadPrefs(),
  settingsOpen: false,
  toast: null,
  appInstanceId: null,
  update: null,
};
const listeners = new Set<Listener>();

export function getState() {
  return state;
}

export function setState(update: Partial<AppState> | ((s: AppState) => Partial<AppState>)) {
  const patch = typeof update === 'function' ? update(state) : update;
  state = { ...state, ...patch };
  if (patch.prefs) localStorage.setItem(PREFS_KEY, JSON.stringify(state.prefs));
  for (const l of listeners) l();
}

export function subscribe(l: Listener) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useStore<T>(selector: (s: AppState) => T, equal: (a: T, b: T) => boolean = Object.is): T {
  const last = useRef<{ value: T } | null>(null);
  return useSyncExternalStore(subscribe, () => {
    const next = selector(state);
    if (last.current && equal(last.current.value, next)) return last.current.value;
    last.current = { value: next };
    return next;
  });
}

export const shallowArray = <T,>(a: T[], b: T[]) => a.length === b.length && a.every((v, i) => v === b[i]);

/** SSH machines use the name the user gave them; the local one shows its hostname. */
export function hostLabel(h: Pick<HostView, 'type' | 'name' | 'info'> | null | undefined) {
  if (!h) return 'No machine';
  return h.type === 'ssh' ? h.name : (h.info?.hostname ?? h.name);
}

export function threadKey(hostId: string, threadId: string) {
  return `${hostId}:${threadId}`;
}

function updateHost(hostId: string, fn: (h: HostView) => Partial<HostView>) {
  setState((s) => {
    const host = s.hosts[hostId];
    if (!host) return {};
    return { hosts: { ...s.hosts, [hostId]: { ...host, ...fn(host) } } };
  });
}

function updateThread(key: string, fn: (t: ThreadView) => Partial<ThreadView>) {
  setState((s) => {
    const tv = s.threads[key];
    if (!tv) return {};
    return { threads: { ...s.threads, [key]: { ...tv, ...fn(tv) } } };
  });
}

export function setPrefs(patch: Partial<Prefs>) {
  setState((s) => ({ prefs: { ...s.prefs, ...patch } }));
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function toast(message: string) {
  setState({ toast: message });
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => setState({ toast: null }), 5000);
}

const ipcMessage = (err: Error) => err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

/**
 * Downloads the available update and restarts into it. Codex may have started working during the
 * download, and a newer host restarts it, so that is checked right before the restart.
 */
export async function installUpdate() {
  try {
    const update = state.update?.state === 'ready' ? state.update : await bc.updates.install();
    if (update.state !== 'ready') return;
    const working =
      Object.values(state.threads).some((t) => t.activeTurnId) || Object.values(state.hosts).some((h) => h.threads.some((t) => t.status.type === 'active'));
    if (working && !window.confirm('Codex is still working in a thread, and updating may stop it. Restart BetterCodex now?')) return;
    await bc.updates.restart();
  } catch (err) {
    toast(ipcMessage(err as Error));
  }
}

// ---------- connections ----------

export const connections = new Map<string, HostConnection>();
const pendingEvents = new Map<string, HostMessage[]>();

export function conn(hostId: string) {
  return connections.get(hostId) ?? null;
}

function hostViewFrom(entry: HostListEntry, prev?: HostView): HostView {
  return {
    id: entry.id,
    name: entry.name,
    type: entry.type,
    target: entry.target,
    nodePath: entry.nodePath,
    status: entry.status,
    info: prev?.info ?? null,
    models: prev?.models ?? [],
    defaults: prev?.defaults ?? { model: null, effort: null },
    threads: prev?.threads ?? [],
    threadsLoaded: prev?.threadsLoaded ?? false,
    threadsCursor: prev?.threadsCursor ?? null,
    loadedOlderThreads: prev?.loadedOlderThreads ?? false,
    tabs: prev?.tabs ?? [],
    requests: prev?.requests ?? [],
    downloads: prev?.downloads ?? [],
    schedule: prev?.schedule ?? null,
    clockSkew: prev?.clockSkew ?? 0,
  };
}

export async function initApp() {
  void bc.appInfo().then((info) => setState({ appInstanceId: info.instanceId }));
  void bc.updates.status().then((update) => {
    setState({ update });
    // An update that rolled back after the last restart.
    if (update.installError) toast(update.installError);
  });
  bc.updates.onStatus((update) => setState({ update }));
  const list = await bc.hosts.list();
  applyHostList(list);
  bc.hosts.onChanged(applyHostList);
  bc.hosts.onStatus((status) => {
    updateHost(status.id, () => ({ status }));
    if (status.state === 'connected' && !connections.has(status.id)) void attach(status.id, status);
  });
  for (const entry of list) void connectHost(entry.id);
  const first = list[0]?.id;
  if (first && !state.selection) setState({ selection: { hostId: first, threadId: null } });
}

function applyHostList(list: HostListEntry[]) {
  setState((s) => {
    const hosts: Record<string, HostView> = {};
    for (const entry of list) hosts[entry.id] = hostViewFrom(entry, s.hosts[entry.id]);
    return { hosts, hostOrder: list.map((h) => h.id) };
  });
}

export async function connectHost(hostId: string) {
  const status = await bc.hosts.connect(hostId);
  if (status.state === 'connected') await attach(hostId, status);
}

let reconnecting = new Set<string>();

async function attach(hostId: string, status: HostStatus) {
  if (!status.endpoint) return;
  const existing = connections.get(hostId);
  if (existing && existing.port === status.endpoint.port && existing.state !== 'closed') return;
  existing?.close();
  const c = new HostConnection(hostId, status.endpoint.port, status.endpoint.token);
  connections.set(hostId, c);
  c.onMessage((msg) => onHostMessage(hostId, msg));
  c.onClose(() => void reconnect(hostId));
  try {
    await c.open();
  } catch {
    connections.delete(hostId);
    void reconnect(hostId);
    return;
  }
  // Agents on this machine can reach the other machines' scheduled tasks through us.
  c.send({ t: 'relay-ready' });
  // Threads that were open before a reconnect may have missed events; reload them.
  for (const tv of Object.values(state.threads)) {
    if (tv.hostId === hostId && !tv.loading) void loadThread(hostId, tv.threadId, true);
  }
  void refreshSchedule(hostId);
  void refreshModels(hostId);
  void refreshThreads(hostId).then(() => refreshThreads(hostId, true));
}

async function reconnect(hostId: string) {
  if (reconnecting.has(hostId)) return;
  reconnecting.add(hostId);
  connections.delete(hostId);
  try {
    for (let delay = 500; ; delay = Math.min(delay * 2, 10000)) {
      await new Promise((r) => setTimeout(r, delay));
      if (!state.hosts[hostId]) return;
      try {
        const status = await bc.hosts.verify(hostId);
        if (status.state === 'connected') {
          await attach(hostId, status);
          if (connections.get(hostId)?.state === 'open') return;
        }
      } catch {
        // retry
      }
    }
  } finally {
    reconnecting.delete(hostId);
  }
}

export async function refreshModels(hostId: string) {
  const c = conn(hostId);
  if (!c) return;
  try {
    const res = await c.rpc<{ data: Model[] }>('model/list', { limit: 100 });
    updateHost(hostId, () => ({ models: res.data }));
    const cfg = await c.rpc<{ config: { model?: string | null; model_reasoning_effort?: string | null } }>('config/read', {});
    updateHost(hostId, () => ({ defaults: { model: cfg.config.model ?? null, effort: cfg.config.model_reasoning_effort ?? null } }));
  } catch {
    // codex may still be starting; host/info will trigger another refresh
  }
}

/** `full` lets Codex rescan session files (slow); routine refreshes read its index only. */
export async function refreshThreads(hostId: string, full = false) {
  const c = conn(hostId);
  if (!c) return;
  try {
    const res = await c.rpc<{ data: Thread[]; nextCursor: string | null }>('thread/list', {
      limit: 200,
      sortKey: 'updated_at',
      modelProviders: [],
      useStateDbOnly: !full,
    });
    updateHost(hostId, (h) => {
      // Keep threads known locally that the first page does not cover (just started, or older pages).
      const ids = new Set(res.data.map((t) => t.id));
      const rest = h.threads.filter((t) => !ids.has(t.id));
      return { threads: [...res.data, ...rest], threadsLoaded: true, threadsCursor: h.loadedOlderThreads ? h.threadsCursor : res.nextCursor };
    });
  } catch {
    // ignore; retried on next event
  }
}

export async function loadMoreThreads(hostId: string) {
  const c = conn(hostId);
  const cursor = state.hosts[hostId]?.threadsCursor;
  if (!c || !cursor) return;
  try {
    const res = await c.rpc<{ data: Thread[]; nextCursor: string | null }>('thread/list', { cursor, limit: 200, sortKey: 'updated_at', modelProviders: [], useStateDbOnly: true });
    updateHost(hostId, (h) => {
      const ids = new Set(h.threads.map((t) => t.id));
      return { threads: [...h.threads, ...res.data.filter((t) => !ids.has(t.id))], threadsCursor: res.nextCursor, loadedOlderThreads: true };
    });
  } catch (err) {
    toast((err as Error).message);
  }
}

/** Server-side title search, so threads beyond the loaded pages are found too. */
export async function searchThreads(hostId: string, term: string): Promise<Thread[]> {
  const c = conn(hostId);
  if (!c) return [];
  const res = await c.rpc<{ data: Thread[] }>('thread/list', { searchTerm: term, limit: 100, sortKey: 'updated_at', modelProviders: [], useStateDbOnly: true });
  return res.data;
}

let threadRefreshTimers: Record<string, ReturnType<typeof setTimeout>> = {};
function scheduleThreadRefresh(hostId: string, delay = 800) {
  clearTimeout(threadRefreshTimers[hostId]);
  threadRefreshTimers[hostId] = setTimeout(() => void refreshThreads(hostId), delay);
}

setInterval(() => {
  for (const id of state.hostOrder) if (conn(id)?.state === 'open') void refreshThreads(id);
}, 30000);

// ---------- events ----------

function onHostMessage(hostId: string, msg: HostMessage) {
  if (msg.t === 'relay') {
    void relay(hostId, msg.id, msg.request);
    return;
  }
  if (msg.t === 'req') {
    updateHost(hostId, (h) => ({ requests: [...h.requests.filter((r) => r.id !== msg.id), { id: msg.id, method: msg.method, params: msg.params }] }));
    return;
  }
  if (msg.t !== 'notif') return;
  const { method } = msg;
  const params = msg.params as any;
  switch (method) {
    case 'host/info': {
      const info = params as HostInfo;
      const prev = state.hosts[hostId]?.info;
      updateHost(hostId, () => ({ info }));
      if (info.codex.status === 'ready' && prev?.codex.status !== 'ready') {
        void refreshModels(hostId);
        void refreshThreads(hostId);
        // A restarted app-server forgot which threads were loaded and which turns were running.
        setState((s) => {
          const threads = { ...s.threads };
          for (const [k, tv] of Object.entries(threads)) if (tv.hostId === hostId) threads[k] = { ...tv, resumed: false, activeTurnId: null, stopping: false };
          return { threads };
        });
        for (const tv of Object.values(state.threads)) if (tv.hostId === hostId) void loadThread(hostId, tv.threadId, true);
      }
      return;
    }
    case 'browser/tabs': {
      const before = state.hosts[hostId]?.tabs ?? [];
      noteTabs(before, params.tabs);
      updateHost(hostId, () => ({ tabs: params.tabs }));
      maybeAutoOpenBrowser(hostId, params.tabs, before);
      return;
    }
    case 'browser/download':
      updateHost(hostId, (h) => ({ downloads: [params, ...h.downloads.filter((d) => d.id !== params.id)].slice(0, 50) }));
      if (params.state === 'completed') toast(`Downloaded ${params.filename} → ${params.path}`);
      return;
    case 'schedule/changed':
      setSchedule(hostId, params as ScheduleSnapshot);
      return;
    case 'browser/popup':
      if (params.threadId) setState((s) => ({ browserTab: { ...s.browserTab, [threadKey(hostId, params.threadId)]: params.tabId } }));
      return;
    case 'serverRequest/resolved':
      updateHost(hostId, (h) => ({ requests: h.requests.filter((r) => r.id !== params.requestId) }));
      return;
    case 'thread/started':
      if (params.thread) {
        updateHost(hostId, (h) => ({ threads: [params.thread, ...h.threads.filter((t) => t.id !== params.thread.id)] }));
      }
      return;
    case 'thread/status/changed':
      updateHost(hostId, (h) => ({ threads: h.threads.map((t) => (t.id === params.threadId ? { ...t, status: params.status } : t)) }));
      return;
    case 'thread/name/updated':
      updateHost(hostId, (h) => ({ threads: h.threads.map((t) => (t.id === params.threadId ? { ...t, name: params.threadName ?? null } : t)) }));
      return;
    case 'thread/archived':
    case 'thread/deleted':
      updateHost(hostId, (h) => ({ threads: h.threads.filter((t) => t.id !== params.threadId) }));
      return;
  }
  const threadId: string | undefined = params?.threadId;
  if (!threadId) return;
  const key = threadKey(hostId, threadId);
  const tv = state.threads[key];
  if (method === 'turn/completed') scheduleThreadRefresh(hostId);
  if (!tv) return;
  if (tv.loading) {
    const queue = pendingEvents.get(key) ?? [];
    queue.push(msg);
    pendingEvents.set(key, queue);
    return;
  }
  applyThreadEvent(key, method, params);
}

function upsertTurn(turns: TurnView[], turn: Partial<TurnView> & { id: string }): TurnView[] {
  const idx = turns.findIndex((t) => t.id === turn.id);
  if (idx === -1) {
    return [
      ...turns,
      { status: 'inProgress', items: [], startedAt: null, completedAt: null, durationMs: null, error: null, ...turn } as TurnView,
    ];
  }
  const next = turns.slice();
  next[idx] = { ...next[idx], ...turn };
  return next;
}

function mapItem(turns: TurnView[], turnId: string, itemId: string, fn: (item: any) => any): TurnView[] {
  return turns.map((t) => {
    if (t.id !== turnId) return t;
    const items = t.items.map((it) => (it.id === itemId ? fn(it) : it));
    return { ...t, items };
  });
}

function upsertItem(turns: TurnView[], turnId: string, item: ThreadItem): TurnView[] {
  let next = turns.some((t) => t.id === turnId) ? turns : upsertTurn(turns, { id: turnId });
  return next.map((t) => {
    if (t.id !== turnId) return t;
    let items = t.items;
    if (item.type === 'userMessage') items = items.filter((i) => !i.id.startsWith('local-'));
    const idx = items.findIndex((i) => i.id === item.id);
    if (idx === -1) items = [...items, item];
    else {
      items = items.slice();
      items[idx] = item;
    }
    return { ...t, items };
  });
}

function applyThreadEvent(key: string, method: string, p: any) {
  switch (method) {
    case 'turn/started':
      updateThread(key, (tv) => ({ turns: upsertTurn(tv.turns, turnFrom(p.turn, tv.turns)), activeTurnId: p.turn.id, stopping: false, retrying: null }));
      return;
    case 'turn/completed':
      updateThread(key, (tv) => ({
        turns: upsertTurn(tv.turns, turnFrom(p.turn, tv.turns)),
        activeTurnId: tv.activeTurnId === p.turn.id ? null : tv.activeTurnId,
        stopping: tv.activeTurnId === p.turn.id ? false : tv.stopping,
        retrying: null,
      }));
      return;
    case 'item/started':
    case 'item/completed':
      updateThread(key, (tv) => ({ turns: upsertItem(tv.turns, p.turnId, p.item) }));
      return;
    case 'item/agentMessage/delta':
      updateThread(key, (tv) => ({ turns: mapItem(tv.turns, p.turnId, p.itemId, (it) => ({ ...it, text: (it.text ?? '') + p.delta })) }));
      return;
    case 'item/plan/delta':
      updateThread(key, (tv) => ({ turns: mapItem(tv.turns, p.turnId, p.itemId, (it) => ({ ...it, text: (it.text ?? '') + p.delta })) }));
      return;
    case 'item/reasoning/summaryTextDelta':
      updateThread(key, (tv) => ({
        turns: mapItem(tv.turns, p.turnId, p.itemId, (it) => {
          const summary = [...(it.summary ?? [])];
          while (summary.length <= p.summaryIndex) summary.push('');
          summary[p.summaryIndex] += p.delta;
          return { ...it, summary };
        }),
      }));
      return;
    case 'item/reasoning/summaryPartAdded':
      return;
    case 'item/commandExecution/outputDelta':
      updateThread(key, (tv) => ({
        turns: mapItem(tv.turns, p.turnId, p.itemId, (it) => ({ ...it, aggregatedOutput: (it.aggregatedOutput ?? '') + p.delta })),
      }));
      return;
    case 'turn/plan/updated':
      updateThread(key, () => ({ plan: { explanation: p.explanation, steps: p.plan } }));
      return;
    case 'thread/tokenUsage/updated':
      updateThread(key, () => ({ tokenUsage: p.tokenUsage }));
      return;
    case 'error':
      if (p.willRetry) updateThread(key, () => ({ retrying: p.error?.message ?? 'Reconnecting…' }));
      else updateThread(key, (tv) => ({ turns: upsertTurn(tv.turns, { id: p.turnId, error: p.error?.message ?? 'Error' }), retrying: null }));
      return;
  }
}

function turnFrom(turn: Turn, existing: TurnView[]): Partial<TurnView> & { id: string } {
  const prev = existing.find((t) => t.id === turn.id);
  // Notifications carry only a summary of items; keep the ones streamed so far.
  const items = turn.itemsView === 'full' || !prev ? turn.items : mergeItems(prev.items, turn.items);
  return {
    id: turn.id,
    status: turn.status,
    items,
    startedAt: turn.startedAt,
    completedAt: turn.completedAt,
    durationMs: turn.durationMs,
    error: turn.error?.message ?? prev?.error ?? null,
  };
}

function mergeItems(prev: ThreadItem[], incoming: ThreadItem[]) {
  const out = prev.slice();
  for (const item of incoming) {
    const idx = out.findIndex((i) => i.id === item.id);
    if (idx === -1) out.push(item);
    else out[idx] = item;
  }
  return out;
}

// ---------- threads ----------

export async function openThread(hostId: string, threadId: string | null) {
  setState({ selection: { hostId, threadId }, view: 'thread' });
  if (threadId && !state.threads[threadKey(hostId, threadId)]) await loadThread(hostId, threadId);
}

export async function loadThread(hostId: string, threadId: string, reload = false) {
  const key = threadKey(hostId, threadId);
  const c = conn(hostId);
  const base: ThreadView = state.threads[key] ?? {
    hostId,
    threadId,
    turns: [],
    olderCursor: null,
    loading: true,
    loadingOlder: false,
    error: null,
    activeTurnId: null,
    stopping: false,
    plan: null,
    tokenUsage: null,
    retrying: null,
    resumed: false,
  };
  setState((s) => ({ threads: { ...s.threads, [key]: { ...base, loading: true, error: null } } }));
  if (!c) {
    updateThread(key, () => ({ loading: false, error: 'Host is not connected' }));
    return;
  }
  try {
    const res = await c.rpc<{ data: Turn[]; nextCursor: string | null }>('thread/turns/list', {
      threadId,
      limit: reload ? Math.max(base.turns.length, 20) : 20,
      sortDirection: 'desc',
      itemsView: 'full',
    });
    const turns = res.data.reverse().map((t) => turnFrom(t, []) as TurnView);
    const active = [...turns].reverse().find((t) => t.status === 'inProgress');
    updateThread(key, (cur) => ({ turns, olderCursor: res.nextCursor, loading: false, activeTurnId: active?.id ?? null, stopping: active ? cur.stopping : false }));
  } catch (err) {
    updateThread(key, () => ({ loading: false, error: (err as Error).message }));
  }
  const queued = pendingEvents.get(key) ?? [];
  pendingEvents.delete(key);
  for (const msg of queued) if (msg.t === 'notif') applyThreadEvent(key, msg.method, msg.params);
}

export async function loadOlderTurns(hostId: string, threadId: string) {
  const key = threadKey(hostId, threadId);
  const tv = state.threads[key];
  const c = conn(hostId);
  if (!tv || !tv.olderCursor || tv.loadingOlder || !c) return;
  updateThread(key, () => ({ loadingOlder: true }));
  try {
    const res = await c.rpc<{ data: Turn[]; nextCursor: string | null }>('thread/turns/list', {
      threadId,
      cursor: tv.olderCursor,
      limit: 20,
      sortDirection: 'desc',
      itemsView: 'full',
    });
    const older = res.data.reverse().map((t) => turnFrom(t, []) as TurnView);
    updateThread(key, (cur) => ({ turns: [...older.filter((o) => !cur.turns.some((t) => t.id === o.id)), ...cur.turns], olderCursor: res.nextCursor, loadingOlder: false }));
  } catch {
    updateThread(key, () => ({ loadingOlder: false }));
  }
}

export function accessParams(mode: AccessMode) {
  switch (mode) {
    case 'read-only':
      return { approvalPolicy: 'on-request', sandbox: 'read-only', sandboxPolicy: { type: 'readOnly', networkAccess: false } };
    case 'full':
      return { approvalPolicy: 'never', sandbox: 'danger-full-access', sandboxPolicy: { type: 'dangerFullAccess' } };
    default:
      return {
        approvalPolicy: 'on-request',
        sandbox: 'workspace-write',
        sandboxPolicy: { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
      };
  }
}

export function effectiveSettings(hostId: string, threadId: string | null) {
  const s = state;
  const host = s.hosts[hostId];
  const thread = threadId ? host?.threads.find((t) => t.id === threadId) : null;
  const overrides = threadId ? (s.threadSettings[threadKey(hostId, threadId)] ?? {}) : {};
  const models = host?.models ?? [];
  const fallbackModel = host?.defaults.model ?? models.find((m) => m.isDefault)?.model ?? models[0]?.model ?? null;
  let model = overrides.model ?? thread?.model ?? s.prefs.model ?? fallbackModel;
  if (models.length && !models.some((m) => m.model === model)) model = fallbackModel;
  const modelInfo = models.find((m) => m.model === model);
  let effort =
    overrides.effort ?? (thread ? thread.reasoningEffort : null) ?? s.prefs.effort ?? host?.defaults.effort ?? modelInfo?.defaultReasoningEffort ?? null;
  if (modelInfo && effort && !modelInfo.supportedReasoningEfforts.some((e) => e.reasoningEffort === effort)) effort = modelInfo.defaultReasoningEffort;
  const access = overrides.access ?? s.prefs.access;
  return { model, effort, access };
}

export function setComposerSetting(hostId: string, threadId: string | null, patch: { model?: string; effort?: string; access?: AccessMode }) {
  if (!threadId) {
    setPrefs(patch as Partial<Prefs>);
    return;
  }
  const key = threadKey(hostId, threadId);
  setState((s) => ({ threadSettings: { ...s.threadSettings, [key]: { ...s.threadSettings[key], ...patch } } }));
  // New threads follow the most recent choice too.
  setPrefs(patch as Partial<Prefs>);
}

export async function sendMessage(hostId: string, threadId: string | null, text: string, images: string[]): Promise<{ ok: boolean; threadId: string | null }> {
  const c = conn(hostId);
  if (!c) {
    toast('Host is not connected');
    return { ok: false, threadId };
  }
  const settings = effectiveSettings(hostId, threadId);
  const access = accessParams(settings.access);
  const input: UserInput[] = [];
  if (text.trim()) input.push({ type: 'text', text, text_elements: [] });
  for (const path of images) input.push({ type: 'localImage', path });
  if (!input.length) return { ok: true, threadId };
  try {
    if (!threadId) {
      const cwd = state.prefs.cwd[hostId] || state.hosts[hostId]?.info?.homedir || undefined;
      const res = await c.rpc('thread/start', {
        cwd,
        model: settings.model,
        approvalPolicy: access.approvalPolicy,
        sandbox: access.sandbox,
      });
      threadId = res.thread.id as string;
      const key = threadKey(hostId, threadId);
      const draftKey = `${hostId}:draft`;
      const draftTabs = state.draftTabs[draftKey] ?? [];
      setState((s) => ({
        threads: {
          ...s.threads,
          [key]: {
            hostId,
            threadId: threadId!,
            turns: [],
            olderCursor: null,
            loading: false,
            loadingOlder: false,
            error: null,
            activeTurnId: null,
            stopping: false,
            plan: null,
            tokenUsage: null,
            retrying: null,
            resumed: true,
          },
        },
        selection: { hostId, threadId: threadId! },
        draftTabs: { ...s.draftTabs, [draftKey]: [] },
        threadSettings: { ...s.threadSettings, [key]: { model: settings.model, effort: settings.effort, access: settings.access } },
        browserTab: s.browserTab[draftKey] ? { ...s.browserTab, [key]: s.browserTab[draftKey] } : s.browserTab,
      }));
      updateHost(hostId, (h) => ({ threads: [res.thread, ...h.threads.filter((t) => t.id !== res.thread.id)] }));
      for (const tabId of draftTabs) void c.rpc('browser/tabs/assign', { tabId, threadId }).catch(() => {});
    }
    const key = threadKey(hostId, threadId);
    const tv = state.threads[key];
    if (tv && !tv.resumed) {
      const resumed = await c.rpc<{ thread: Thread }>('thread/resume', { threadId, excludeTurns: true });
      // Trust the server about whether a turn is still running.
      updateThread(key, (cur) => ({ resumed: true, activeTurnId: resumed.thread.status.type === 'active' ? cur.activeTurnId : null }));
    }
    const active = state.threads[key]?.activeTurnId;
    if (active) {
      try {
        await c.rpc('turn/steer', { threadId, input, expectedTurnId: active });
        return { ok: true, threadId };
      } catch {
        // The turn ended meanwhile; start a new one instead.
        updateThread(key, () => ({ activeTurnId: null }));
      }
    }
    const res = await c.rpc<{ turn: Turn }>('turn/start', {
      threadId,
      input,
      model: settings.model,
      effort: settings.effort,
      approvalPolicy: access.approvalPolicy,
      sandboxPolicy: access.sandboxPolicy,
    });
    const local: ThreadItem = { type: 'userMessage', id: `local-${res.turn.id}`, clientId: null, content: input };
    updateThread(key, (cur) => {
      const existing = cur.turns.find((t) => t.id === res.turn.id);
      const hasUser = existing?.items.some((i) => i.type === 'userMessage');
      const turns = upsertTurn(cur.turns, { id: res.turn.id, status: 'inProgress', items: hasUser ? existing!.items : [local, ...(existing?.items ?? [])] });
      return { turns, activeTurnId: res.turn.id };
    });
    return { ok: true, threadId };
  } catch (err) {
    toast((err as Error).message);
    return { ok: false, threadId };
  }
}

export async function interrupt(hostId: string, threadId: string) {
  const key = threadKey(hostId, threadId);
  const tv = state.threads[key];
  const c = conn(hostId);
  if (!tv?.activeTurnId) return;
  if (!c) {
    toast('Host is not connected');
    return;
  }
  const shown = tv.activeTurnId;
  updateThread(key, () => ({ stopping: true }));
  try {
    // The host stops whichever turn Codex is running, even if it is not the one shown here.
    const res = await c.rpc<{ idle?: boolean; turnId?: string }>('turn/interrupt', { threadId, turnId: shown });
    // A turn started while this was on its way is not touched.
    if (state.threads[key]?.activeTurnId !== shown) return;
    if (res?.idle) await settleIdleThread(hostId, threadId, shown);
    else if (res?.turnId && res.turnId !== shown) {
      // Follow the turn that was actually stopped, so its end clears the working state.
      updateThread(key, (cur) => {
        if (cur.activeTurnId !== shown) return {};
        const ended = cur.turns.some((t) => t.id === res.turnId && t.status !== 'inProgress');
        return ended ? { activeTurnId: null, stopping: false } : { activeTurnId: res.turnId };
      });
    }
  } catch (err) {
    updateThread(key, () => ({ stopping: false }));
    toast((err as Error).message);
  }
}

/** Codex ran nothing in this thread when asked: show what it has and stop showing `stale` as running. */
async function settleIdleThread(hostId: string, threadId: string, stale: string) {
  const key = threadKey(hostId, threadId);
  await loadThread(hostId, threadId, true);
  updateThread(key, (tv) => ({
    // A turn that started since then keeps running.
    ...(tv.activeTurnId === stale ? { activeTurnId: null, stopping: false } : {}),
    turns: tv.turns.map((t) => (t.id === stale && t.status === 'inProgress' ? { ...t, status: 'interrupted' } : t)),
  }));
  void refreshThreads(hostId);
}

export function respondToRequest(hostId: string, req: ServerReq, result: unknown) {
  conn(hostId)?.respond(req.id, result);
  updateHost(hostId, (h) => ({ requests: h.requests.filter((r) => r.id !== req.id) }));
}

export function rejectRequest(hostId: string, req: ServerReq, message: string) {
  conn(hostId)?.respondError(req.id, message);
  updateHost(hostId, (h) => ({ requests: h.requests.filter((r) => r.id !== req.id) }));
}

export async function archiveThread(hostId: string, threadId: string) {
  try {
    await conn(hostId)?.rpc('thread/archive', { threadId });
    updateHost(hostId, (h) => ({ threads: h.threads.filter((t) => t.id !== threadId) }));
    if (state.selection?.threadId === threadId) setState({ selection: { hostId, threadId: null } });
  } catch (err) {
    toast((err as Error).message);
  }
}

export async function renameThread(hostId: string, threadId: string, name: string) {
  try {
    await conn(hostId)?.rpc('thread/name/set', { threadId, name });
    updateHost(hostId, (h) => ({ threads: h.threads.map((t) => (t.id === threadId ? { ...t, name } : t)) }));
  } catch (err) {
    toast((err as Error).message);
  }
}

// ---------- browser ----------

/** Shows the browser panel when Codex starts using or opens a tab in the thread on screen. */
function maybeAutoOpenBrowser(hostId: string, tabs: TabInfo[], before: TabInfo[]) {
  const sel = state.selection;
  if (!sel || sel.hostId !== hostId || !sel.threadId || !state.prefs.autoOpenBrowser) return;
  const known = new Set(before.map((t) => t.id));
  const active =
    tabs.find((t) => t.threadId === sel.threadId && t.agentActive) ??
    tabs.find((t) => t.threadId === sel.threadId && !known.has(t.id) && t.createdBy !== 'user');
  if (!active) return;
  const key = threadKey(hostId, sel.threadId);
  setState((s) => ({
    prefs: s.prefs.browserOpen ? s.prefs : { ...s.prefs, browserOpen: true },
    browserTab: s.browserTab[key] === active.id ? s.browserTab : { ...s.browserTab, [key]: active.id },
  }));
}

export function browserKey(sel: Selection) {
  return sel.threadId ? threadKey(sel.hostId, sel.threadId) : `${sel.hostId}:draft`;
}

export async function openTab(sel: Selection, url?: string) {
  const c = conn(sel.hostId);
  if (!c) return;
  try {
    const res = await c.rpc<{ tab: TabInfo }>('browser/tabs/new', { threadId: sel.threadId, url });
    const key = browserKey(sel);
    setState((s) => ({
      browserTab: { ...s.browserTab, [key]: res.tab.id },
      draftTabs: sel.threadId ? s.draftTabs : { ...s.draftTabs, [key]: [...(s.draftTabs[key] ?? []), res.tab.id] },
      prefs: { ...s.prefs, browserOpen: true },
    }));
  } catch (err) {
    toast((err as Error).message);
  }
}

// ---------- scheduled tasks ----------

function setSchedule(hostId: string, snapshot: ScheduleSnapshot) {
  updateHost(hostId, () => ({ schedule: snapshot, clockSkew: Date.now() - snapshot.now }));
}

export async function refreshSchedule(hostId: string) {
  try {
    const snapshot = await conn(hostId)?.rpc<ScheduleSnapshot>('schedule/list');
    if (snapshot) setSchedule(hostId, snapshot);
  } catch {
    // an older host without schedules; it is upgraded on the next connect
  }
}

/** What the editor sends; see TaskInput on the host. */
export interface TaskFields {
  name: string;
  prompt: string;
  /** Left out when editing keeps the schedule as it is. */
  schedule?: ScheduleInput;
  target: { type: 'thread'; threadId: string } | { type: 'newThread'; cwd: string };
  model: string | null;
  effort: string | null;
  access: TaskAccess;
}

export async function saveTask(hostId: string, taskId: string | null, fields: TaskFields): Promise<ScheduledTask | null> {
  const c = conn(hostId);
  if (!c) {
    toast('Machine is not connected');
    return null;
  }
  try {
    const res = taskId
      ? await c.rpc<{ task: ScheduledTask }>('schedule/update', { id: taskId, patch: fields })
      : await c.rpc<{ task: ScheduledTask }>('schedule/create', { task: fields });
    return res.task;
  } catch (err) {
    toast((err as Error).message);
    return null;
  }
}

async function scheduleCall(hostId: string, method: string, params: unknown) {
  try {
    await conn(hostId)?.rpc(method, params);
  } catch (err) {
    toast((err as Error).message);
  }
}

export const deleteTask = (hostId: string, id: string) => scheduleCall(hostId, 'schedule/delete', { id });
export const runTaskNow = (hostId: string, id: string) => scheduleCall(hostId, 'schedule/run', { id });
export const setTaskStatus = (hostId: string, id: string, status: 'active' | 'paused') => scheduleCall(hostId, 'schedule/update', { id, patch: { status } });
export const markRunsRead = (hostId: string, ids: string[] | 'all') => scheduleCall(hostId, 'schedule/read', ids === 'all' ? { all: true } : { ids });

export function openRun(hostId: string, run: ScheduledRun) {
  if (!run.read) void markRunsRead(hostId, [run.id]);
  if (run.threadId) void openThread(hostId, run.threadId);
}

/** Unread runs on all machines, for the sidebar badge. */
export function unreadRuns(s: AppState) {
  let n = 0;
  for (const id of s.hostOrder) n += s.hosts[id]?.schedule?.runs.filter((r) => !r.read && r.status !== 'running' && r.status !== 'waiting').length ?? 0;
  return n;
}

/** Finds the machine an agent means, by the name the app shows, its hostname or its SSH target. */
function resolveMachine(name: string): string {
  const wanted = name.trim().toLowerCase();
  const keys: Array<(h: HostView) => string | null | undefined> = [(h) => hostLabel(h), (h) => h.name, (h) => h.info?.hostname, (h) => h.target, (h) => h.id];
  for (const key of keys) {
    const hits = state.hostOrder.filter((id) => key(state.hosts[id])?.toLowerCase() === wanted);
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) throw new Error(`"${name}" matches several machines; use the SSH target or hostname instead`);
  }
  const known = state.hostOrder.map((id) => hostLabel(state.hosts[id])).join(', ');
  throw new Error(`No machine named "${name}" (machines: ${known})`);
}

/** Lets an agent on one machine manage scheduled tasks on the others through this app. */
async function relay(fromHostId: string, id: number, request: RelayRequest) {
  const from = conn(fromHostId);
  if (!from) return;
  try {
    let result: unknown;
    if (request.op === 'machines') {
      result = state.hostOrder.map(
        (hostId): RelayMachine => ({
          name: hostLabel(state.hosts[hostId]),
          hostname: state.hosts[hostId].info?.hostname ?? null,
          type: state.hosts[hostId].type,
          connected: conn(hostId)?.state === 'open',
          current: hostId === fromHostId,
        }),
      );
    } else {
      // Only scheduled tasks travel between machines; nothing else of the target's API.
      if (!request.method.startsWith('schedule/')) throw new Error(`${request.method} cannot be sent to another machine`);
      const target = resolveMachine(request.machine);
      const c = conn(target);
      if (!c || c.state !== 'open') throw new Error(`${hostLabel(state.hosts[target])} is not connected to the BetterCodex app right now`);
      result = await c.rpc(request.method, request.params);
    }
    from.send({ t: 'relayres', id, result });
  } catch (err) {
    from.send({ t: 'relayres', id, error: { code: (err as RpcFailure).code ?? -32000, message: (err as Error).message } });
  }
}
