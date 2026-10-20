import { useEffect, useMemo, useRef, useState } from 'react';
import { describeSchedule, formatWall, nextRun, parseSchedule, relativeTo, wallTime, type ScheduleInput, type ScheduleSpec } from '../../shared/schedule';
import type { ScheduledRun, ScheduledTask, TaskAccess } from '../../shared/types';
import { isMac } from '../lib/bridge';
import {
  deleteTask,
  effectiveSettings,
  getState,
  hostLabel,
  markRunsRead,
  openRun,
  runTaskNow,
  saveTask,
  setState,
  setTaskStatus,
  toast,
  useStore,
  type HostView,
  type TaskDraft,
} from '../lib/store';
import { ACCESS_OPTIONS, EFFORT_LABELS } from './Composer';
import { StatusDot } from './HostSwitcher';
import { IconAlert, IconCheck, IconClock, IconFolder, IconPause, IconPlay, IconPlus, IconTrash, IconX, Spinner } from './Icons';
import { threadTitle } from './Sidebar';

/** Re-renders every 20 s so "in 5 min" labels stay true. */
function useNow() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 20000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** The machine's clock, from this computer's and the difference seen with its last update. */
const hostNow = (host: HostView, now: number) => now - host.clockSkew;

function destination(task: ScheduledTask, host: HostView) {
  if (task.target.type === 'thread') {
    const id = task.target.threadId;
    const thread = host.threads.find((t) => t.id === id);
    return thread ? `in “${threadTitle(thread)}”` : `in thread ${id.slice(0, 8)}…`;
  }
  const home = host.info?.homedir;
  const cwd = task.target.cwd;
  return `new thread in ${home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd}`;
}

export function openTaskEditor(draft: TaskDraft) {
  setState({ taskDraft: draft });
}

// ---------- the Scheduled view ----------

export function ScheduledView() {
  const hosts = useStore((s) => s.hosts);
  const order = useStore((s) => s.hostOrder);
  const now = useNow();
  const firstConnected = order.find((id) => hosts[id]?.schedule) ?? order[0];

  const runs = useMemo(() => {
    const list: Array<{ hostId: string; run: ScheduledRun }> = [];
    for (const id of order) {
      const snap = hosts[id]?.schedule;
      if (!snap) continue;
      const tasks = new Map(snap.tasks.map((t) => [t.id, t]));
      for (const run of snap.runs) {
        // Messages that went into an existing thread are read there; the inbox keeps the rest.
        if (run.status === 'completed' && tasks.get(run.taskId)?.target.type === 'thread') continue;
        list.push({ hostId: id, run });
      }
    }
    return list.sort((a, b) => (b.run.startedAt ?? b.run.scheduledFor) - (a.run.startedAt ?? a.run.scheduledFor)).slice(0, 40);
  }, [hosts, order]);
  const unread = runs.filter((r) => !r.run.read && r.run.status !== 'running' && r.run.status !== 'waiting');

  return (
    <section className="thread-view">
      <header className={`thread-header ${isMac ? 'mac' : ''}`}>
        <div className="thread-header-title">
          <span className="title">Scheduled</span>
          <span className="subtitle">Tasks run on their machine, even while this app is closed</span>
        </div>
        <div className="thread-header-actions">
          <button className="icon-button labeled" disabled={!firstConnected} onClick={() => firstConnected && openTaskEditor({ hostId: getState().selection?.hostId ?? firstConnected, taskId: null })}>
            <IconPlus size={14} /> New task
          </button>
        </div>
      </header>
      <div className="messages">
        <div className="scheduled-inner">
          <div className="section-head">
            <h3>Inbox</h3>
            {unread.length > 0 && (
              <button className="link-button inline" onClick={() => order.forEach((id) => hosts[id]?.schedule && void markRunsRead(id, 'all'))}>
                Mark all as read
              </button>
            )}
          </div>
          {runs.length === 0 && <div className="empty-note">Results of scheduled runs show up here.</div>}
          {runs.map(({ hostId, run }) => (
            <RunRow key={run.id} host={hosts[hostId]} run={run} now={now} />
          ))}
          <div className="section-head">
            <h3>Tasks</h3>
          </div>
          {order.map((id) => (
            <MachineTasks key={id} host={hosts[id]} now={now} />
          ))}
        </div>
      </div>
    </section>
  );
}

