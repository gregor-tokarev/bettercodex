import { useEffect, useMemo, useRef, useState } from 'react';
import type { TabInfo } from '../../shared/types';
import { bc, isMac } from '../lib/bridge';
import { browserKey, conn, hostLabel, openTab, setPrefs, setState, toast, useStore, type Selection } from '../lib/store';
import { BrowserViewport } from './BrowserViewport';
import { onlyReachableThere } from '../../shared/syncPage';
import { NativeViewport, ReplicaViewport, useReplicaStatus } from './NativeViewport';
import { IconArrowLeft, IconArrowRight, IconChevronDown, IconExternal, IconGlobe, IconPlus, IconRefresh, IconX, Spinner } from './Icons';

function Favicon({ tab }: { tab: TabInfo }) {
  const [failed, setFailed] = useState(false);
  if (tab.loading) return <Spinner size={12} />;
  if (!tab.faviconUrl || failed) return <IconGlobe size={13} />;
  return <img className="favicon" src={tab.faviconUrl} onError={() => setFailed(true)} />;
}

export function BrowserPanel({ selection }: { selection: Selection }) {
  const { hostId, threadId } = selection;
  const key = browserKey(selection);
  const host = useStore((s) => s.hosts[hostId]);
  const draftTabs = useStore((s) => s.draftTabs[key]);
  const selectedId = useStore((s) => s.browserTab[key]);
  const width = useStore((s) => s.prefs.browserWidth);
  const appInstanceId = useStore((s) => s.appInstanceId);
  const remoteTabs = useStore((s) => s.prefs.remoteTabs);
  const localName = useStore((s) => Object.values(s.hosts).find((h) => h.type === 'local')?.info?.hostname ?? null);
  const allTabs = host?.tabs ?? [];
  // The host's browser is this very app: show its tabs natively instead of streaming them.
  const native = !!appInstanceId && host?.info?.browser.engine === 'app' && host.info.browser.appInstanceId === appInstanceId;
  // Another machine's tabs: rendered here as synced copies (or streamed, if chosen in Settings).
  // Pages only that machine can reach (its localhost, its network) are streamed instead.
  const sameMachine = host?.type === 'local' || (!!localName && host?.info?.hostname === localName);
  const tabs = useMemo(
    () => (threadId ? allTabs.filter((t) => t.threadId === threadId) : allTabs.filter((t) => draftTabs?.includes(t.id))),
    [allTabs, threadId, draftTabs],
  );
  const current = tabs.find((t) => t.id === selectedId) ?? tabs[tabs.length - 1] ?? null;
  const synced = !native && remoteTabs !== 'stream' && !(current && !sameMachine && onlyReachableThere(current.url));
  const c = conn(hostId);
  const [url, setUrl] = useState('');
  const [editing, setEditing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const urlRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) setUrl(current?.url === 'about:blank' ? '' : (current?.url ?? ''));
  }, [current?.url, current?.id, editing]);

  // remember the tab the user is looking at as the thread's current tab for the agent too
  useEffect(() => {
    if (current && threadId) void c?.rpc('browser/tabs/select', { threadId, tabId: current.id }).catch(() => {});
  }, [current?.id, threadId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((isMac ? e.metaKey : e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        urlRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // file inputs clicked by the user in the remote page: pick local files and upload them
  useEffect(() => {
    if (!c) return;
    return c.onMessage((msg) => {
      if (msg.t !== 'notif' || msg.method !== 'browser/filechooser') return;
      const p = msg.params as { tabId: string; multiple: boolean; agentActive: boolean };
      if (p.agentActive || p.tabId !== current?.id) return;
      void (async () => {
        try {
          const paths = await bc.files.pickAndUpload(hostId, { multiple: p.multiple });
          await c.rpc('browser/filechooser/respond', { tabId: p.tabId, paths });
        } catch (err) {
          toast((err as Error).message);
        }
      })();
    });
  }, [c, current?.id, hostId]);

  const select = (tab: TabInfo) => setState((s) => ({ browserTab: { ...s.browserTab, [key]: tab.id } }));
  const navigate = (action: string, target?: string) => {
    if (!current) {
      if (target) void openTab(selection, target);
      return;
    }
    void c?.rpc('browser/tabs/navigate', { tabId: current.id, action, url: target }).catch((err) => toast(err.message));
  };

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const move = (ev: MouseEvent) => setPrefs({ browserWidth: Math.max(340, Math.min(window.innerWidth - 420, startW + (startX - ev.clientX))) });
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.classList.remove('resizing');
    };
    document.body.classList.add('resizing');
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const otherTabs = allTabs.filter((t) => !tabs.includes(t));

  return (
    <aside className="browser-panel" style={{ width }}>
      <div className="resize-handle" onMouseDown={startResize} />
      <div className="tab-strip">
        <div className="tab-list">
          {tabs.map((t) => (
            <div key={t.id} className={`tab ${current?.id === t.id ? 'active' : ''} ${t.agentActive ? 'agent' : ''}`} onClick={() => select(t)} title={`${t.title}\n${t.url}`}>
              <Favicon tab={t} />
              <span className="tab-title">{t.title || t.url || 'New tab'}</span>
              {t.agentActive && <span className="agent-dot" title="Codex is using this tab" />}
              <button
                className="tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  void c?.rpc('browser/tabs/close', { tabId: t.id });
                }}
              >
                <IconX size={11} />
              </button>
            </div>
          ))}
          <button className="icon-button" title="New tab" onClick={() => void openTab(selection)}>
            <IconPlus size={14} />
          </button>
        </div>
        <div className="spacer" />
        <div className="dropdown">
          <button className="icon-button" title="All tabs on this machine" onClick={() => setMenuOpen((o) => !o)}>
            <IconChevronDown size={14} />
          </button>
          {menuOpen && (
            <div className="popover down right tabs-popover" onMouseLeave={() => setMenuOpen(false)}>
              <div className="popover-header">Browser on {hostLabel(host)}</div>
              <div className="popover-note">
                {host?.info?.browser.state === 'running'
                  ? host.info.browser.engine === 'app'
                    ? `BetterCodex app${native ? ' · this window' : ''} · Chromium ${host.info.browser.version?.replace(/^\D+/, '') ?? ''}`
                    : `${host.info.browser.mode} · Chromium ${host.info.browser.version?.replace(/^\D+/, '') ?? ''}`
                  : (host?.info?.browser.error ?? host?.info?.browser.state)}
              </div>
              {otherTabs.length > 0 && <div className="popover-header">Tabs in other threads</div>}
              {otherTabs.map((t) => (
                <button
                  key={t.id}
                  className="popover-item"
                  title="Move this tab into the current thread"
                  onClick={() => {
                    setMenuOpen(false);
                    if (threadId) void c?.rpc('browser/tabs/assign', { tabId: t.id, threadId }).then(() => select(t));
                    else setState((s) => ({ draftTabs: { ...s.draftTabs, [key]: [...(s.draftTabs[key] ?? []), t.id] }, browserTab: { ...s.browserTab, [key]: t.id } }));
                  }}
                >
                  <span className="popover-item-text">
                    <span>{t.title || t.url}</span>
                    <span className="popover-item-desc">{t.url}</span>
                  </span>
                </button>
              ))}
              <button
                className="popover-item"
                onClick={() => {
                  setMenuOpen(false);
                  void c?.rpc('browser/restart').catch((err) => toast(err.message));
                }}
              >
                Restart browser
              </button>
            </div>
          )}
        </div>
        <button className="icon-button" title="Close panel" onClick={() => setPrefs({ browserOpen: false })}>
          <IconX size={14} />
        </button>
      </div>
      <div className="url-bar">
        <button className="icon-button" disabled={!current} onClick={() => navigate('back')}>
          <IconArrowLeft size={14} />
        </button>
        <button className="icon-button" disabled={!current} onClick={() => navigate('forward')}>
          <IconArrowRight size={14} />
        </button>
        <button className="icon-button" disabled={!current} onClick={() => navigate(current?.loading ? 'stop' : 'reload')}>
          {current?.loading ? <IconX size={14} /> : <IconRefresh size={14} />}
        </button>
        <form
          className="url-form"
          onSubmit={(e) => {
            e.preventDefault();
            setEditing(false);
            urlRef.current?.blur();
            if (url.trim()) navigate('goto', url.trim());
          }}
        >
          <input
            ref={urlRef}
            value={url}
            placeholder="Search or enter address"
            onFocus={(e) => {
              setEditing(true);
              e.currentTarget.select();
            }}
            onBlur={() => setEditing(false)}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setEditing(false);
                urlRef.current?.blur();
              }
            }}
          />
        </form>
        {current && synced && <SyncBadge hostId={hostId} tabId={current.id} hostName={hostLabel(host)} />}
        {current && /^https?:/.test(current.url) && (
          <button className="icon-button" title="Open in system browser" onClick={() => void bc.openExternal(current.url)}>
            <IconExternal size={14} />
          </button>
        )}
      </div>
      {current?.agentActive && <div className="agent-banner">Codex is using this tab</div>}
      {current?.dialog && (
        <DialogBar
          dialog={current.dialog}
          onRespond={(accept, text) => void c?.rpc('browser/dialog/respond', { tabId: current.id, accept, promptText: text }).catch((err) => toast(err.message))}
        />
      )}
      {current && c && native ? (
        <NativeViewport connection={c} tab={current} />
      ) : current && c && synced ? (
        <ReplicaViewport hostId={hostId} tab={current} hostName={hostLabel(host)} sameMachine={sameMachine} />
      ) : current && c ? (
        <BrowserViewport key={`${hostId}:${c.port}`} connection={c} tabId={current.id} hostPlatform={host?.info?.platform ?? 'linux'} onFocusUrl={() => urlRef.current?.focus()} />
      ) : (
        <div className="browser-empty">
          <IconGlobe size={28} />
          <div>No tabs in this {threadId ? 'thread' : 'draft'} yet.</div>
          <div className="muted">
            Type an address above, or ask Codex to browse. Pages run in the browser on <strong>{hostLabel(host)}</strong>, so its sign-ins are what Codex sees.
          </div>
        </div>
      )}
    </aside>
  );
}

