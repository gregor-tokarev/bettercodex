import os from 'node:os';
import { describeSchedule, formatWall, relativeTo } from '../../shared/schedule.js';
import type { RelayMachine, ScheduledRun, ScheduledTask, ScheduleSnapshot, TaskActor } from '../../shared/types.js';
import type { CodexBridge } from '../codex.js';
import { errorMessage } from '../log.js';
import type { Scheduler, TaskInput } from '../scheduler.js';
import type { ToolContext, ToolResult } from './tools.js';

/** Reaches the other machines through the BetterCodex app connected to this host. */
export interface Relay {
  /** null when no app is connected to this host right now. */
  machines(): Promise<RelayMachine[] | null>;
  call<T = any>(machine: string, method: string, params: unknown): Promise<T>;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  run: (args: any, ctx: ToolContext) => Promise<string>;
}

/** Where a schedule/* call goes: this host's scheduler, or another machine through the app. */
type Place = { local: true; name: string } | { local: false; name: string };

const machineProp = {
  type: 'string',
  description: 'Machine name from list_machines. Defaults to this machine.',
};
const scheduleProp = {
  type: 'object',
  description:
    'When to run. {"type":"once","inMinutes":30} or {"type":"once","at":"2026-10-21T09:00"} (or "18:30" for the next 18:30) for a single run; ' +
    '{"type":"interval","everyMinutes":180}; {"type":"cron","expression":"0 9 * * 1-5"} (5 fields: minute hour day month weekday). ' +
    'Times without an offset are in the target machine\'s time zone unless `timezone` (IANA name) is set.',
  properties: {
    type: { type: 'string', enum: ['once', 'interval', 'cron'] },
    at: { type: 'string' },
    inMinutes: { type: 'number' },
    everyMinutes: { type: 'number' },
    expression: { type: 'string' },
    timezone: { type: 'string' },
  },
  required: ['type'],
};
const threadProp = {
  type: 'string',
  description:
    '"current" sends the prompt back into this thread later (delayed message, follow-up check or heartbeat); a thread id sends it into that existing thread; ' +
    '"new" starts a fresh thread in `cwd` for every run.',
};
const accessProp = {
  type: 'string',
  enum: ['read-only', 'auto', 'full'],
  description: 'Permissions of "new" thread runs (they never ask for approval). Defaults to this thread\'s and cannot exceed them.',
};

const ACCESS_TEXT = { 'read-only': 'read-only', auto: 'default permissions', full: 'full access' } as const;

/** Lets agents list, create, change and delete scheduled tasks on every connected machine. */
export class ScheduleTools {
  readonly name = 'scheduler';
  readonly defs: ToolDef[];

  constructor(
    private scheduler: Scheduler,
    private relay: Relay,
    private codex: CodexBridge,
  ) {
    this.defs = this.buildDefs();
  }

  instructions() {
    return `# Scheduled tasks

BetterCodex runs prompts later or on a schedule, on this machine (${os.hostname()}) and on the other machines the BetterCodex app is connected to (see \`list_machines\`). A task lives on the machine that runs it and keeps running while the app is closed; reaching other machines needs the app to be open.

Choose where each run goes with \`thread\`:
- "current": comes back to this thread later with the prompt as a new message, keeping the context and permissions. Use it for delayed messages, follow-up checks ("look at the deploy again in 20 minutes") and recurring heartbeats. If a turn is still running then, the message waits for it to end.
- a thread id: sends the prompt into that existing thread on that machine the same way.
- "new": every run starts a fresh thread in \`cwd\` (default: this thread's folder; on another machine, its home folder). These runs never ask for approval, get a memory file to keep notes between runs, and report to the Scheduled inbox in the app.

A task cannot do more than this thread: no higher permissions, no network or folders this thread lacks, and no messages into threads that can do more. Setting up tasks on other machines needs a thread with full access.

Write prompts that make sense on their own when they arrive later. Before creating a task that may already exist, check \`list_tasks\`. Delete heartbeats and one-off checks you created once their job is done.
`;
  }