function RunStatus({ run }: { run: ScheduledRun }) {
  if (run.status === 'running') return <Spinner size={12} />;
  if (run.status === 'waiting') return <IconClock size={14} className="run-icon waiting" />;
  if (run.status === 'completed') return <IconCheck size={14} className="run-icon ok" />;
  return <IconAlert size={14} className="run-icon bad" />;
}

function RunRow({ host, run, now }: { host: HostView; run: ScheduledRun; now: number }) {
  const tz = host.schedule!.timezone;
  const when = run.startedAt ?? run.scheduledFor;
  const unread = !run.read && run.status !== 'running' && run.status !== 'waiting';
  const detail =
    run.status === 'running'
      ? 'Running…'
      : run.status === 'waiting'
        ? 'Waiting for the thread to finish its current turn'
        : run.error
          ? `${run.status === 'interrupted' ? 'Stopped' : 'Failed'}: ${run.error}`
          : run.status === 'interrupted'
            ? 'Stopped'
            : (run.summary?.split('\n').find((l) => l.trim()) ?? 'Done');
  return (
    <div className={`run-row ${unread ? 'unread' : ''} ${run.threadId ? '' : 'no-thread'}`} onClick={() => openRun(host.id, run)} title={run.summary ?? run.error ?? ''}>
      <span className="unread-dot" />
      <RunStatus run={run} />
      <div className="run-text">
        <div className="run-title">
          <span>{run.taskName}</span>
          <span className="run-machine">{hostLabel(host)}</span>
          {run.trigger === 'manual' && <span className="run-machine">run by hand</span>}
        </div>
        <div className={`run-detail ${run.status === 'failed' ? 'bad' : ''}`}>{detail}</div>
      </div>
      <span className="thread-time" title={formatWall(when, tz, true)}>
        {relativeTo(when, hostNow(host, now))}
      </span>
    </div>
  );
}