const SYNC_LABELS: Record<string, string> = {
  connecting: 'Connecting',
  loading: 'Loading',
  synced: 'In sync',
  syncing: 'Sending changes',
  offline: 'Offline, changes are not sent',
  gone: 'Not open',
};

/** How this copy relates to the machine that owns the tab. */
function SyncBadge({ hostId, tabId, hostName }: { hostId: string; tabId: string; hostName: string }) {
  const status = useReplicaStatus(hostId, tabId);
  const state = status?.status ?? 'connecting';
  return <span className={`sync-badge ${state}`} title={`Copy of the tab on ${hostName}: ${SYNC_LABELS[state]}${status?.error ? ` (${status.error})` : ''}`} />;
}

function DialogBar({ dialog, onRespond }: { dialog: NonNullable<TabInfo['dialog']>; onRespond: (accept: boolean, text?: string) => void }) {
  const [text, setText] = useState(dialog.defaultValue);
  return (
    <div className="dialog-bar">
      <div className="dialog-message">
        <strong>{dialog.type === 'beforeunload' ? 'Leave page?' : 'Page says'}</strong> {dialog.message}
      </div>
      {dialog.type === 'prompt' && <input className="text-input" value={text} onChange={(e) => setText(e.target.value)} />}
      <div className="dialog-actions">
        {dialog.type !== 'alert' && (
          <button className="btn" onClick={() => onRespond(false)}>
            Cancel
          </button>
        )}
        <button className="btn primary" onClick={() => onRespond(true, text)}>
          OK
        </button>
      </div>
    </div>
  );
}
