import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ThreadItem } from '../../shared/codex-protocol/v2/ThreadItem';
import { isMac } from '../lib/bridge';
import { hostLabel, loadOlderTurns, setPrefs, setState, threadKey, useStore, type TurnView } from '../lib/store';
import { ApprovalRequest } from './Approvals';
import { Composer } from './Composer';
import { IconCheck, IconChevronDown, IconChevronRight, IconFolder, IconGlobe, Spinner } from './Icons';
import { ItemView } from './Items';
import { ProjectPicker } from './ProjectPicker';
import { threadTitle } from './Sidebar';

function formatDuration(ms: number) {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function isFinal(item: ThreadItem) {
  return item.type === 'agentMessage' && item.phase !== 'commentary';
}

function Turn({ turn, hostId, isLast }: { turn: TurnView; hostId: string; isLast: boolean }) {
  const running = turn.status === 'inProgress';
  const users = turn.items.filter((i) => i.type === 'userMessage');
  const rest = turn.items.filter((i) => i.type !== 'userMessage');
  const finalIdx = running ? -1 : rest.map(isFinal).lastIndexOf(true);
  const final = finalIdx >= 0 ? rest[finalIdx] : null;
  const work = rest.filter((_, i) => i !== finalIdx);
  const [open, setOpen] = useState(false);
  const showWork = running || open;
  const duration = turn.durationMs ?? (turn.completedAt && turn.startedAt ? (turn.completedAt - turn.startedAt) * 1000 : null);
  const changes = rest.flatMap((i) => (i.type === 'fileChange' ? i.changes : []));

  return (
    <div className="turn">
      {users.map((item) => (
        <ItemView key={item.id} item={item} hostId={hostId} />
      ))}
      {!running && work.length > 0 && (
        <button className="worked-for" onClick={() => setOpen((o) => !o)}>
          {open ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
          {turn.status === 'interrupted' ? 'Stopped' : 'Worked'}
          {duration ? ` for ${formatDuration(duration)}` : ''}
        </button>
      )}
      {showWork && (
        <div className={`work ${running ? '' : 'collapsed-work'}`}>
          {work.map((item) => (
            <ItemView key={item.id} item={item} hostId={hostId} />
          ))}
        </div>
      )}
      {running && isLast && (
        <div className="working">
          <span className="shimmer">Working</span>
        </div>
      )}
      {final && <ItemView item={final} hostId={hostId} />}
      {!running && changes.length > 0 && (
        <div className="changes-summary">
          <IconCheck size={13} /> {changes.length} file{changes.length === 1 ? '' : 's'} changed
        </div>
      )}
      {turn.error && <div className="turn-error">{turn.error}</div>}
      {turn.status === 'interrupted' && !turn.error && <div className="turn-note">Turn stopped</div>}
    </div>
  );
}

export function ThreadView({ hostId, threadId }: { hostId: string; threadId: string | null }) {
  const key = threadId ? threadKey(hostId, threadId) : null;
  const tv = useStore((s) => (key ? s.threads[key] : undefined));
  const thread = useStore((s) => (threadId ? s.hosts[hostId]?.threads.find((t) => t.id === threadId) : undefined));
  const host = useStore((s) => s.hosts[hostId]);
  const browserOpen = useStore((s) => s.prefs.browserOpen);
  const requests = useMemo(() => (host?.requests ?? []).filter((r) => r.params?.threadId === threadId), [host?.requests, threadId]);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const lastKey = useRef<string | null>(null);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (lastKey.current !== key) {
      lastKey.current = key;
      stick.current = true;
    }
    if (stick.current) el.scrollTop = el.scrollHeight;
  });

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onScroll = () => {
      stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      if (el.scrollTop < 200 && hostId && threadId) void loadOlderTurns(hostId, threadId);
    };
    el.addEventListener('scroll', onScroll);
    return () => el.removeEventListener('scroll', onScroll);
  }, [hostId, threadId]);

  const title = thread ? threadTitle(thread) : threadId ? 'Thread' : 'New thread';
  const codexDown = host && host.info && host.info.codex.status !== 'ready';

  return (
    <section className="thread-view">
      <header className={`thread-header ${isMac ? 'mac' : ''}`}>
        <div className="thread-header-title">
          <span className="title">{title}</span>
          {thread && (
            <span className="subtitle" title={thread.cwd}>
              <IconFolder size={12} /> {thread.cwd.replace(host?.info?.homedir ?? '\u0000', '~')}
            </span>
          )}
        </div>
        <div className="thread-header-actions">
          <button className={`icon-button labeled ${browserOpen ? 'on' : ''}`} title="Toggle browser" onClick={() => setPrefs({ browserOpen: !browserOpen })}>
            <IconGlobe size={15} /> Browser
          </button>
        </div>
      </header>
      {codexDown && (
        <div className="banner">
          {host.info!.codex.status === 'error' ? host.info!.codex.error : 'Starting Codex…'}
        </div>
      )}
      {host?.status.state !== 'connected' && (
        <div className="banner">{host?.status.state === 'error' ? host.status.message : (host?.status.message ?? 'Connecting…')}</div>
      )}
      <div className="messages" ref={scroller}>
        {!threadId ? (
          <NewThreadHero hostId={hostId} />
        ) : !tv || (tv.loading && tv.turns.length === 0) ? (
          <div className="center-note">
            <Spinner /> Loading…
          </div>
        ) : (
          <div className="messages-inner">
            {tv.olderCursor && (
              <button className="load-older" onClick={() => void loadOlderTurns(hostId, threadId)}>
                {tv.loadingOlder ? <Spinner size={12} /> : null} Load earlier messages
              </button>
            )}
            {tv.error && <div className="turn-error">{tv.error}</div>}
            {tv.turns.map((turn, i) => (
              <Turn key={turn.id} turn={turn} hostId={hostId} isLast={i === tv.turns.length - 1} />
            ))}
            {tv.retrying && <div className="turn-note">{tv.retrying}</div>}
          </div>
        )}
      </div>
      <Composer hostId={hostId} threadId={threadId}>
        {tv?.plan && tv.activeTurnId && (
          <div className="plan-card">
            {tv.plan.explanation && <div className="plan-explanation">{tv.plan.explanation}</div>}
            {tv.plan.steps.map((step, i) => (
              <div key={i} className={`plan-step ${step.status}`}>
                <span className="plan-check">{step.status === 'completed' ? <IconCheck size={12} /> : step.status === 'inProgress' ? <Spinner size={10} /> : null}</span>
                {step.step}
              </div>
            ))}
          </div>
        )}
        {requests.map((req) => (
          <ApprovalRequest key={String(req.id)} hostId={hostId} req={req} />
        ))}
      </Composer>
    </section>
  );
}

function NewThreadHero({ hostId }: { hostId: string }) {
  const host = useStore((s) => s.hosts[hostId]);
  return (
    <div className="hero">
      <div className="hero-title">What should we work on?</div>
      <div className="hero-sub">
        on <strong>{hostLabel(host)}</strong>
        {host?.type === 'ssh' ? ` (${host.target})` : ''}
      </div>
      <ProjectPicker hostId={hostId} />
      <button className="link-button" onClick={() => setState({ settingsOpen: true })}>
        Machine settings
      </button>
    </div>
  );
}