  list() {
    return this.defs.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations }));
  }

  async call(name: string, args: any, ctx: ToolContext): Promise<ToolResult> {
    const def = this.defs.find((d) => d.name === name);
    if (!def) return { content: [{ type: 'text', text: `Unknown tool ${name}` }], isError: true };
    try {
      return { content: [{ type: 'text', text: await def.run(args ?? {}, ctx) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${errorMessage(err)}` }], isError: true };
    }
  }

  // ---------- helpers ----------

  private actor(ctx: ToolContext): TaskActor {
    return { machine: os.hostname(), machineId: this.scheduler.machineId, threadId: ctx.threadId, sandboxMode: ctx.sandboxMode ?? null };
  }

  /** Whether a machine name means this machine, by the name the app shows for it or the hostname. */
  private async place(machine?: string): Promise<Place> {
    const name = String(machine ?? '').trim();
    const here: Place = { local: true, name: os.hostname() };
    if (!name || ['this', 'current', 'here'].includes(name.toLowerCase())) return here;
    const list = await this.relay.machines().catch(() => null);
    const match = list?.find((m) => m.name.toLowerCase() === name.toLowerCase());
    if (match) return { local: match.current, name: match.name } as Place;
    if (name.toLowerCase() === os.hostname().toLowerCase()) return here;
    return { local: false, name };
  }

  private async rpc<T = any>(place: Place, method: string, params: Record<string, unknown>): Promise<T> {
    if (place.local) return this.scheduler.rpc(method, params);
    try {
      return await this.relay.call<T>(place.name, method, params);
    } catch (err) {
      throw new Error(`${place.name}: ${errorMessage(err)}`);
    }
  }

  /** Machines to look at: every connected one, or just this one when no app is around. */
  private async machines(): Promise<{ list: RelayMachine[]; appConnected: boolean }> {
    const list = await this.relay.machines().catch(() => null);
    if (list) return { list, appConnected: true };
    return { list: [{ name: os.hostname(), hostname: os.hostname(), type: 'local', connected: true, current: true }], appConnected: false };
  }

  /** Finds the machine that has a task when the caller did not say. */
  private async locate(id: string, machine?: string): Promise<Place> {
    if (machine) return await this.place(machine);
    if (this.scheduler.get(id)) return { local: true, name: os.hostname() };
    const { list } = await this.machines();
    for (const m of list) {
      if (m.current || !m.connected) continue;
      const snap = await this.relay.call<ScheduleSnapshot>(m.name, 'schedule/list', {}).catch(() => null);
      if (snap?.tasks.some((t) => t.id === id)) return { local: false, name: m.name };
    }
    throw new Error(`No task ${id} on any connected machine. Use list_tasks to see the tasks.`);
  }

  private async callerCwd(ctx: ToolContext): Promise<string | undefined> {
    try {
      const res = await this.codex.request('thread/read', { threadId: ctx.threadId });
      return res?.thread?.cwd ?? undefined;
    } catch {
      return undefined;
    }
  }

  /** Turns the tool's `thread`/`cwd` arguments into a task destination. */
  private async target(args: any, place: Place, ctx: ToolContext): Promise<TaskInput['target']> {
    const thread = String(args.thread ?? '').trim();
    if (!thread) throw new Error('thread is required: "current", "new" or a thread id');
    if (thread === 'current') {
      if (!place.local) throw new Error(`"current" is a thread on ${os.hostname()}, not on ${place.name}. Use "new" or a thread id from that machine.`);
      if (!ctx.threadId || ctx.threadId === 'unassigned') throw new Error('This call did not come from a thread; pass a thread id or "new".');
      return { type: 'thread', threadId: ctx.threadId };
    }
    if (thread === 'new') return { type: 'newThread', cwd: args.cwd || (place.local ? await this.callerCwd(ctx) : undefined) };
    return { type: 'thread', threadId: thread };
  }

  private describeTask(task: ScheduledTask, snap: { timezone: string; now: number; runs: ScheduledRun[] }, ctx: ToolContext, local: boolean) {
    const tz = snap.timezone;
    const lines = [`- ${task.id} "${task.name}" — ${task.status}, ${describeSchedule(task.schedule, tz)}`];
    if (task.nextRunAt && task.status === 'active') lines[0] += `, next ${formatWall(task.nextRunAt, tz)} (${relativeTo(task.nextRunAt, snap.now)})`;
    const dest =
      task.target.type === 'thread'
        ? task.target.threadId === ctx.threadId && local
          ? 'this thread'
          : `thread ${task.target.threadId}`
        : `a new thread in ${task.target.cwd} (${[task.model, task.effort && `${task.effort} effort`, ACCESS_TEXT[task.access]].filter(Boolean).join(', ')})`;
    lines.push(`  → ${dest}`);
    lines.push(`  prompt: ${oneLine(task.prompt, 300)}`);
    const last = snap.runs.find((r) => r.taskId === task.id);
    if (last) lines.push(`  last run: ${runLine(last, tz)}`);
    return lines.join('\n');
  }

  private created(verb: string, task: ScheduledTask, meta: { hostname: string; timezone: string; now: number }, ctx: ToolContext, local: boolean) {
    const next = task.nextRunAt && task.status === 'active' ? `next run ${formatWall(task.nextRunAt, meta.timezone, true)} ${meta.timezone} (${relativeTo(task.nextRunAt, meta.now)})` : task.status;
    return `${verb} task ${task.id} on ${meta.hostname}: ${describeSchedule(task.schedule, meta.timezone)}; ${next}.\n${this.describeTask(task, { ...meta, runs: [] }, ctx, local)}`;
  }

  // ---------- tool definitions ----------

  private buildDefs(): ToolDef[] {
    return [
      {
        name: 'list_machines',
        description: 'Machines BetterCodex can schedule tasks on: this one and the others the BetterCodex app is connected to.',
        inputSchema: { type: 'object', properties: {} },
        annotations: { readOnlyHint: true },
        run: async () => {
          const { list, appConnected } = await this.machines();
          const lines = list.map((m) => {
            const notes = [m.current ? 'this machine' : null, m.type === 'local' && !m.current ? 'the computer running the BetterCodex app' : null, m.type === 'ssh' ? 'SSH' : null, m.connected ? null : 'not connected'];
            const host = m.hostname && m.hostname !== m.name ? ` (hostname ${m.hostname})` : '';
            return `- ${m.name}${host} — ${notes.filter(Boolean).join(', ')}`;
          });
          if (!appConnected) lines.push('', 'The BetterCodex app is not connected to this machine right now, so other machines cannot be reached.');
          return lines.join('\n');
        },
      },
      {
        name: 'list_tasks',
        description: 'Scheduled tasks with their schedule, destination, next run and last result. Covers every connected machine unless `machine` is given.',
        inputSchema: {
          type: 'object',
          properties: {
            machine: { type: 'string', description: 'One machine (from list_machines); omit for all of them.' },
            includeFinished: { type: 'boolean', description: 'Also show one-time tasks that already ran.' },
          },
        },
        annotations: { readOnlyHint: true },
        run: async (args, ctx) => {
          let targets: Array<{ place: Place; connected: boolean }>;
          let note = '';
          if (args.machine) {
            targets = [{ place: await this.place(args.machine), connected: true }];
          } else {
            const { list, appConnected } = await this.machines();
            targets = list.map((m) => ({ place: { local: m.current, name: m.name } as Place, connected: m.connected }));
            if (!appConnected) note = '\n\nOther machines are unavailable: the BetterCodex app is not connected to this machine right now.';
          }
          const sections = await Promise.all(
            targets.map(async ({ place, connected }) => {
              if (!connected) return `${place.name}: not connected`;
              try {
                const snap = await this.rpc<ScheduleSnapshot>(place, 'schedule/list', {});
                const tasks = snap.tasks.filter((t) => args.includeFinished || t.status !== 'completed');
                const head = `${place.name}${place.local ? ' (this machine)' : ''} — ${snap.timezone}, now ${formatWall(snap.now, snap.timezone, true)}`;
                if (!tasks.length) return `${head}\n  no ${args.includeFinished ? '' : 'active or paused '}tasks`;
                return `${head}\n${tasks.map((t) => this.describeTask(t, snap, ctx, place.local)).join('\n')}`;
              } catch (err) {
                return `${place.name}: ${errorMessage(err)}`;
              }
            }),
          );
          return sections.join('\n\n') + note;
        },
      },
      {
        name: 'create_task',
        description:
          'Schedule a prompt: a delayed message or recurring check-in for this thread, a message to another thread, or a job that starts a fresh thread on each run. ' +
          'Works on any connected machine.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Short title shown in the app.' },
            prompt: { type: 'string', description: 'The message each run sends. It should make sense on its own when it arrives.' },
            schedule: scheduleProp,
            thread: threadProp,
            cwd: { type: 'string', description: 'Project folder for "new" thread runs.' },
            machine: machineProp,
            model: { type: 'string', description: 'Model for "new" thread runs; defaults to the machine\'s Codex default.' },
            effort: { type: 'string', description: 'Reasoning effort for "new" thread runs.' },
            access: accessProp,
            paused: { type: 'boolean', description: 'Create it paused.' },
          },
          required: ['prompt', 'schedule', 'thread'],
        },
        run: async (args, ctx) => {
          const place = await this.place(args.machine);
          const task: TaskInput = {
            name: args.name,
            prompt: args.prompt,
            schedule: args.schedule,
            target: await this.target(args, place, ctx),
            model: args.model ?? null,
            effort: args.effort ?? null,
            access: args.access ?? null,
            status: args.paused ? 'paused' : 'active',
          };
          const res = await this.rpc(place, 'schedule/create', { task, actor: this.actor(ctx) });
          return this.created('Created', res.task, { ...res, hostname: place.name }, ctx, place.local);
        },
      },
      {
        name: 'update_task',
        description: 'Change a scheduled task: its prompt, name, schedule, destination, model or permissions, or pause/resume it with status.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            machine: { type: 'string', description: 'Machine of the task; found automatically when omitted.' },
            name: { type: 'string' },
            prompt: { type: 'string' },
            schedule: scheduleProp,
            status: { type: 'string', enum: ['active', 'paused'] },
            thread: threadProp,
            cwd: { type: 'string' },
            model: { type: 'string' },
            effort: { type: 'string' },
            access: accessProp,
          },
          required: ['id'],
        },
        run: async (args, ctx) => {
          const place = await this.locate(args.id, args.machine);
          const patch: TaskInput = {};
          for (const key of ['name', 'prompt', 'schedule', 'status', 'model', 'effort', 'access'] as const) {
            if (args[key] !== undefined) (patch as any)[key] = args[key];
          }
          if (args.thread !== undefined) patch.target = await this.target(args, place, ctx);
          else if (args.cwd !== undefined) patch.target = { type: 'newThread', cwd: args.cwd };
          const res = await this.rpc(place, 'schedule/update', { id: args.id, patch, actor: this.actor(ctx) });
          return this.created('Updated', res.task, { ...res, hostname: place.name }, ctx, place.local);
        },
      },
      {
        name: 'delete_task',
        description: 'Delete a scheduled task. A message still waiting for its thread is dropped; a run in progress finishes.',
        inputSchema: { type: 'object', properties: { id: { type: 'string' }, machine: { type: 'string', description: 'Found automatically when omitted.' } }, required: ['id'] },
        annotations: { destructiveHint: true },
        run: async (args, ctx) => {
          const place = await this.locate(args.id, args.machine);
          await this.rpc(place, 'schedule/delete', { id: args.id, actor: this.actor(ctx) });
          return `Deleted task ${args.id} on ${place.name}.`;
        },
      },
      {
        name: 'run_task',
        description: 'Run a scheduled task right away, outside its schedule.',
        inputSchema: { type: 'object', properties: { id: { type: 'string' }, machine: { type: 'string', description: 'Found automatically when omitted.' } }, required: ['id'] },
        run: async (args, ctx) => {
          const place = await this.locate(args.id, args.machine);
          const res = await this.rpc<{ run: ScheduledRun }>(place, 'schedule/run', { id: args.id, actor: this.actor(ctx) });
          return `Started run ${res.run.id} of task ${args.id} on ${place.name}.${res.run.threadId ? ` It goes to thread ${res.run.threadId}.` : ''} See task_runs for the result.`;
        },
      },
      {
        name: 'task_runs',
        description: 'Recent runs of scheduled tasks with their status, thread and final message.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Only runs of this task.' },
            machine: { type: 'string', description: 'Defaults to the task\'s machine, or this machine.' },
            limit: { type: 'number', description: 'Default 10.' },
          },
        },
        annotations: { readOnlyHint: true },
        run: async (args) => {
          const place = args.id ? await this.locate(args.id, args.machine) : await this.place(args.machine);
          const snap = await this.rpc<ScheduleSnapshot>(place, 'schedule/list', {});
          const runs = snap.runs.filter((r) => !args.id || r.taskId === args.id).slice(0, Math.max(1, Math.min(args.limit ?? 10, 50)));
          if (!runs.length) return `No runs yet on ${place.name}${args.id ? ` for ${args.id}` : ''}.`;
          return runs
            .map((r) => {
              const lines = [`- ${r.id} of ${r.taskId} "${r.taskName}": ${runLine(r, snap.timezone)}`];
              if (r.summary) lines.push(`  result: ${oneLine(r.summary, 600)}`);
              return lines.join('\n');
            })
            .join('\n');
        },
      },
    ];
  }
}

function oneLine(text: string, max: number) {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function runLine(run: ScheduledRun, tz: string) {
  const when = formatWall(run.startedAt ?? run.scheduledFor, tz);
  const parts = [`${run.status} ${when}`];
  if (run.trigger === 'manual') parts.push('run by hand');
  if (run.threadId) parts.push(`thread ${run.threadId}`);
  if (run.error) parts.push(`error: ${oneLine(run.error, 300)}`);
  return parts.join(', ');
}
