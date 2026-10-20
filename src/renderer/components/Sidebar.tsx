import { useEffect, useMemo, useState } from 'react';
import type { Thread } from '../../shared/codex-protocol/v2/Thread';
import { isMac } from '../lib/bridge';
import { archiveThread, installUpdate, loadMoreThreads, openThread, searchThreads, setPrefs, setState, useStore } from '../lib/store';
import { HostSwitcher } from './HostSwitcher';
import { IconArchive, IconChevronDown, IconChevronRight, IconCompose, IconDownload, IconFolder, IconSearch, IconSettings, Spinner } from './Icons';

export function relativeTime(seconds: number) {
  const diff = Date.now() / 1000 - seconds;
  if (diff < 60) return 'now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d`;
  if (diff < 86400 * 30) return `${Math.floor(diff / (86400 * 7))}w`;
  return `${Math.floor(diff / (86400 * 30))}mo`;
}

export function threadTitle(t: Thread) {
  const raw = t.name || t.preview || 'New thread';
  return raw.split('\n')[0].slice(0, 120);
}

function projectName(cwd: string, home: string | undefined) {
  if (home && cwd === home) return '~';
  return cwd.split('/').filter(Boolean).pop() ?? cwd;
}

function UpdateButton() {
  const update = useStore((s) => s.update);
  if (!update?.available || update.mode === 'off') return null;
  const busy = update.state === 'downloading' || update.state === 'installing';
  const label =
    update.state === 'downloading'
      ? `Downloading update… ${Math.round((update.progress ?? 0) * 100)}%`
      : update.state === 'installing'
        ? 'Installing update…'
        : update.state === 'ready'
          ? 'Restart to update'
          : update.mode === 'manual'
            ? 'Download update'
            : 'Update and restart';
  return (
    <button className="sidebar-button update" disabled={busy} title={`${update.current} → ${update.available.name}`} onClick={() => void installUpdate()}>
      {busy ? <Spinner size={13} /> : <IconDownload size={15} />}
      {label}
    </button>
  );
}

export function Sidebar() {
  const selection = useStore((s) => s.selection);
  const hostId = selection?.hostId ?? null;
  const host = useStore((s) => (hostId ? s.hosts[hostId] : null));
  const collapsed = useStore((s) => s.prefs.collapsedProjects);
  const width = useStore((s) => s.prefs.sidebarWidth);
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<Thread[] | null>(null);

  // Titles are searched on the host too, so threads older than the loaded pages show up.
  useEffect(() => {
    const term = query.trim();
    if (!term || !hostId) {
      setFound(null);
      return;
    }
    const timer = setTimeout(() => {
      searchThreads(hostId, term)
        .then(setFound)
        .catch(() => setFound(null));
    }, 250);
    return () => clearTimeout(timer);
  }, [query, hostId]);

  const groups = useMemo(() => {
    if (!host) return [];
    const q = query.trim().toLowerCase();
    const pool = found ? [...found, ...host.threads.filter((t) => !found.some((f) => f.id === t.id))] : host.threads;
    const visible = pool.filter((t) => !t.parentThreadId && (!q || threadTitle(t).toLowerCase().includes(q) || t.cwd.toLowerCase().includes(q)));
    const byCwd = new Map<string, Thread[]>();
    for (const t of visible) {
      const list = byCwd.get(t.cwd) ?? [];
      list.push(t);
      byCwd.set(t.cwd, list);
    }
    const list = [...byCwd.entries()]
      .map(([cwd, threads]) => ({ cwd, label: projectName(cwd, host.info?.homedir), threads: threads.sort((a, b) => b.updatedAt - a.updatedAt) }))
      .sort((a, b) => b.threads[0].updatedAt - a.threads[0].updatedAt);
    // Folders that share a name get their parent folder as a hint.
    const counts = new Map<string, number>();
    for (const g of list) counts.set(g.label, (counts.get(g.label) ?? 0) + 1);
    for (const g of list) {
      if ((counts.get(g.label) ?? 0) > 1) g.label = g.cwd.split('/').filter(Boolean).slice(-2).join('/');
    }
    return list;
  }, [host, query, found]);

  return (
    <aside className="sidebar" style={{ width }}>
      <div className={`sidebar-top ${isMac ? 'mac' : ''}`}>
        <HostSwitcher />
      </div>
      <div className="sidebar-actions">
        <button className="sidebar-button" onClick={() => hostId && void openThread(hostId, null)}>
          <IconCompose size={15} />
          New thread
        </button>
        <label className="sidebar-search">
          <IconSearch size={14} />
          <input placeholder="Search threads" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
      </div>
      <div className="thread-groups">
        {host && !host.threadsLoaded && host.status.state === 'connected' && (
          <div className="sidebar-empty">
            <Spinner /> Loading threads…
          </div>
        )}
        {host && host.threadsLoaded && groups.length === 0 && <div className="sidebar-empty">{query ? 'No matching threads' : 'No threads yet'}</div>}
        {groups.map((g) => {
          const key = `${hostId}:${g.cwd}`;
          const isCollapsed = !!collapsed[key];
          return (
            <div key={g.cwd} className="thread-group">
              <button className="group-header" title={g.cwd} onClick={() => setPrefs({ collapsedProjects: { ...collapsed, [key]: !isCollapsed } })}>
                {isCollapsed ? <IconChevronRight size={12} /> : <IconChevronDown size={12} />}
                <IconFolder size={14} />
                <span className="group-name">{g.label}</span>
              </button>
              {!isCollapsed &&
                g.threads.map((t) => (
                  <div
                    key={t.id}
                    className={`thread-row ${selection?.threadId === t.id ? 'active' : ''}`}
                    onClick={() => hostId && void openThread(hostId, t.id)}
                    title={threadTitle(t)}
                  >
                    {t.status.type === 'active' ? <Spinner size={11} /> : null}
                    <span className="thread-title">{threadTitle(t)}</span>
                    <span className="thread-time">{relativeTime(t.updatedAt)}</span>
                    <button
                      className="thread-archive"
                      title="Archive thread"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (hostId) void archiveThread(hostId, t.id);
                      }}
                    >
                      <IconArchive size={13} />
                    </button>
                  </div>
                ))}
            </div>
          );
        })}
        {host?.threadsCursor && !query && (
          <button className="load-more" onClick={() => hostId && void loadMoreThreads(hostId)}>
            Show older threads
          </button>
        )}
      </div>
      <div className="sidebar-bottom">
        <UpdateButton />
        <button className="sidebar-button subtle" onClick={() => setState({ settingsOpen: true })}>
          <IconSettings size={15} />
          Settings
        </button>
      </div>
    </aside>
  );
}
