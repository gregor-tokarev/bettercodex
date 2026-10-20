import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describeSchedule, nextRun, parseSchedule, systemTimeZone, type ScheduleInput } from '../shared/schedule.js';
import type { ScheduledRun, ScheduledTask, ScheduleSnapshot, TaskAccess, TaskActor, TaskTarget } from '../shared/types.js';
import { RpcError, type CodexBridge } from './codex.js';
import { paths, readJson, writeJson } from './config.js';
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

const MAX_RUNS = 300;
/** Longest a timer sleeps, so a wall-clock jump (suspend, clock change) is noticed quickly. */
const MAX_SLEEP = 30_000;
const LEVEL: Record<TaskAccess, number> = { 'read-only': 0, auto: 1, full: 2 };
const ACCESS_LABEL: Record<TaskAccess, string> = { 'read-only': 'read-only', auto: 'default (workspace-write)', full: 'full access' };

/** Permissions of the thread an agent calls from, from Codex's sandbox mode in the turn metadata. */
export function accessOfSandboxMode(mode: string | null | undefined): TaskAccess {
  if (mode === 'danger-full-access' || mode === 'none') return 'full';
  if (mode === 'workspace-write') return 'auto';
  return 'read-only';
}

function accessOfPolicy(policy: { type?: string } | null | undefined): TaskAccess {
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

function newId(prefix: string) {
  return `${prefix}_${crypto.randomBytes(5).toString('hex')}`;
}

function expandHome(p: string) {
  return p === '~' ? os.homedir() : p.replace(/^~(?=\/)/, os.homedir());
}

/**
 * Runs this machine's scheduled tasks through its Codex app-server. Tasks keep running while the
 * app is closed: the host daemon outlives it. A run either starts a fresh thread or sends the prompt
 * into an existing thread, waiting for the thread's current turn to finish first.
 */
export class Scheduler extends EventEmitter {
  tasks: ScheduledTask[] = [];
  runs: ScheduledRun[] = [];
  readonly hostname = os.hostname();
  private timer: NodeJS.Timeout | null = null;
  private started = false;
  private changeTimer: NodeJS.Timeout | null = null;
  /** Sandbox level of threads seen going through this host, so permission checks rarely need Codex. */
  private threadAccess = new Map<string, TaskAccess>();
  private delivering = new Set<string>();

  constructor(
    private codex: CodexBridge,
    /** Per-thread config overrides that plug the host's MCP tools into Codex threads. */
    private threadConfig: () => Record<string, unknown>,
  ) {
    super();
    codex.on('notification', (method: string, params: any) => this.onNotification(method, params));
    codex.on('status', (status: string) => {
      if (status === 'ready') this.deliverAllWaiting();
      else this.interruptRunning('Codex stopped during the run');
    });
  }

  get timezone() {
    return systemTimeZone();
  }

  load() {
    const stored = readJson<{ tasks?: ScheduledTask[]; runs?: ScheduledRun[] }>(paths.schedules, {});
    this.tasks = Array.isArray(stored.tasks) ? stored.tasks : [];
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
        this.remove(params.id, actor);
        return meta();
      case 'schedule/run':
        return { run: this.runNow(params.id, actor), ...meta() };
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

  /** Remembers the permissions of threads started or changed through this host. */
  noteThread(threadId: string | undefined, policy: { type?: string } | null | undefined) {
    if (threadId && policy?.type) this.threadAccess.set(threadId, accessOfPolicy(policy));
  }

  // ---------- changes ----------

  async create(input: TaskInput, actor: TaskActor | null = null): Promise<ScheduledTask> {
    const prompt = String(input.prompt ?? '').trim();
    if (!prompt) throw new RpcError(-32602, 'prompt is required');
    if (!input.schedule) throw new RpcError(-32602, 'schedule is required');
    if (!input.target) throw new RpcError(-32602, 'target is required');
    const now = Date.now();
    const schedule = this.parse(input.schedule, now);
    const { target, access } = await this.resolveTarget(input.target, input.access ?? null, actor);
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
    };
    if (task.status === 'active') task.nextRunAt = this.firstRun(task, now);
    if (task.status === 'active' && task.nextRunAt === null && schedule.type === 'once') task.nextRunAt = schedule.at;
    this.tasks.push(task);
    log.info(`schedule: created ${task.id} "${task.name}" (${this.describe(task)})${actor ? ` by thread ${actor.threadId} on ${actor.machine}` : ''}`);
    this.changed();
    return task;
  }

  async update(id: string, patch: TaskInput, actor: TaskActor | null = null): Promise<ScheduledTask> {
    const task = this.require(id, actor);
    const now = Date.now();
    const next: ScheduledTask = { ...task, updatedAt: now };
    if (patch.name !== undefined) next.name = String(patch.name).trim() || task.name;
    if (patch.prompt !== undefined) {
      next.prompt = String(patch.prompt).trim();
      if (!next.prompt) throw new RpcError(-32602, 'prompt cannot be empty');
    }
    if (patch.model !== undefined) next.model = patch.model || null;
    if (patch.effort !== undefined) next.effort = patch.effort || null;
    if (patch.target !== undefined || (patch.access !== undefined && patch.access !== null)) {
      const target = patch.target ?? task.target;
      // A new folder keeps the task's permissions unless new ones are given.
      const keep = task.target.type === 'newThread' && target.type === 'newThread' ? task.access : null;
      const resolved = await this.resolveTarget(target, patch.access ?? keep, actor);
      next.target = resolved.target;
      next.access = resolved.access;
    }
    let reschedule = false;
    if (patch.schedule !== undefined) {
      next.schedule = this.parse(patch.schedule, now);
      reschedule = true;
      // A finished one-time task with a new time is live again.
      if (task.status === 'completed' && patch.status === undefined) next.status = 'active';
    }
    if (patch.status !== undefined && patch.status !== task.status) {
      if (patch.status !== 'active' && patch.status !== 'paused') throw new RpcError(-32602, 'status must be "active" or "paused"');
      next.status = patch.status;
      reschedule = true;
    }
    if (reschedule) {
      next.nextRunAt = next.status === 'active' ? this.firstRun(next, now) : null;
      // Resuming a one-time task whose moment passed while paused runs it right away.
      if (next.status === 'active' && next.nextRunAt === null && next.schedule.type === 'once') next.nextRunAt = now;
    }
    Object.assign(task, next);
    this.changed();
    return task;
  }

  remove(id: string, actor: TaskActor | null = null) {
    const task = this.require(id, actor);
    this.tasks = this.tasks.filter((t) => t !== task);
    for (const run of this.runs) {
      if (run.taskId === id && run.status === 'waiting') this.finish(run, 'interrupted', 'The task was deleted before the message was sent', false);
    }
    log.info(`schedule: deleted ${id} "${task.name}"`);
    this.changed();
  }

  runNow(id: string, actor: TaskActor | null = null) {
    const task = this.require(id, actor);
    if (this.active(task.id)) throw new RpcError(-32000, `Task ${id} is already running`);
    return this.fire(task, 'manual', Date.now());
  }

  markRead(ids: string[] | 'all') {
    let any = false;
    for (const run of this.runs) {
      if (!run.read && (ids === 'all' || ids.includes(run.id)) && run.status !== 'running' && run.status !== 'waiting') {
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

  private require(id: string, actor: TaskActor | null) {
    const task = this.get(id);
    if (!task) throw new RpcError(-32004, `No task ${id} on ${this.hostname}`);
    if (actor) {
      const level = accessOfSandboxMode(actor.sandboxMode);
      if (LEVEL[task.access] > LEVEL[level]) {
        throw new RpcError(
          -32003,
          `Task ${id} runs with ${ACCESS_LABEL[task.access]}, more than this thread's ${ACCESS_LABEL[level]}, so it cannot change it. Ask the user to change it in the Scheduled view.`,
        );
      }
    }
    return task;
  }

  /** Checks a destination and works out the permissions runs get, capped at the calling agent's. */
  private async resolveTarget(
    input: NonNullable<TaskInput['target']>,
    requested: TaskAccess | null,
    actor: TaskActor | null,
  ): Promise<{ target: TaskTarget; access: TaskAccess }> {
    const limit = actor ? accessOfSandboxMode(actor.sandboxMode) : 'full';
    if (requested && !(requested in LEVEL)) throw new RpcError(-32602, 'access must be "read-only", "auto" or "full"');
    if (input.type === 'newThread') {
      const cwd = path.resolve(expandHome(String(input.cwd || '').trim() || os.homedir()));
      if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new RpcError(-32602, `Folder ${cwd} does not exist on ${this.hostname}`);
      const access = requested ?? (actor ? limit : 'auto');
      if (LEVEL[access] > LEVEL[limit]) {
        throw new RpcError(-32003, `This thread has ${ACCESS_LABEL[limit]} permissions, so its tasks cannot run with ${ACCESS_LABEL[access]}.`);
      }
      return { target: { type: 'newThread', cwd }, access };
    }
    if (input.type !== 'thread' || !input.threadId) throw new RpcError(-32602, 'target needs a threadId or type "newThread"');
    const threadId = String(input.threadId);
    // Messages make the target thread act with its own permissions; an agent may only nudge threads
    // that cannot do more than it can, besides itself.
    const own = !!actor && actor.threadId === threadId && actor.machine === this.hostname;
    const access = own ? limit : await this.accessOfThread(threadId);
    if (actor && !own && LEVEL[access] > LEVEL[limit]) {
      throw new RpcError(-32003, `Thread ${threadId} runs with ${ACCESS_LABEL[access]}, more than this thread's ${ACCESS_LABEL[limit]}, so it cannot be sent scheduled messages from here.`);
    }
    return { target: { type: 'thread', threadId }, access };
  }

  private async accessOfThread(threadId: string): Promise<TaskAccess> {
    const known = this.threadAccess.get(threadId);
    if (known) return known;
    // Resuming a loaded thread again is not free of side effects, and threads Codex starts itself
    // (subagents) never pass through this host: assume the most.
    const loaded = await this.codex.request('thread/loaded/list', {}).catch(() => null);
    if (loaded?.data?.includes(threadId)) return 'full';
    try {
      const res = await this.codex.request('thread/resume', { threadId, excludeTurns: true, config: this.threadConfig() });
      this.noteThread(threadId, res?.sandbox);
      return accessOfPolicy(res?.sandbox);
    } catch (err) {
      throw new RpcError(-32004, `Thread ${threadId} was not found on ${this.hostname}: ${errorMessage(err)}`);
    }
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
    return this.runs.some((r) => r.taskId === taskId && (r.status === 'running' || r.status === 'waiting'));
  }

  // ---------- runs ----------

  private fire(task: ScheduledTask, trigger: ScheduledRun['trigger'], scheduledFor: number) {
    const run: ScheduledRun = {
      id: newId('run'),
      taskId: task.id,
      taskName: task.name,
      trigger,
      scheduledFor,
      startedAt: null,
      finishedAt: null,
      status: 'running',
      threadId: task.target.type === 'thread' ? task.target.threadId : null,
      turnId: null,
      summary: null,
      error: null,
      // Runs in an existing thread show up there; only fresh threads and failures land in the inbox.
      read: task.target.type === 'thread',
    };
    task.lastRunAt = Date.now();
    this.runs.unshift(run);
    if (this.runs.length > MAX_RUNS) this.runs.length = MAX_RUNS;
    log.info(`schedule: running ${task.id} "${task.name}" (${trigger})`);
    this.changed();
    void this.execute(task, run).catch((err) => this.finish(run, 'failed', errorMessage(err)));
    return run;
  }

  private async execute(task: ScheduledTask, run: ScheduledRun) {
    if (task.target.type === 'newThread') {
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
      this.noteThread(run.threadId, perms.sandboxPolicy);
      this.changed();
      await this.codex.request('thread/name/set', { threadId: run.threadId, name: task.name }).catch(() => {});
      await this.startTurn(task, run, {
        model: task.model,
        effort: task.effort,
        approvalPolicy: 'never',
        sandboxPolicy: perms.sandboxPolicy,
      });
      return;
    }
    const threadId = task.target.threadId;
    const status = await this.threadStatus(threadId);
    if (status === 'active') {
      run.status = 'waiting';
      this.changed();
      return;
    }
    await this.startTurn(task, run, {});
  }

  /** Loads the thread into Codex if needed and reports whether a turn is running in it. */
  private async threadStatus(threadId: string): Promise<string> {
    const loaded = await this.codex.request('thread/loaded/list', {}).catch(() => null);
    if (loaded?.data?.includes(threadId)) {
      const res = await this.codex.request('thread/read', { threadId });
      return res?.thread?.status?.type ?? 'idle';
    }
    const res = await this.codex.request('thread/resume', { threadId, excludeTurns: true, config: this.threadConfig() });
    this.noteThread(threadId, res?.sandbox);
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
    for (const threadId of threads) void this.deliverWaiting(threadId, true);
  }

  /** Sends the oldest message that waited for this thread, now that its turn ended. */
  private async deliverWaiting(threadId: string, checkStatus: boolean) {
    if (this.delivering.has(threadId)) return;
    const run = this.runs.filter((r) => r.status === 'waiting' && r.threadId === threadId).sort((a, b) => a.scheduledFor - b.scheduledFor)[0];
    if (!run) return;
    const task = this.get(run.taskId);
    if (!task) {
      this.finish(run, 'interrupted', 'The task was deleted before the message was sent');
      return;
    }
    this.delivering.add(threadId);
    try {
      if (checkStatus && (await this.threadStatus(threadId)) === 'active') return;
      await this.startTurn(task, run, {});
    } catch (err) {
      this.finish(run, 'failed', errorMessage(err));
    } finally {
      this.delivering.delete(threadId);
    }
  }

  private onNotification(method: string, params: any) {
    switch (method) {
      case 'thread/status/changed':
        if (params?.status?.type !== 'active' && this.runs.some((r) => r.status === 'waiting' && r.threadId === params.threadId)) {
          void this.deliverWaiting(params.threadId, params.status?.type === 'notLoaded');
        }
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
        const run = this.runs.find((r) => r.turnId === params.turnId && r.status === 'running');
        if (run) run.summary = String(item.text).slice(0, 2000);
        return;
      }
      case 'turn/completed': {
        const turn = params?.turn;
        const run = turn && this.runs.find((r) => r.turnId === turn.id && r.status === 'running');
        if (!run) return;
        const last = [...(turn.items ?? [])].reverse().find((i: any) => i.type === 'agentMessage' && i.text);
        if (last) run.summary = String(last.text).slice(0, 2000);
        const status = turn.status === 'completed' ? 'completed' : turn.status === 'interrupted' ? 'interrupted' : 'failed';
        this.finish(run, status, turn.error?.message ?? null);
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
