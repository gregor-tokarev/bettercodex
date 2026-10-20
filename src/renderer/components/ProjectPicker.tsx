import { useEffect, useMemo, useState } from 'react';
import { conn, getState, setPrefs, toast, useStore } from '../lib/store';
import { IconArrowLeft, IconChevronDown, IconFolder, Spinner } from './Icons';

export function ProjectPicker({ hostId }: { hostId: string }) {
  const host = useStore((s) => s.hosts[hostId]);
  const cwd = useStore((s) => s.prefs.cwd[hostId]) || host?.info?.homedir || '';
  const [open, setOpen] = useState(false);
  const recent = useMemo(() => {
    const seen = new Set<string>();
    for (const t of host?.threads ?? []) if (!seen.has(t.cwd)) seen.add(t.cwd);
    return [...seen].slice(0, 8);
  }, [host?.threads]);
  const home = host?.info?.homedir ?? '';
  const pretty = (p: string) => (home && p.startsWith(home) ? `~${p.slice(home.length)}` : p);
  const choose = (path: string) => {
    setPrefs({ cwd: { ...getState().prefs.cwd, [hostId]: path } });
    setOpen(false);
  };

  return (
    <div className="project-picker">
      <button className="project-button" onClick={() => setOpen((o) => !o)}>
        <IconFolder size={14} />
        <span>{cwd ? pretty(cwd) : 'Choose a folder'}</span>
        <IconChevronDown size={12} />
      </button>
      {open && (
        <div className="project-panel">
          {recent.length > 0 && (
            <>
              <div className="popover-header">Recent</div>
              {recent.map((p) => (
                <button key={p} className="popover-item" onClick={() => choose(p)}>
                  <span className="popover-item-text">
                    <span>{p.split('/').pop() || p}</span>
                    <span className="popover-item-desc">{pretty(p)}</span>
                  </span>
                </button>
              ))}
            </>
          )}
          <div className="popover-header">Browse</div>
          <FolderBrowser hostId={hostId} start={cwd || home} onChoose={choose} />
        </div>
      )}
    </div>
  );
}

function FolderBrowser({ hostId, start, onChoose }: { hostId: string; start: string; onChoose: (path: string) => void }) {
  const [dir, setDir] = useState(start);
  const [listing, setListing] = useState<{ path: string; parent: string; entries: string[] } | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    conn(hostId)
      ?.rpc('host/listDir', { path: dir })
      .then((res) => alive && setListing(res))
      .catch((err) => toast(err.message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [hostId, dir]);

  return (
    <div className="folder-browser">
      <div className="folder-path">
        <button className="icon-button" disabled={!listing || listing.parent === listing.path} onClick={() => listing && setDir(listing.parent)}>
          <IconArrowLeft size={13} />
        </button>
        <span title={listing?.path}>{listing?.path ?? dir}</span>
        {loading && <Spinner size={11} />}
        <button className="btn primary small" disabled={!listing} onClick={() => listing && onChoose(listing.path)}>
          Use this folder
        </button>
      </div>
      <div className="folder-entries">
        {listing?.entries.map((name) => (
          <button key={name} className="folder-entry" onDoubleClick={() => onChoose(`${listing.path}/${name}`)} onClick={() => setDir(`${listing.path.replace(/\/$/, '')}/${name}`)}>
            <IconFolder size={13} /> {name}
          </button>
        ))}
        {listing && listing.entries.length === 0 && <div className="muted small-pad">No subfolders</div>}
      </div>
    </div>
  );
}
