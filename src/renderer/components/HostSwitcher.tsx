import { useEffect, useRef, useState } from 'react';
import { connectHost, hostLabel, openThread, setState, useStore } from '../lib/store';
import { IconCheck, IconChevronDown, IconPlus, IconServer } from './Icons';

export function StatusDot({ state }: { state: string }) {
  return <span className={`status-dot ${state}`} />;
}

export function HostSwitcher() {
  const selection = useStore((s) => s.selection);
  const hosts = useStore((s) => s.hosts);
  const order = useStore((s) => s.hostOrder);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = selection ? hosts[selection.hostId] : null;

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  return (
    <div className="host-switcher" ref={ref}>
      <button className="host-button" onClick={() => setOpen((o) => !o)}>
        <IconServer size={15} />
        <span className="host-name">{hostLabel(current)}</span>
        {current && <StatusDot state={current.status.state} />}
        <IconChevronDown size={12} />
      </button>
      {open && (
        <div className="popover down host-popover">
          <div className="popover-header">Machines</div>
          {order.map((id) => {
            const h = hosts[id];
            return (
              <button
                key={id}
                className={`popover-item ${selection?.hostId === id ? 'selected' : ''}`}
                onClick={() => {
                  setOpen(false);
                  void openThread(id, null);
                  if (h.status.state !== 'connected') void connectHost(id);
                }}
              >
                <span className="popover-item-text">
                  <span>
                    <StatusDot state={h.status.state} /> {hostLabel(h)}
                  </span>
                  <span className="popover-item-desc">
                    {h.type === 'local' ? 'This computer' : h.target}
                    {h.status.message ? ` · ${h.status.message}` : ''}
                  </span>
                </span>
                {selection?.hostId === id && <IconCheck size={14} />}
              </button>
            );
          })}
          <button
            className="popover-item"
            onClick={() => {
              setOpen(false);
              setState({ settingsOpen: true });
            }}
          >
            <span className="popover-item-text">
              <span>
                <IconPlus size={13} /> Add SSH machine…
              </span>
            </span>
          </button>
        </div>
      )}
    </div>
  );
}
