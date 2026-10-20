import { useEffect, useState } from 'react';
import type { HostConfig } from '../../shared/types';
import { bc } from '../lib/bridge';
import { conn, connectHost, hostLabel, setPrefs, setState, toast, useStore } from '../lib/store';
import { StatusDot } from './HostSwitcher';
import { IconX } from './Icons';

function AddHostForm({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState('');
  const [target, setTarget] = useState('');
  const [port, setPort] = useState('');
  const [nodePath, setNodePath] = useState('');
  const [identityFile, setIdentityFile] = useState('');
  return (
    <form
      className="settings-form"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!target.trim()) return;
        const host = await bc.hosts.add({
          name: name.trim() || target.trim(),
          type: 'ssh',
          target: target.trim(),
          sshPort: port ? Number(port) : undefined,
          identityFile: identityFile.trim() || undefined,
          nodePath: nodePath.trim() || undefined,
        });
        onDone();
        void connectHost(host.id);
      }}
    >
      <label>
        SSH destination
        <input className="text-input" placeholder="me@devbox or an alias from ~/.ssh/config" value={target} onChange={(e) => setTarget(e.target.value)} autoFocus />
      </label>
      <div className="form-row">
        <label>
          Name
          <input className="text-input" placeholder="optional" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          Port
          <input className="text-input" placeholder="22" value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))} />
        </label>
      </div>
      <label>
        Identity file
        <input className="text-input" placeholder="optional, e.g. ~/.ssh/id_ed25519" value={identityFile} onChange={(e) => setIdentityFile(e.target.value)} />
      </label>
      <label>
        Node.js on that machine
        <input className="text-input" placeholder="node (from the login shell)" value={nodePath} onChange={(e) => setNodePath(e.target.value)} />
      </label>
      <p className="muted small">
        Uses your SSH keys (no password prompts). BetterCodex copies a small host program to <code>~/.bettercodex</code> on that machine and runs Codex and the
        browser there, so threads, tabs and sign-ins stay on that machine.
      </p>
      <div className="form-actions">
        <button type="button" className="btn" onClick={onDone}>
          Cancel
        </button>
        <button type="submit" className="btn primary">
          Add machine
        </button>
      </div>
    </form>
  );
}

