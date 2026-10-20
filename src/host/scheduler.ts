import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describeSchedule, nextRun, parseSchedule, systemTimeZone, type ScheduleInput } from '../shared/schedule.js';
import type { ScheduledRun, ScheduledTask, ScheduleSnapshot, TaskAccess, TaskActor, TaskGrant, TaskPermissions, TaskTarget } from '../shared/types.js';
import { RpcError, type CodexBridge } from './codex.js';
import { machineId, paths, readJson, writeJson } from './config.js';
import { errorMessage, log } from './log.js';

/** What the app and agents send to create or change a task; omitted fields keep their value. */
export interface TaskInput {
  name?: string;
  prompt?: string;
  schedule?: ScheduleInput;
  target?: { type: 'thread'; threadId: string } | { type: 'newThread'; cwd?: string | null };
  model?: string | null;
  effort?: string | null;
  access?: TaskAccess | null;
  status?: 'active' | 'paused';
}

type SandboxPolicy = { type?: string; networkAccess?: unknown; writableRoots?: string[] };

/** Finished runs kept as history; runs still going are always kept. */
const MAX_HISTORY = 300;
/** Longest a timer sleeps, so a wall-clock jump (suspend, clock change) is noticed quickly. */
const MAX_SLEEP = 30_000;
const LEVEL: Record<TaskAccess, number> = { 'read-only': 0, auto: 1, full: 2 };
const ACCESS_LABEL: Record<TaskAccess, string> = { 'read-only': 'read-only', auto: 'default (workspace-write)', full: 'full access' };
const FULL: TaskPermissions = { level: 'full', network: true, roots: ['/'] };

/** Permissions of the thread an agent calls from, from Codex's sandbox mode in the turn metadata. */
export function accessOfSandboxMode(mode: string | null | undefined): TaskAccess {
  if (mode === 'danger-full-access' || mode === 'none') return 'full';
  if (mode === 'workspace-write') return 'auto';
  return 'read-only';
}

function accessOfPolicy(policy: SandboxPolicy | null | undefined): TaskAccess {
  switch (policy?.type) {
    case 'dangerFullAccess':
    case 'externalSandbox':
      return 'full';
    case 'workspaceWrite':
      return 'auto';
    default:
      return 'read-only';
  }
}

function permissionsOf(policy: SandboxPolicy, cwd: string | null): TaskPermissions {
  const level = accessOfPolicy(policy);
  if (level === 'full') return FULL;
  const roots = level === 'auto' ? [cwd, ...(policy.writableRoots ?? [])].filter((r): r is string => !!r) : [];
  return { level, network: policy.networkAccess === true || policy.networkAccess === 'enabled', roots };
}

/** What a run that starts its own thread can do (its memory folder aside). */
function newThreadPermissions(access: TaskAccess, cwd: string): TaskPermissions {
  if (access === 'full') return FULL;
  return { level: access, network: false, roots: access === 'auto' ? [cwd] : [] };
}