function MachineTasks({ host, now }: { host: HostView; now: number }) {
  const snap = host.schedule;
  const tasks = useMemo(() => {
    if (!snap) return [];
    const rank = { active: 0, paused: 1, completed: 2 } as const;
    return [...snap.tasks].sort((a, b) => rank[a.status] - rank[b.status] || (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity) || b.updatedAt - a.updatedAt);
  }, [snap]);
  const connected = host.status.state === 'connected';
  return (
    <div className="task-machine">
      <div className="task-machine-head">
        <StatusDot state={host.status.state} />
        <span>{hostLabel(host)}</span>
        {snap && <span className="muted small">{snap.timezone}</span>}
        <span className="spacer" />
        {snap && (
          <button className="btn small" onClick={() => openTaskEditor({ hostId: host.id, taskId: null })}>
            <IconPlus size={12} /> Add
          </button>
        )}
      </div>
      {!connected && <div className="empty-note">Not connected</div>}
      {connected && !snap && <div className="empty-note">This machine's BetterCodex host has no scheduler yet; reconnect to update it.</div>}
      {snap && tasks.length === 0 && <div className="empty-note">No tasks on this machine</div>}
      {snap &&
        tasks.map((task) => <TaskRow key={task.id} host={host} task={task} now={now} running={snap.runs.some((r) => r.taskId === task.id && (r.status === 'running' || r.status === 'waiting'))} />)}
    </div>
  );
}

/** "Every day at 18:00 · next 10-21 18:00 (in 7 h)", "Once at 10-20 10:47 (in 30 min)", "… · paused". */
function whenLabel(task: ScheduledTask, host: HostView, now: number) {
  const tz = host.schedule!.timezone;
  const at = hostNow(host, now);
  if (task.status === 'active' && task.schedule.type === 'once') return `Once at ${formatWall(task.schedule.at, tz)} (${relativeTo(task.schedule.at, at)})`;
  const schedule = describeSchedule(task.schedule, tz);
  if (task.status === 'paused') return `${schedule} · paused`;
  if (task.status === 'completed') return task.lastRunAt ? `${schedule} · ran ${relativeTo(task.lastRunAt, at)}` : schedule;
  if (!task.nextRunAt) return `${schedule} · no upcoming run`;
  return `${schedule} · next ${formatWall(task.nextRunAt, tz)} (${relativeTo(task.nextRunAt, at)})`;
}

function TaskRow({ host, task, now, running }: { host: HostView; task: ScheduledTask; now: number; running: boolean }) {
  return (
    <div className={`task-row ${task.status}`} onClick={() => openTaskEditor({ hostId: host.id, taskId: task.id })}>
      <IconClock size={15} className="task-icon" />
      <div className="task-text">
        <div className="task-name">
          {task.name}
          {task.createdBy && <span className="task-tag">by agent</span>}
        </div>
        <div className="task-meta">
          {whenLabel(task, host, now)} · {destination(task, host)}
        </div>
      </div>
      {running && <Spinner size={12} />}
      <div className="task-actions" onClick={(e) => e.stopPropagation()}>
        <button className="icon-button" title="Run now" disabled={running} onClick={() => void runTaskNow(host.id, task.id)}>
          <IconPlay size={13} />
        </button>
        {task.status !== 'completed' && (
          <button className="icon-button" title={task.status === 'paused' ? 'Resume' : 'Pause'} onClick={() => void setTaskStatus(host.id, task.id, task.status === 'paused' ? 'active' : 'paused')}>
            {task.status === 'paused' ? <IconPlay size={13} /> : <IconPause size={13} />}
          </button>
        )}
        <button className="icon-button" title="Delete" onClick={() => void deleteTask(host.id, task.id)}>
          <IconTrash size={13} />
        </button>
      </div>
    </div>
  );
}

// ---------- in a thread ----------

/** Scheduled messages and heartbeats aimed at the thread on screen, above its composer. */
export function ThreadSchedules({ hostId, threadId }: { hostId: string; threadId: string }) {
  const host = useStore((s) => s.hosts[hostId]);
  const now = useNow();
  const snap = host?.schedule;
  if (!snap) return null;
  const tasks = snap.tasks.filter((t) => t.target.type === 'thread' && t.target.threadId === threadId && t.status !== 'completed');
  const waiting = snap.runs.filter((r) => r.threadId === threadId && r.status === 'waiting');
  if (!tasks.length && !waiting.length) return null;
  return (
    <div className="thread-schedules">
      {tasks.map((task) => (
        <div key={task.id} className={`thread-schedule ${task.status}`} onClick={() => openTaskEditor({ hostId, taskId: task.id })} title={task.prompt}>
          <IconClock size={13} />
          <span className="thread-schedule-text">
            <strong>{task.name}</strong> · {whenLabel(task, host, now)}
            {waiting.some((r) => r.taskId === task.id) ? ' · waiting for this turn to end' : ''}
          </span>
          <button
            className="icon-button"
            title="Delete"
            onClick={(e) => {
              e.stopPropagation();
              void deleteTask(hostId, task.id);
            }}
          >
            <IconX size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}

/** The composer's "send later" menu: schedules the typed message into this thread. */
export function SendLater({ hostId, threadId, text, onScheduled }: { hostId: string; threadId: string; text: string; onScheduled: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const host = useStore((s) => s.hosts[hostId]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  if (!host?.schedule) return null;
  const tz = host.schedule.timezone;
  const tomorrow = () => {
    const w = wallTime(hostNow(host, Date.now()), tz);
    const d = new Date(Date.UTC(w.year, w.month - 1, w.day + 1));
    return `${d.toISOString().slice(0, 10)}T09:00`;
  };
  const options: Array<{ label: string; schedule: () => ScheduleInput }> = [
    { label: 'In 30 minutes', schedule: () => ({ type: 'once', inMinutes: 30 }) },
    { label: 'In 1 hour', schedule: () => ({ type: 'once', inMinutes: 60 }) },
    { label: 'In 3 hours', schedule: () => ({ type: 'once', inMinutes: 180 }) },
    { label: 'Tomorrow at 9:00', schedule: () => ({ type: 'once', at: tomorrow() }) },
  ];
  const send = async (schedule: ScheduleInput) => {
    setOpen(false);
    const prompt = text.trim();
    const task = await saveTask(hostId, null, {
      name: prompt.split('\n')[0].slice(0, 80),
      prompt,
      schedule,
      target: { type: 'thread', threadId },
      model: null,
      effort: null,
      access: effectiveSettings(hostId, threadId).access,
    });
    if (!task) return;
    toast(`Scheduled for ${task.nextRunAt ? formatWall(task.nextRunAt, tz) : 'later'}`);
    onScheduled();
  };
  return (
    <div className="dropdown" ref={ref}>
      <button className="icon-button" title="Send later or on a schedule" onClick={() => setOpen((o) => !o)}>
        <IconClock size={15} />
      </button>
      {open && (
        <div className="popover up">
          <div className="popover-header">Send this message later</div>
          {!text.trim() && <div className="popover-note">Type the message first, or set up a recurring task.</div>}
          {options.map((o) => (
            <button key={o.label} className="popover-item" disabled={!text.trim()} onClick={() => void send(o.schedule())}>
              {o.label}
            </button>
          ))}
          <button
            className="popover-item"
            onClick={() => {
              setOpen(false);
              openTaskEditor({ hostId, taskId: null, threadId, prompt: text });
              onScheduled();
            }}
          >
            Custom time or repeat…
          </button>
        </div>
      )}
    </div>
  );
}

// ---------- editor ----------

type Repeat = 'once' | 'minutes' | 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'cron';

interface ScheduleForm {
  repeat: Repeat;
  /** datetime-local value, wall time on the task's machine */
  at: string;
  every: number;
  minute: number;
  time: string;
  days: number[];
  cron: string;
  /** Custom cron only; empty = the machine's time zone. */
  timezone: string;
}

const REPEATS: Array<{ value: Repeat; label: string }> = [
  { value: 'once', label: 'Once' },
  { value: 'minutes', label: 'Every few minutes' },
  { value: 'hourly', label: 'Hourly' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekdays', label: 'Weekdays' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'cron', label: 'Custom (cron)' },
];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const pad = (n: number) => String(n).padStart(2, '0');

function formFrom(spec: ScheduleSpec | null, tz: string, now: number): ScheduleForm {
  const soon = formatWall(now + 3600_000, tz, true).replace(' ', 'T');
  const form: ScheduleForm = { repeat: 'once', at: soon, every: 30, minute: 0, time: '09:00', days: [1], cron: '0 9 * * 1-5', timezone: '' };
  if (!spec) return form;
  if (spec.type === 'once') return { ...form, at: formatWall(spec.at, tz, true).replace(' ', 'T') };
  if (spec.type === 'interval') return { ...form, repeat: 'minutes', every: spec.everyMinutes };
  form.cron = spec.expression;
  form.timezone = spec.timezone ?? '';
  // Show the friendly controls when the expression is one they produce.
  const m = /^(\d+) (\*|\d+) \* \* (\*|1-5|[\d,]+)$/.exec(spec.expression.trim());
  if (!m || spec.timezone) return { ...form, repeat: 'cron' };
  const [, minute, hour, dow] = m;
  if (hour === '*') return dow === '*' ? { ...form, repeat: 'hourly', minute: Number(minute) } : { ...form, repeat: 'cron' };
  const time = `${pad(Number(hour))}:${pad(Number(minute))}`;
  if (dow === '*') return { ...form, repeat: 'daily', time };
  if (dow === '1-5') return { ...form, repeat: 'weekdays', time };
  return { ...form, repeat: 'weekly', time, days: dow.split(',').map((d) => Number(d) % 7) };
}

function inputFrom(form: ScheduleForm): ScheduleInput {
  const [h, mi] = form.time.split(':').map(Number);
  switch (form.repeat) {
    case 'once':
      return { type: 'once', at: form.at };
    case 'minutes':
      return { type: 'interval', everyMinutes: form.every };
    case 'hourly':
      return { type: 'cron', expression: `${form.minute} * * * *` };
    case 'daily':
      return { type: 'cron', expression: `${mi} ${h} * * *` };
    case 'weekdays':
      return { type: 'cron', expression: `${mi} ${h} * * 1-5` };
    case 'weekly':
      return { type: 'cron', expression: `${mi} ${h} * * ${[...form.days].sort().join(',') || '1'}` };
    case 'cron':
      return { type: 'cron', expression: form.cron, timezone: form.timezone.trim() || null };
  }
}

export function TaskEditor() {
  const draft = useStore((s) => s.taskDraft);
  if (!draft) return null;
  return <TaskEditorModal key={`${draft.hostId}:${draft.taskId ?? 'new'}`} draft={draft} />;
}

function TaskEditorModal({ draft }: { draft: TaskDraft }) {
  const hosts = useStore((s) => s.hosts);
  const order = useStore((s) => s.hostOrder);
  const [hostId, setHostId] = useState(draft.hostId);
  const host = hosts[hostId];
  const existing = draft.taskId ? (host?.schedule?.tasks.find((t) => t.id === draft.taskId) ?? null) : null;
  const tz = host?.schedule?.timezone ?? 'UTC';
  const [name, setName] = useState(existing?.name ?? '');
  const [prompt, setPrompt] = useState(existing?.prompt ?? draft.prompt ?? '');
  const [mode, setMode] = useState<'newThread' | 'thread'>(existing ? existing.target.type : draft.threadId ? 'thread' : 'newThread');
  const [threadId, setThreadId] = useState(existing?.target.type === 'thread' ? existing.target.threadId : (draft.threadId ?? ''));
  const [cwd, setCwd] = useState(existing?.target.type === 'newThread' ? existing.target.cwd : (getState().prefs.cwd[hostId] || host?.info?.homedir || ''));
  const [model, setModel] = useState(existing?.model ?? '');
  const [effort, setEffort] = useState(existing?.effort ?? '');
  const [access, setAccess] = useState<TaskAccess>(existing?.access ?? getState().prefs.access);
  const [form, setForm] = useState(() => formFrom(existing?.schedule ?? null, tz, host ? hostNow(host, Date.now()) : Date.now()));
  const [initialForm] = useState(form);
  // An unchanged schedule is not sent again, so a task whose time has passed can still be edited.
  const scheduleChanged = !existing || JSON.stringify(inputFrom(form)) !== JSON.stringify(inputFrom(initialForm));
  const [saving, setSaving] = useState(false);
  const close = () => setState({ taskDraft: null });

  const threads = useMemo(() => (host?.threads ?? []).filter((t) => !t.parentThreadId).slice(0, 200), [host?.threads]);
  const folders = useMemo(() => [...new Set((host?.threads ?? []).map((t) => t.cwd))].slice(0, 20), [host?.threads]);
  const modelInfo = host?.models.find((m) => m.model === model);
  const preview = useMemo(() => {
    if (!host) return { text: '', error: false };
    if (existing && !scheduleChanged) return { text: whenLabel(existing, host, Date.now()), error: false };
    const now = hostNow(host, Date.now());
    try {
      const spec = parseSchedule(inputFrom(form), now, tz);
      if (spec.type === 'once' && spec.at < now) return { text: 'That time has passed', error: true };
      const next = spec.type === 'once' ? spec.at : nextRun(spec, now, tz);
      return { text: next ? `${describeSchedule(spec, tz)} · next ${formatWall(next, tz, true)} (${relativeTo(next, now)})` : describeSchedule(spec, tz), error: false };
    } catch (err) {
      return { text: (err as Error).message, error: true };
    }
  }, [form, tz, host, existing, scheduleChanged]);

  if (draft.taskId && !existing) {
    return null;
  }

  const save = async () => {
    if (!prompt.trim() || preview.error || (mode === 'thread' && !threadId)) return;
    setSaving(true);
    const saved = await saveTask(hostId, existing?.id ?? null, {
      name: name.trim(),
      prompt,
      schedule: scheduleChanged ? inputFrom(form) : undefined,
      target: mode === 'thread' ? { type: 'thread', threadId } : { type: 'newThread', cwd },
      model: model || null,
      effort: effort || null,
      access,
    });
    setSaving(false);
    if (saved) close();
  };

  const set = (patch: Partial<ScheduleForm>) => setForm((f) => ({ ...f, ...patch }));

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal task-editor">
        <div className="modal-header">
          <span>{existing ? 'Edit task' : 'New scheduled task'}</span>
          <button className="icon-button" onClick={close}>
            <IconX size={15} />
          </button>
        </div>
        <div className="modal-body">
          <div className="settings-form">
            <div className="form-row">
              <label>
                Machine
                <select
                  className="text-input"
                  value={hostId}
                  disabled={!!existing || !!draft.threadId}
                  onChange={(e) => {
                    const id = e.target.value;
                    setHostId(id);
                    setThreadId('');
                    setCwd(getState().prefs.cwd[id] || hosts[id]?.info?.homedir || '');
                  }}
                >
                  {order
                    .filter((id) => hosts[id]?.schedule || id === hostId)
                    .map((id) => (
                      <option key={id} value={id}>
                        {hostLabel(hosts[id])}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                Name
                <input className="text-input" placeholder="optional" value={name} onChange={(e) => setName(e.target.value)} />
              </label>
            </div>
            <label>
              Prompt
              <textarea className="text-input prompt-input" rows={5} value={prompt} placeholder="What should Codex do on each run?" onChange={(e) => setPrompt(e.target.value)} autoFocus />
            </label>
            <label>
              Runs in
              <div className="segmented">
                <button type="button" className={mode === 'newThread' ? 'on' : ''} onClick={() => setMode('newThread')}>
                  A new thread each time
                </button>
                <button type="button" className={mode === 'thread' ? 'on' : ''} onClick={() => setMode('thread')}>
                  An existing thread
                </button>
              </div>
            </label>
            {mode === 'thread' ? (
              <label>
                Thread
                <select className="text-input" value={threadId} onChange={(e) => setThreadId(e.target.value)}>
                  <option value="">Choose a thread…</option>
                  {threadId && !threads.some((t) => t.id === threadId) && <option value={threadId}>{threadId}</option>}
                  {threads.map((t) => (
                    <option key={t.id} value={t.id}>
                      {threadTitle(t)}
                    </option>
                  ))}
                </select>
                <span className="muted small">The prompt arrives as a new message; if a turn is running then, it waits for it to finish. The thread keeps its own model and permissions.</span>
              </label>
            ) : (
              <>
                <label>
                  Project folder
                  <div className="input-with-icon">
                    <IconFolder size={13} />
                    <input className="text-input" list="task-folders" value={cwd} onChange={(e) => setCwd(e.target.value)} />
                  </div>
                  <datalist id="task-folders">
                    {folders.map((f) => (
                      <option key={f} value={f} />
                    ))}
                  </datalist>
                </label>
                <div className="form-row">
                  <label>
                    Model
                    <select className="text-input" value={model} onChange={(e) => setModel(e.target.value)}>
                      <option value="">Machine default</option>
                      {host?.models
                        .filter((m) => !m.hidden || m.model === model)
                        .map((m) => (
                          <option key={m.model} value={m.model}>
                            {m.displayName || m.model}
                          </option>
                        ))}
                    </select>
                  </label>
                  <label>
                    Reasoning
                    <select className="text-input" value={effort} onChange={(e) => setEffort(e.target.value)}>
                      <option value="">Default</option>
                      {(modelInfo?.supportedReasoningEfforts.map((e) => e.reasoningEffort) ?? ['low', 'medium', 'high', 'xhigh']).map((e) => (
                        <option key={e} value={e}>
                          {EFFORT_LABELS[e] ?? e}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Permissions
                    <select className="text-input" value={access} onChange={(e) => setAccess(e.target.value as TaskAccess)}>
                      {ACCESS_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <span className="muted small">Runs never stop to ask for approval; anything the permissions do not allow fails instead. Each run can keep notes for the next one in a memory file.</span>
              </>
            )}
            <label>
              When
              <div className="schedule-row">
                <select className="text-input" value={form.repeat} onChange={(e) => set({ repeat: e.target.value as Repeat })}>
                  {REPEATS.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </select>
                {form.repeat === 'once' && <input className="text-input" type="datetime-local" value={form.at} onChange={(e) => set({ at: e.target.value })} />}
                {form.repeat === 'minutes' && (
                  <span className="inline-field">
                    every <input className="text-input narrow" type="number" min={1} value={form.every} onChange={(e) => set({ every: Number(e.target.value) })} /> minutes
                  </span>
                )}
                {form.repeat === 'hourly' && (
                  <span className="inline-field">
                    at minute <input className="text-input narrow" type="number" min={0} max={59} value={form.minute} onChange={(e) => set({ minute: Number(e.target.value) })} />
                  </span>
                )}
                {(form.repeat === 'daily' || form.repeat === 'weekdays' || form.repeat === 'weekly') && (
                  <input className="text-input narrow-time" type="time" value={form.time} onChange={(e) => set({ time: e.target.value })} />
                )}
                {form.repeat === 'cron' && (
                  <>
                    <input className="text-input mono" value={form.cron} placeholder="m h dom mon dow" onChange={(e) => set({ cron: e.target.value })} />
                    <input className="text-input narrow-tz" value={form.timezone} placeholder={tz} title="Time zone" onChange={(e) => set({ timezone: e.target.value })} />
                  </>
                )}
              </div>
              {form.repeat === 'weekly' && (
                <div className="day-picker">
                  {DAYS.map((d, i) => (
                    <button
                      type="button"
                      key={d}
                      className={form.days.includes(i) ? 'on' : ''}
                      onClick={() => set({ days: form.days.includes(i) ? form.days.filter((x) => x !== i) : [...form.days, i] })}
                    >
                      {d}
                    </button>
                  ))}
                </div>
              )}
              <span className={`small ${preview.error ? 'error-text' : 'muted'}`}>
                {preview.text}
                {!preview.error && ` · ${tz}`}
              </span>
            </label>
            {existing?.createdBy && (
              <span className="muted small">
                Set up by an agent in thread {existing.createdBy.threadId.slice(0, 8)}… on {existing.createdBy.machine}.
              </span>
            )}
            <div className="form-actions">
              {existing && (
                <button
                  type="button"
                  className="btn danger"
                  onClick={() => {
                    void deleteTask(hostId, existing.id);
                    close();
                  }}
                >
                  Delete
                </button>
              )}
              <span className="spacer" />
              <button type="button" className="btn" onClick={close}>
                Cancel
              </button>
              <button type="button" className="btn primary" disabled={saving || !prompt.trim() || preview.error || (mode === 'thread' && !threadId)} onClick={() => void save()}>
                {existing ? 'Save' : 'Schedule'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