function HostConfigForm({ hostId }: { hostId: string }) {
  const info = useStore((s) => s.hosts[hostId]?.info);
  const [config, setConfig] = useState<HostConfig | null>(info?.config ?? null);
  useEffect(() => setConfig(info?.config ?? null), [info?.config]);
  if (!info || !config) return <p className="muted">Connect to this machine to change its settings.</p>;
  const save = async (next: HostConfig) => {
    setConfig(next);
    try {
      await conn(hostId)?.rpc('host/config/set', { config: next });
    } catch (err) {
      toast((err as Error).message);
    }
  };
  return (
    <div className="settings-form">
      <div className="kv">
        <span>Codex</span>
        <span>
          {info.codex.version ?? 'not found'} · {info.codex.status}
          {info.codex.error ? ` — ${info.codex.error}` : ''}
        </span>
        <span>Browser</span>
        <span>
          {info.browser.state}
          {info.browser.mode ? ` · ${info.browser.mode}` : ''}
          {info.browser.version ? ` · ${info.browser.version}` : ''}
          {info.browser.state === 'running' && info.browser.sandboxed === false ? ' · Chromium sandbox unavailable on this machine' : ''}
          {info.browser.error ? ` — ${info.browser.error}` : ''}
        </span>
        <span>Profile</span>
        {info.browser.engine === 'app' ? <span>The BetterCodex app's browser on this machine</span> : <code>{info.browser.profileDir}</code>}
      </div>
      <label>
        Browser
        <select
          className="text-input"
          value={config.browser.engine ?? 'auto'}
          onChange={(e) => void save({ ...config, browser: { ...config.browser, engine: e.target.value as HostConfig['browser']['engine'] } })}
        >
          <option value="auto">Automatic (the BetterCodex app when it is installed on this machine)</option>
          <option value="app">BetterCodex app (tabs show natively in its window)</option>
          <option value="chromium">Separate Chromium run by the host (streamed to the app)</option>
        </select>
      </label>
      <label>
        Chromium window
        <select
          className="text-input"
          value={config.browser.mode}
          onChange={(e) => void save({ ...config, browser: { ...config.browser, mode: e.target.value as HostConfig['browser']['mode'] } })}
        >
          <option value="auto">Automatic (hidden headful on Linux, headless on macOS)</option>
          <option value="headful">Headful (real window; best compatibility with sign-ins)</option>
          <option value="headless">Headless</option>
        </select>
      </label>
      <label>
        Chrome / Chromium binary
        <input
          className="text-input"
          placeholder="auto-detect"
          defaultValue={config.browser.executablePath}
          onBlur={(e) => e.target.value !== config.browser.executablePath && void save({ ...config, browser: { ...config.browser, executablePath: e.target.value.trim() } })}
        />
      </label>
      <div className="form-row">
        <label>
          Pixel density
          <select
            className="text-input"
            value={config.browser.deviceScaleFactor}
            onChange={(e) => void save({ ...config, browser: { ...config.browser, deviceScaleFactor: Number(e.target.value) } })}
          >
            <option value={1}>1x (fast)</option>
            <option value={2}>2x (sharp on Retina)</option>
          </select>
        </label>
        <label>
          Stream quality
          <select
            className="text-input"
            value={config.browser.jpegQuality}
            onChange={(e) => void save({ ...config, browser: { ...config.browser, jpegQuality: Number(e.target.value) } })}
          >
            <option value={55}>Low bandwidth</option>
            <option value={75}>Balanced</option>
            <option value={90}>High</option>
          </select>
        </label>
      </div>
      <label>
        Codex binary
        <input
          className="text-input"
          placeholder={info.codex.path ?? 'auto-detect'}
          defaultValue={config.codex.path}
          onBlur={(e) => e.target.value !== config.codex.path && void save({ ...config, codex: { ...config.codex, path: e.target.value.trim() } })}
        />
      </label>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={config.codex.disableOfficialBrowser}
          onChange={(e) => void save({ ...config, codex: { ...config.codex, disableOfficialBrowser: e.target.checked } })}
        />
        Hide the official Codex browser and computer-use plugins in BetterCodex threads
      </label>
      <div className="form-actions left">
        <button className="btn" onClick={() => void conn(hostId)?.rpc('browser/restart').catch((err) => toast(err.message))}>
          Restart browser
        </button>
        <button className="btn" onClick={() => void conn(hostId)?.rpc('host/codex/restart').catch((err) => toast(err.message))}>
          Restart Codex
        </button>
      </div>
      <p className="muted small">Browser changes apply after restarting the browser. Codex changes apply to threads started afterwards.</p>
    </div>
  );
}

export function Settings() {
  const open = useStore((s) => s.settingsOpen);
  const hosts = useStore((s) => s.hosts);
  const order = useStore((s) => s.hostOrder);
  const autoOpen = useStore((s) => s.prefs.autoOpenBrowser);
  const remoteTabs = useStore((s) => s.prefs.remoteTabs);
  const theme = useStore((s) => s.prefs.theme);
  const selected = useStore((s) => s.selection?.hostId);
  const [adding, setAdding] = useState(false);
  const [configHost, setConfigHost] = useState<string | null>(null);
  if (!open) return null;
  const shownConfig = configHost ?? selected ?? order[0];
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setState({ settingsOpen: false })}>
      <div className="modal">
        <div className="modal-header">
          <span>Settings</span>
          <button className="icon-button" onClick={() => setState({ settingsOpen: false })}>
            <IconX size={15} />
          </button>
        </div>
        <div className="modal-body">
          <h3>Machines</h3>
          <div className="host-list">
            {order.map((id) => {
              const h = hosts[id];
              return (
                <div key={id} className={`host-item ${shownConfig === id ? 'active' : ''}`} onClick={() => setConfigHost(id)}>
                  <StatusDot state={h.status.state} />
                  <div className="host-item-text">
                    <span>{hostLabel(h)}</span>
                    <span className="muted small">
                      {h.type === 'local' ? 'This computer' : h.target}
                      {h.status.message ? ` · ${h.status.message}` : ''}
                    </span>
                  </div>
                  {h.status.state === 'connected' ? (
                    h.type === 'ssh' && (
                      <button className="btn small" onClick={(e) => (e.stopPropagation(), void bc.hosts.disconnect(id))}>
                        Disconnect
                      </button>
                    )
                  ) : (
                    <button className="btn small" onClick={(e) => (e.stopPropagation(), void connectHost(id))}>
                      Connect
                    </button>
                  )}
                  {h.type === 'ssh' && (
                    <button className="btn small danger" onClick={(e) => (e.stopPropagation(), void bc.hosts.remove(id))}>
                      Remove
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          {adding ? (
            <AddHostForm onDone={() => setAdding(false)} />
          ) : (
            <button className="btn" onClick={() => setAdding(true)}>
              Add SSH machine…
            </button>
          )}
          {shownConfig && (
            <>
              <h3>{hostLabel(hosts[shownConfig])}</h3>
              <HostConfigForm hostId={shownConfig} />
            </>
          )}
          <h3>Interface</h3>
          <div className="settings-form">
            <label>
              Theme
              <select className="text-input" value={theme} onChange={(e) => setPrefs({ theme: e.target.value as 'system' | 'dark' | 'light' })}>
                <option value="system">Match system</option>
                <option value="dark">Dark</option>
                <option value="light">Light</option>
              </select>
            </label>
          </div>
          <label className="checkbox">
            <input type="checkbox" checked={autoOpen} onChange={(e) => setPrefs({ autoOpenBrowser: e.target.checked })} />
            Show the browser panel when Codex starts using a tab
          </label>
          <label>
            Tabs from other machines
            <select className="text-input" value={remoteTabs} onChange={(e) => setPrefs({ remoteTabs: e.target.value as 'sync' | 'stream' })}>
              <option value="sync">Synced copy (pages render here; clicks and typing are replayed there)</option>
              <option value="stream">Live stream of the other machine's browser</option>
            </select>
          </label>
        </div>
      </div>
    </div>
  );
}