function inside(child: string, parent: string) {
  const rel = path.relative(parent, child);
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/** Whether something with `inner` permissions can do nothing that `outer` could not. */
function within(inner: TaskPermissions, outer: TaskPermissions) {
  if (outer.level === 'full') return true;
  if (LEVEL[inner.level] > LEVEL[outer.level] || (inner.network && !outer.network)) return false;
  return inner.roots.every((root) => outer.roots.some((allowed) => inside(root, allowed)));
}

function describePermissions(p: TaskPermissions) {
  if (p.level !== 'auto') return ACCESS_LABEL[p.level];
  return `${ACCESS_LABEL.auto}${p.roots.length ? ` in ${p.roots.join(', ')}` : ''}${p.network ? ' with network' : ''}`;
}

function runPermissions(access: TaskAccess, memoryDir: string) {
  switch (access) {
    case 'read-only':
      return { sandbox: 'read-only', sandboxPolicy: { type: 'readOnly', networkAccess: false } };
    case 'full':
      return { sandbox: 'danger-full-access', sandboxPolicy: { type: 'dangerFullAccess' } };
    default:
      // The task's memory folder is writable so runs can keep notes for the next one.
      return {
        sandbox: 'workspace-write',
        sandboxPolicy: { type: 'workspaceWrite', writableRoots: [memoryDir], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
      };
  }
}

function isSameTarget(input: NonNullable<TaskInput['target']>, current: TaskTarget) {
  if (input.type === 'thread') return current.type === 'thread' && input.threadId === current.threadId;
  return current.type === 'newThread' && path.resolve(expandHome(String(input.cwd || '').trim() || os.homedir())) === current.cwd;
}

function newId(prefix: string) {
  return `${prefix}_${crypto.randomBytes(5).toString('hex')}`;
}

function expandHome(p: string) {
  return p === '~' ? os.homedir() : p.replace(/^~(?=\/)/, os.homedir());
}

const live = (run: ScheduledRun) => run.status === 'running' || run.status === 'waiting';

/**
 * Runs this machine's scheduled tasks through its Codex app-server. Tasks keep running while the
 * app is closed: the host daemon outlives it. A run either starts a fresh thread or sends the prompt
 * into an existing thread, waiting for the thread's current turn to finish first.
 *
 * Agents may only set up tasks that cannot do more than their own thread: no higher sandbox level,
 * no network they lack, no folders they cannot write, and nothing on other machines unless they
 * have full access. The user, in the app, is not limited.
 */
export class Scheduler extends EventEmitter {
  tasks: ScheduledTask[] = [];
  runs: ScheduledRun[] = [];
  readonly hostname = os.hostname();
  readonly machineId = machineId();
  private timer: NodeJS.Timeout | null = null;
  private started = false;
  private changeTimer: NodeJS.Timeout | null = null;
  /** Sandbox and folder of threads seen going through this host, so checks rarely need Codex. */
  private threads = new Map<string, { policy: SandboxPolicy | null; cwd: string | null }>();
  /** Deliveries into a thread happen one at a time. */
  private locks = new Map<string, Promise<void>>();
  /** Threads where we started a turn that has not ended yet. */
  private busy = new Set<string>();

  constructor(
    private codex: CodexBridge,
    /** Per-thread config overrides that plug the host's MCP tools into Codex threads. */
    private threadConfig: () => Record<string, unknown>,
  ) {
    super();
    codex.on('notification', (method: string, params: any) => this.onNotification(method, params));
    codex.on('status', (status: string) => {
      this.busy.clear();
      if (status === 'ready') this.deliverAllWaiting();
      else this.interruptRunning('Codex stopped during the run');
    });
  }

  get timezone() {
    return systemTimeZone();
  }

  load() {
    const stored = readJson<{ tasks?: ScheduledTask[]; runs?: ScheduledRun[] }>(paths.schedules, {});
    this.tasks = Array.isArray(stored.tasks) ? stored.tasks.map((t) => ({ ...t, grant: t.grant ?? null })) : [];
    this.runs = Array.isArray(stored.runs) ? stored.runs : [];
    // Turns die with the previous host and its Codex; messages still waiting for a thread are kept.
    for (const run of this.runs) {
      if (run.status === 'running') this.finish(run, 'interrupted', 'BetterCodex host restarted during the run', false);
    }
    this.save();
  }

  start() {
    this.started = true;
    this.arm();
  }

  stop() {
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** The `schedule/*` methods; `actor` is set when an agent acts, possibly from another machine through the app. */
  async rpc(method: string, params: any): Promise<any> {
    const actor: TaskActor | null = params.actor ?? null;
    const meta = () => ({ hostname: this.hostname, timezone: this.timezone, now: Date.now() });
    switch (method) {
      case 'schedule/list':
        return this.snapshot();
      case 'schedule/create':
        return { task: await this.create(params.task ?? {}, actor), ...meta() };
      case 'schedule/update':
        return { task: await this.update(params.id, params.patch ?? {}, actor), ...meta() };
      case 'schedule/delete':
        await this.remove(params.id, actor);
        return meta();
      case 'schedule/run':
        return { run: await this.runNow(params.id, actor), ...meta() };
      case 'schedule/read':
        this.markRead(params.all ? 'all' : (params.ids ?? []));
        return {};
    }
    throw new RpcError(-32601, `Unknown method ${method}`);
  }

  snapshot(): ScheduleSnapshot {
    // Sent to every client on each change, so only the recent runs.
    return { hostname: this.hostname, timezone: this.timezone, now: Date.now(), tasks: this.tasks, runs: this.runs.slice(0, 60) };
  }

  get(id: string) {
    return this.tasks.find((t) => t.id === id) ?? null;
  }

  describe(task: ScheduledTask) {
    return describeSchedule(task.schedule, this.timezone);
  }

  /** Remembers the sandbox and folder of threads started or changed through this host. */
  noteThread(threadId: string | undefined, policy: SandboxPolicy | null | undefined, cwd?: string | null) {
    if (!threadId || (!policy?.type && !cwd)) return;
    const known = this.threads.get(threadId);
    this.threads.set(threadId, { policy: policy?.type ? policy : (known?.policy ?? null), cwd: cwd || known?.cwd || null });
  }

  // ---------- changes ----------

  async create(input: TaskInput, actor: TaskActor | null = null): Promise<ScheduledTask> {
    const prompt = String(input.prompt ?? '').trim();
    if (!prompt) throw new RpcError(-32602, 'prompt is required');
    if (!input.schedule) throw new RpcError(-32602, 'schedule is required');
    if (!input.target) throw new RpcError(-32602, 'target is required');
    const now = Date.now();
    const schedule = this.parse(input.schedule, now);
    const { target, access, permissions } = await this.resolveTarget(input.target, input.access ?? null, actor);
    const grant = await this.authorize(actor, permissions, target);
    const task: ScheduledTask = {
      id: newId('task'),
      name: String(input.name ?? '').trim() || prompt.split('\n')[0].slice(0, 80),
      prompt,
      schedule,
      target,
      model: input.model || null,
      effort: input.effort || null,
      access,
      status: input.status === 'paused' ? 'paused' : 'active',
      nextRunAt: null,
      lastRunAt: null,
      createdAt: now,
      updatedAt: now,
      createdBy: actor,
      grant,
    };
    if (task.status === 'active') task.nextRunAt = this.firstRun(task, now) ?? (schedule.type === 'once' ? schedule.at : null);
    this.tasks.push(task);
    log.info(`schedule: created ${task.id} "${task.name}" (${this.describe(task)})${actor ? ` by thread ${actor.threadId} on ${actor.machine}` : ''}`);
    this.changed();
    return task;
  }

  async update(id: string, patch: TaskInput, actor: TaskActor | null = null): Promise<ScheduledTask> {
    const current = this.require(id);
    // An agent must be allowed what the task can do now, and what it would do after the change.
    let grant = actor ? await this.authorize(actor, await this.taskPermissions(current), current.target) : null;
    const changes: Partial<ScheduledTask> = {};
    if (patch.name !== undefined) changes.name = String(patch.name).trim() || current.name;
    if (patch.prompt !== undefined) {
      const prompt = String(patch.prompt).trim();
      if (!prompt) throw new RpcError(-32602, 'prompt cannot be empty');
      if (prompt !== current.prompt) changes.prompt = prompt;
    }
    if (patch.model !== undefined) changes.model = patch.model || null;
    if (patch.effort !== undefined) changes.effort = patch.effort || null;
    // The app sends every field on save; only a real change of destination or permissions counts.
    const accessChanged = !!patch.access && patch.access !== current.access && (patch.target ?? current.target).type === 'newThread';
    if ((patch.target && !isSameTarget(patch.target, current.target)) || accessChanged) {
      const target = patch.target ?? current.target;
      // A new folder keeps the task's permissions unless new ones are given.
      const keep = current.target.type === 'newThread' && target.type === 'newThread' ? current.access : null;
      const resolved = await this.resolveTarget(target, patch.access ?? keep, actor);
      grant = await this.authorize(actor, resolved.permissions, resolved.target);
      changes.target = resolved.target;
      changes.access = resolved.access;
    }
    if (patch.status !== undefined && patch.status !== 'active' && patch.status !== 'paused') throw new RpcError(-32602, 'status must be "active" or "paused"');
    const now = Date.now();
    const schedule = patch.schedule !== undefined ? this.parse(patch.schedule, now) : null;

    // Apply to the task as it is now: a run may have fired while we waited on Codex.
    const task = this.require(id);
    const what = changes.prompt !== undefined || changes.target !== undefined || (changes.access !== undefined && changes.access !== task.access);
    Object.assign(task, changes, { updatedAt: now });
    // Saving the prompt or destination in the app approves them as they are, changed or not.
    if (what || (!actor && (patch.prompt !== undefined || patch.target !== undefined))) task.grant = grant;
    let reschedule = false;
    if (schedule) {
      task.schedule = schedule;
      reschedule = true;
      // A finished one-time task with a new time is live again.
      if (task.status === 'completed' && patch.status === undefined) task.status = 'active';
    }
    if (patch.status !== undefined && patch.status !== task.status) {
      task.status = patch.status;
      reschedule = true;
    }
    if (what) {
      // A message still waiting for its thread goes out again with the new prompt and destination.
      for (const run of this.runs) {
        if (run.taskId !== id || run.status !== 'waiting') continue;
        this.finish(run, 'interrupted', 'Replaced by the edited task', false);
        run.read = true;
        if (task.schedule.type === 'once' && task.status === 'completed') {
          task.status = 'active';
          reschedule = true;
        }
      }
    }
    if (reschedule) {
      task.nextRunAt = task.status === 'active' ? this.firstRun(task, now) : null;
      // Resuming a one-time task whose moment passed while paused runs it right away.
      if (task.status === 'active' && task.nextRunAt === null && task.schedule.type === 'once') task.nextRunAt = now;
    }
    this.changed();
    return task;
  }

  async remove(id: string, actor: TaskActor | null = null) {
    const task = this.require(id);
    if (actor) await this.authorize(actor, await this.taskPermissions(task), task.target);
    this.tasks = this.tasks.filter((t) => t.id !== id);
    for (const run of this.runs) {
      if (run.taskId === id && run.status === 'waiting') this.finish(run, 'interrupted', 'The task was deleted before the message was sent', false);
    }
    log.info(`schedule: deleted ${id} "${task.name}"`);
    this.changed();
  }

  async runNow(id: string, actor: TaskActor | null = null) {
    const task = this.require(id);
    if (actor) await this.authorize(actor, await this.taskPermissions(task), task.target);
    if (this.active(id)) throw new RpcError(-32000, `Task ${id} is already running`);
    return this.fire(task, 'manual', Date.now());
  }

  markRead(ids: string[] | 'all') {
    let any = false;
    for (const run of this.runs) {
      if (!run.read && (ids === 'all' || ids.includes(run.id)) && !live(run)) {
        run.read = true;
        any = true;
      }
    }
    if (any) this.changed();
  }

  private parse(input: ScheduleInput, now: number) {
    let spec;
    try {
      spec = parseSchedule(input, now, this.timezone);
    } catch (err) {
      throw new RpcError(-32602, errorMessage(err));
    }
    if (spec.type === 'once' && spec.at < now - 60_000) {
      throw new RpcError(-32602, `${new Date(spec.at).toISOString()} is in the past (it is ${new Date(now).toISOString()} on ${this.hostname})`);
    }
    return spec;
  }

  private firstRun(task: ScheduledTask, now: number) {
    return nextRun(task.schedule, now, this.timezone);
  }

  private require(id: string) {
    const task = this.get(id);
    if (!task) throw new RpcError(-32004, `No task ${id} on ${this.hostname}`);
    return task;
  }

  // ---------- permissions ----------

  /**
   * Checks that an agent may set up something with `permissions`, and returns the grant to record
   * (null for the user). Messages into the agent's own thread are always fine: that thread is the agent.
   */
  private async authorize(actor: TaskActor | null, permissions: TaskPermissions, target: TaskTarget): Promise<TaskGrant | null> {
    if (!actor) return null;
    const caller = await this.callerPermissions(actor);
    const grant: TaskGrant = { ...caller, machineId: actor.machineId, threadId: actor.threadId };
    if (caller.level === 'full') return grant;
    if (actor.machineId !== this.machineId) {
      throw new RpcError(-32003, `Only threads with full access can set up or change tasks on another machine; this thread has ${ACCESS_LABEL[caller.level]} permissions.`);
    }
    if (target.type === 'thread' && target.threadId === actor.threadId) return grant;
    if (!within(permissions, caller)) {
      throw new RpcError(
        -32003,
        `That task could do more than this thread may (${describePermissions(permissions)} vs. ${describePermissions(caller)}), so this thread cannot set it up or change it. ` +
          'Ask the user to do it in the Scheduled view, or use a folder this thread can write.',
      );
    }
    return grant;
  }

  /** What the calling agent's thread may do. Unknown details count as the least. */
  private async callerPermissions(actor: TaskActor): Promise<TaskPermissions> {
    const level = accessOfSandboxMode(actor.sandboxMode);
    if (level === 'full') return FULL;
    // Its folders are on another machine and mean nothing here.
    if (actor.machineId !== this.machineId) return { level, network: false, roots: [] };
    const known = this.threads.get(actor.threadId);
    if (known?.policy && accessOfPolicy(known.policy) === level) return permissionsOf(known.policy, known.cwd);
    let cwd = known?.cwd ?? null;
    if (!cwd && level === 'auto') {
      const res = await this.codex.request('thread/read', { threadId: actor.threadId }).catch(() => null);
      cwd = res?.thread?.cwd ?? null;
    }
    return { level, network: false, roots: level === 'auto' && cwd ? [cwd] : [] };
  }

  /** What a task's runs can do right now (an existing thread's permissions may have changed since). */
  private async taskPermissions(task: Pick<ScheduledTask, 'target' | 'access'>): Promise<TaskPermissions> {
    if (task.target.type === 'newThread') return newThreadPermissions(task.access, task.target.cwd);
    return this.threadPermissions(task.target.threadId);
  }

  private async threadPermissions(threadId: string): Promise<TaskPermissions> {
    const known = this.threads.get(threadId);
    if (known?.policy) return permissionsOf(known.policy, known.cwd);
    // Resuming a loaded thread again is not free of side effects, and threads Codex starts itself
    // (subagents) never pass through this host: assume the most.
    const loaded = await this.codex.request('thread/loaded/list', {}).catch(() => null);
    if (loaded?.data?.includes(threadId)) return FULL;
    let res;
    try {
      res = await this.codex.request('thread/resume', { threadId, excludeTurns: true, config: this.threadConfig() });
    } catch (err) {
      throw new RpcError(-32004, `Thread ${threadId} was not found on ${this.hostname}: ${errorMessage(err)}`);
    }
    this.noteThread(threadId, res?.sandbox, res?.cwd);
    return res?.sandbox ? permissionsOf(res.sandbox, res.cwd ?? null) : FULL;
  }

  /** Checks a destination and works out the permissions its runs get. */
  private async resolveTarget(
    input: NonNullable<TaskInput['target']>,
    requested: TaskAccess | null,
    actor: TaskActor | null,
  ): Promise<{ target: TaskTarget; access: TaskAccess; permissions: TaskPermissions }> {
    if (requested && !(requested in LEVEL)) throw new RpcError(-32602, 'access must be "read-only", "auto" or "full"');
    if (input.type === 'newThread') {
      const cwd = path.resolve(expandHome(String(input.cwd || '').trim() || os.homedir()));
      if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new RpcError(-32602, `Folder ${cwd} does not exist on ${this.hostname}`);
      // Agents get their own level by default (and cannot get more); the user gets the composer's default.
      const access = requested ?? (actor ? accessOfSandboxMode(actor.sandboxMode) : 'auto');
      return { target: { type: 'newThread', cwd }, access, permissions: newThreadPermissions(access, cwd) };
    }
    if (input.type !== 'thread' || !input.threadId) throw new RpcError(-32602, 'target needs a threadId or type "newThread"');
    const threadId = String(input.threadId);
    const own = !!actor && actor.threadId === threadId && actor.machineId === this.machineId;
    const permissions = own ? await this.callerPermissions(actor) : await this.threadPermissions(threadId);
    return { target: { type: 'thread', threadId }, access: permissions.level, permissions };
  }

  // ---------- timing ----------

  private arm() {
    if (this.timer) clearTimeout(this.timer);
    if (!this.started) return;
    const now = Date.now();
    const due = this.tasks.filter((t) => t.status === 'active' && t.nextRunAt !== null).map((t) => t.nextRunAt!);
    const wait = due.length ? Math.max(250, Math.min(MAX_SLEEP, Math.min(...due) - now)) : MAX_SLEEP;
    this.timer = setTimeout(() => this.tick(), wait);
  }

  private tick() {
    const now = Date.now();
    try {
      for (const task of this.tasks) {
        if (task.status !== 'active' || task.nextRunAt === null || task.nextRunAt > now) continue;
        const slot = task.nextRunAt;
        task.nextRunAt = task.schedule.type === 'once' ? null : nextRun(task.schedule, now, this.timezone, slot);
        if (task.schedule.type === 'once') task.status = 'completed';
        // A run still going (or waiting for its thread) absorbs the next slot instead of piling up.
        if (this.active(task.id)) {
          log.info(`schedule: ${task.id} skipped ${new Date(slot).toISOString()}, previous run still in progress`);
          this.changed();
          continue;
        }
        this.fire(task, 'schedule', slot);
      }
      if (this.runs.some((r) => r.status === 'waiting')) this.deliverAllWaiting();
    } catch (err) {
      log.error('schedule tick', errorMessage(err));
    }
    this.arm();
  }

  private active(taskId: string) {
    return this.runs.some((r) => r.taskId === taskId && live(r));
  }

  // ---------- runs ----------

  private fire(task: ScheduledTask, trigger: ScheduledRun['trigger'], scheduledFor: number) {
    const toThread = task.target.type === 'thread';
    const run: ScheduledRun = {
      id: newId('run'),
      taskId: task.id,
      taskName: task.name,
      trigger,
      scheduledFor,
      startedAt: null,
      finishedAt: null,
      // Messages into a thread queue up behind whatever that thread is doing.
      status: toThread ? 'waiting' : 'running',
      threadId: task.target.type === 'thread' ? task.target.threadId : null,
      turnId: null,
      summary: null,
      error: null,
      // Runs in an existing thread show up there; only fresh threads and failures land in the inbox.
      read: toThread,
    };
    task.lastRunAt = Date.now();
    this.runs.unshift(run);
    this.prune();
    log.info(`schedule: running ${task.id} "${task.name}" (${trigger})`);
    this.changed();
    if (run.threadId && toThread) void this.deliver(run.threadId);
    else void this.startThread(task, run).catch((err) => this.finish(run, 'failed', errorMessage(err)));
    return run;
  }

  private prune() {
    let finished = 0;
    this.runs = this.runs.filter((run) => live(run) || ++finished <= MAX_HISTORY);
  }

  private async startThread(task: ScheduledTask, run: ScheduledRun) {
    if (task.target.type !== 'newThread') return;
    const memoryDir = path.join(paths.tasks, task.id);
    fs.mkdirSync(memoryDir, { recursive: true });
    const perms = runPermissions(task.access, memoryDir);
    const started = await this.codex.request('thread/start', {
      cwd: task.target.cwd,
      model: task.model,
      approvalPolicy: 'never',
      sandbox: perms.sandbox,
      config: this.threadConfig(),
    });
    run.threadId = started.thread.id as string;
    this.noteThread(run.threadId, perms.sandboxPolicy, task.target.cwd);
    this.changed();
    await this.codex.request('thread/name/set', { threadId: run.threadId, name: task.name }).catch(() => {});
    await this.startTurn(task, run, {
      model: task.model,
      effort: task.effort,
      approvalPolicy: 'never',
      sandboxPolicy: perms.sandboxPolicy,
    });
  }

  /** Loads the thread into Codex if needed and reports whether a turn is running in it. */
  private async threadStatus(threadId: string): Promise<string> {
    if (this.busy.has(threadId)) return 'active';
    const loaded = await this.codex.request('thread/loaded/list', {}).catch(() => null);
    if (loaded?.data?.includes(threadId)) {
      const res = await this.codex.request('thread/read', { threadId });
      return res?.thread?.status?.type ?? 'idle';
    }
    const res = await this.codex.request('thread/resume', { threadId, excludeTurns: true, config: this.threadConfig() });
    this.noteThread(threadId, res?.sandbox, res?.cwd);
    return res?.thread?.status?.type ?? 'idle';
  }

  private async startTurn(task: ScheduledTask, run: ScheduledRun, overrides: Record<string, unknown>) {
    run.startedAt = Date.now();
    run.status = 'running';
    const res = await this.codex.request('turn/start', {
      threadId: run.threadId,
      input: [{ type: 'text', text: task.prompt, text_elements: [] }],
      clientUserMessageId: run.id,
      turnTrigger: 'scheduled',
      additionalContext: { scheduled_task: { kind: 'application', value: this.context(task) } },
      ...overrides,
    });
    run.turnId = res?.turn?.id ?? null;
    // The turn may already have ended while the reply was on its way.
    if (run.threadId && run.status === 'running') this.busy.add(run.threadId);
    this.changed();
  }

  /** Hidden context for the model: who sent this, how the task repeats, where its memory lives. */
  private context(task: ScheduledTask) {
    const lines = [
      `This message comes from the BetterCodex scheduled task "${task.name}" (id ${task.id}) on ${this.hostname}: ${this.describe(task)}.`,
      task.createdBy
        ? `An agent set it up from thread ${task.createdBy.threadId} on ${task.createdBy.machine}${task.target.type === 'thread' && task.createdBy.threadId === task.target.threadId ? ' (this thread)' : ''}.`
        : 'The user set it up in the BetterCodex app.',
      'Nobody typed it just now and the user may not be watching, so work without waiting for replies and end with a short report.',
    ];
    if (task.target.type === 'newThread') {
      const memory = path.join(paths.tasks, task.id, 'memory.md');
      lines.push(
        task.access === 'read-only'
          ? `Notes from earlier runs, if any, are in ${memory}. This run is read-only, so it cannot add to them.`
          : `Memory between runs: read ${memory} first if it exists; before finishing, append a short dated entry with what the next run needs to know.`,
      );
    }
    if (task.schedule.type !== 'once') {
      lines.push('Change, pause or delete this task with the scheduler tools (update_task, delete_task) when it is no longer needed.');
    }
    return lines.join('\n');
  }

  private finish(run: ScheduledRun, status: ScheduledRun['status'], error: string | null, notify = true) {
    run.status = status;
    run.error = error;
    run.finishedAt = Date.now();
    if (status !== 'completed') run.read = false;
    if (status === 'failed') log.warn(`schedule: run ${run.id} of ${run.taskId} failed: ${error}`);
    if (notify) this.changed();
  }

  private interruptRunning(reason: string) {
    let any = false;
    for (const run of this.runs) {
      if (run.status === 'running' && run.startedAt) {
        this.finish(run, 'interrupted', reason, false);
        any = true;
      }
    }
    if (any) this.changed();
  }

  private deliverAllWaiting() {
    const threads = new Set(this.runs.filter((r) => r.status === 'waiting' && r.threadId).map((r) => r.threadId!));
    for (const threadId of threads) void this.deliver(threadId);
  }

  /** Runs `fn` after every earlier delivery into the same thread has finished. */
  private withThreadLock(threadId: string, fn: () => Promise<void>) {
    const previous = this.locks.get(threadId) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    const settled = next.catch(() => {});
    this.locks.set(threadId, settled);
    void settled.then(() => {
      if (this.locks.get(threadId) === settled) this.locks.delete(threadId);
    });
    return next;
  }

  /** Sends the oldest message waiting for this thread, if the thread is free. */
  private deliver(threadId: string) {
    return this.withThreadLock(threadId, async () => {
      const waiting = () => this.runs.filter((r) => r.status === 'waiting' && r.threadId === threadId).sort((a, b) => a.scheduledFor - b.scheduledFor)[0];
      let run = waiting();
      while (run && !this.get(run.taskId)) {
        this.finish(run, 'interrupted', 'The task was deleted before the message was sent');
        run = waiting();
      }
      if (!run) return;
      const task = this.get(run.taskId)!;
      try {
        if ((await this.threadStatus(threadId)) === 'active') return;
        await this.checkGrant(task, threadId);
        await this.startTurn(task, run, {});
      } catch (err) {
        this.finish(run, 'failed', errorMessage(err));
      }
    }).catch((err) => log.error('schedule: delivery', errorMessage(err)));
  }

  /**
   * An agent's message into another thread goes out only while that thread still cannot do more than
   * the agent could when it set the message up; the user may have widened the thread's permissions since.
   */
  private async checkGrant(task: ScheduledTask, threadId: string) {
    const grant = task.grant;
    if (!grant || grant.level === 'full' || (grant.machineId === this.machineId && grant.threadId === threadId)) return;
    const now = await this.threadPermissions(threadId);
    if (!within(now, grant)) {
      throw new Error(
        `Thread ${threadId} now has ${describePermissions(now)}, more than the agent that scheduled this message had (${describePermissions(grant)}). Open the task in the Scheduled view and save it to allow it.`,
      );
    }
  }

  private onNotification(method: string, params: any) {
    switch (method) {
      case 'thread/status/changed':
        if (params?.status?.type === 'active') return;
        this.busy.delete(params?.threadId);
        if (this.runs.some((r) => r.status === 'waiting' && r.threadId === params.threadId)) void this.deliver(params.threadId);
        return;
      case 'item/started': {
        // Match the turn by our message id in case the turn/start reply has not been handled yet.
        const item = params?.item;
        if (item?.type !== 'userMessage' || !item.clientId) return;
        const run = this.runs.find((r) => r.id === item.clientId && r.status === 'running');
        if (run && !run.turnId) run.turnId = params.turnId;
        return;
      }
      case 'item/completed': {
        const item = params?.item;
        if (item?.type !== 'agentMessage' || !item.text) return;
        for (const run of this.runs) if (run.turnId === params.turnId && run.status === 'running') run.summary = String(item.text).slice(0, 2000);
        return;
      }
      case 'turn/completed': {
        const turn = params?.turn;
        if (!turn) return;
        this.busy.delete(params.threadId);
        const last = [...(turn.items ?? [])].reverse().find((i: any) => i.type === 'agentMessage' && i.text);
        const status = turn.status === 'completed' ? 'completed' : turn.status === 'interrupted' ? 'interrupted' : 'failed';
        for (const run of this.runs) {
          if (run.turnId !== turn.id || run.status !== 'running') continue;
          if (last) run.summary = String(last.text).slice(0, 2000);
          this.finish(run, status, turn.error?.message ?? null);
        }
        return;
      }
    }
  }

  // ---------- persistence ----------

  private changed() {
    this.save();
    this.arm();
    if (this.changeTimer) return;
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null;
      this.emit('changed', this.snapshot());
    }, 50);
  }

  private save() {
    try {
      writeJson(paths.schedules, { version: 1, tasks: this.tasks, runs: this.runs });
    } catch (err) {
      log.error('schedule: could not save', errorMessage(err));
    }
  }
}
