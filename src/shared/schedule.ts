// Schedule math shared by the host (when to run) and the app (previews and labels).
// No imports, so tests can load this file directly with Node.

export type ScheduleSpec =
  | { type: 'once'; at: number }
  | { type: 'interval'; everyMinutes: number }
  /** Five-field cron expression evaluated in `timezone` (null = the machine's own time zone). */
  | { type: 'cron'; expression: string; timezone: string | null };

/** Looser form accepted from agents and the app; normalized by `parseSchedule`. */
export interface ScheduleInput {
  type: 'once' | 'interval' | 'cron';
  /** once: ISO date-time (with or without offset), "HH:MM" (next such time) or epoch milliseconds. */
  at?: string | number;
  inMinutes?: number;
  everyMinutes?: number;
  expression?: string;
  timezone?: string | null;
}

const MINUTE = 60_000;

export function systemTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

export function isValidTimeZone(tz: string) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// ---------- time zones ----------

const formatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(tz: string) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      weekday: 'short',
    });
    formatters.set(tz, f);
  }
  return f;
}

export interface WallTime {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number; // 0 = Sunday
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Wall-clock time of an instant in a time zone. */
export function wallTime(instant: number, tz: string): WallTime {
  const out: Record<string, string> = {};
  for (const p of partsFormatter(tz).formatToParts(new Date(instant))) out[p.type] = p.value;
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: Number(out.hour) % 24,
    minute: Number(out.minute),
    second: Number(out.second),
    weekday: WEEKDAYS.indexOf(out.weekday),
  };
}

function offsetAt(instant: number, tz: string) {
  const w = wallTime(instant, tz);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - Math.floor(instant / 1000) * 1000;
}

/**
 * The instant a wall-clock time happens in a time zone. A time skipped by a DST jump resolves
 * to the same distance past the jump; a repeated one resolves to its first occurrence.
 */
export function zonedInstant(year: number, month: number, day: number, hour: number, minute: number, tz: string): number {
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  const before = naive - offsetAt(naive - 24 * 3600_000, tz);
  const after = naive - offsetAt(naive + 24 * 3600_000, tz);
  const candidates = [before, after].filter((t) => naive - offsetAt(t, tz) === t).sort((a, b) => a - b);
  if (candidates.length) return candidates[0];
  // In a DST gap: keep the pre-jump offset, which lands just after the jump.
  return before;
}

// ---------- cron ----------

interface CronFields {
  minutes: Set<number>;
  hours: Set<number>;
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  daysRestricted: boolean;
  weekdaysRestricted: boolean;
}

const MACROS: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};
const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function parseField(field: string, min: number, max: number, names: string[] | null, label: string): Set<number> {
  const out = new Set<number>();
  const value = (s: string) => {
    const lower = s.toLowerCase();
    if (names) {
      const idx = names.indexOf(lower);
      if (idx >= 0) return idx + (names === MONTH_NAMES ? 1 : 0);
    }
    if (!/^\d+$/.test(s)) throw new Error(`Invalid ${label} "${s}"`);
    return Number(s);
  };
  for (const part of field.split(',')) {
    const [range, stepText] = part.split('/');
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new Error(`Invalid step in ${label} "${part}"`);
    let lo: number;
    let hi: number;
    if (range === '*') {
      lo = min;
      hi = max;
    } else if (range.includes('-')) {
      const [a, b] = range.split('-');
      lo = value(a);
      hi = value(b);
    } else {
      lo = value(range);
      hi = stepText === undefined ? lo : max;
    }
    if (lo < min || hi > max || lo > hi) throw new Error(`${label} "${part}" is out of range ${min}-${max}`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  // Day of week 7 is Sunday too.
  if (label === 'day of week' && out.delete(7)) out.add(0);
  return out;
}

export function parseCron(expression: string): CronFields {
  const expr = MACROS[expression.trim().toLowerCase()] ?? expression.trim();
  const fields = expr.split(/\s+/);
  if (fields.length !== 5) throw new Error(`A cron expression has 5 fields (minute hour day-of-month month day-of-week), got "${expression}"`);
  const [mi, h, dom, mon, dow] = fields;
  return {
    minutes: parseField(mi, 0, 59, null, 'minute'),
    hours: parseField(h, 0, 23, null, 'hour'),
    days: parseField(dom, 1, 31, null, 'day of month'),
    months: parseField(mon, 1, 12, MONTH_NAMES, 'month'),
    weekdays: parseField(dow, 0, 7, DAY_NAMES, 'day of week'),
    // Like Vixie cron, a field starting with * (also */n) does not count as a restriction.
    daysRestricted: !dom.startsWith('*'),
    weekdaysRestricted: !dow.startsWith('*'),
  };
}

function dayMatches(c: CronFields, day: number, weekday: number) {
  // Classic cron: when both day fields are restricted, either one matching is enough.
  if (c.daysRestricted && c.weekdaysRestricted) return c.days.has(day) || c.weekdays.has(weekday);
  return c.days.has(day) && c.weekdays.has(weekday);
}

/** First time strictly after `after` that matches the cron expression, or null within five years. */
export function nextCronTime(expression: string, after: number, tz: string): number | null {
  const c = parseCron(expression);
  const start = wallTime(after, tz);
  // Walk wall-clock time using a UTC Date as a calendar; convert matches back to real instants.
  const cursor = new Date(Date.UTC(start.year, start.month - 1, start.day, start.hour, start.minute + 1));
  const limit = Date.UTC(start.year + 5, start.month - 1, start.day);
  while (cursor.getTime() < limit) {
    const month = cursor.getUTCMonth() + 1;
    if (!c.months.has(month)) {
      cursor.setUTCMonth(cursor.getUTCMonth() + 1, 1);
      cursor.setUTCHours(0, 0, 0, 0);
      continue;
    }
    if (!dayMatches(c, cursor.getUTCDate(), cursor.getUTCDay())) {
      cursor.setUTCDate(cursor.getUTCDate() + 1);
      cursor.setUTCHours(0, 0, 0, 0);
      continue;
    }
    if (!c.hours.has(cursor.getUTCHours())) {
      cursor.setUTCHours(cursor.getUTCHours() + 1, 0, 0, 0);
      continue;
    }
    if (!c.minutes.has(cursor.getUTCMinutes())) {
      cursor.setUTCMinutes(cursor.getUTCMinutes() + 1, 0, 0);
      continue;
    }
    const instant = zonedInstant(cursor.getUTCFullYear(), month, cursor.getUTCDate(), cursor.getUTCHours(), cursor.getUTCMinutes(), tz);
    if (instant > after) return instant;
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1, 0, 0);
  }
  return null;
}

// ---------- schedules ----------

/** Validates and normalizes a schedule; relative and local times are resolved against `now` in `tz`. */
export function parseSchedule(input: ScheduleInput, now: number, tz: string): ScheduleSpec {
  if (!input || typeof input !== 'object') throw new Error('schedule is required');
  const zone = input.timezone || tz;
  if (input.timezone && !isValidTimeZone(input.timezone)) throw new Error(`Unknown time zone "${input.timezone}"`);
  switch (input.type) {
    case 'once': {
      if (input.inMinutes !== undefined && input.inMinutes !== null) {
        const minutes = Number(input.inMinutes);
        if (!Number.isFinite(minutes) || minutes < 0) throw new Error('inMinutes must be a positive number');
        return { type: 'once', at: now + Math.round(minutes * MINUTE) };
      }
      if (input.at === undefined || input.at === null || input.at === '') throw new Error('A one-time schedule needs `at` or `inMinutes`');
      return { type: 'once', at: parseAt(input.at, now, zone) };
    }
    case 'interval': {
      const minutes = Number(input.everyMinutes);
      if (!Number.isFinite(minutes) || minutes < 1) throw new Error('everyMinutes must be at least 1');
      return { type: 'interval', everyMinutes: Math.round(minutes) };
    }
    case 'cron': {
      const expression = String(input.expression ?? '').trim();
      parseCron(expression);
      if (nextCronTime(expression, now, zone) === null) throw new Error(`The cron expression "${expression}" never matches`);
      return { type: 'cron', expression, timezone: input.timezone || null };
    }
  }
  throw new Error(`Unknown schedule type "${(input as { type?: string }).type}" (use once, interval or cron)`);
}

function parseAt(at: string | number, now: number, tz: string): number {
  if (typeof at === 'number') return at;
  const text = at.trim();
  if (/^\d{10,}$/.test(text)) return Number(text);
  const time = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (time) {
    // Next occurrence of that time of day.
    const w = wallTime(now, tz);
    let instant = zonedInstant(w.year, w.month, w.day, Number(time[1]), Number(time[2]), tz);
    if (instant <= now) {
      const tomorrow = new Date(Date.UTC(w.year, w.month - 1, w.day + 1));
      instant = zonedInstant(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth() + 1, tomorrow.getUTCDate(), Number(time[1]), Number(time[2]), tz);
    }
    return instant;
  }
  // An explicit offset or Z is absolute; a bare date-time is wall-clock time in `tz`.
  const local = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/.exec(text);
  if (local) {
    const [, y, mo, d, h = '0', mi = '0'] = local;
    return zonedInstant(Number(y), Number(mo), Number(d), Number(h), Number(mi), tz);
  }
  const parsed = Date.parse(text);
  if (Number.isNaN(parsed)) throw new Error(`Could not read the time "${at}" (use ISO 8601 like 2026-10-21T09:00 or HH:MM)`);
  return parsed;
}

/** When a schedule fires next after `after`; `anchor` is the previous slot of an interval schedule. */
export function nextRun(spec: ScheduleSpec, after: number, tz: string, anchor?: number | null): number | null {
  switch (spec.type) {
    case 'once':
      return spec.at > after ? spec.at : null;
    case 'interval': {
      const every = spec.everyMinutes * MINUTE;
      if (!anchor) return after + every;
      // Keep the cadence of the previous slots; a long pause collapses into one catch-up run.
      const missed = Math.max(1, Math.ceil((after - anchor) / every));
      const next = anchor + missed * every;
      return next > after ? next : next + every;
    }
    case 'cron':
      return nextCronTime(spec.expression, after, spec.timezone || tz);
  }
}

// ---------- labels ----------

const pad = (n: number) => String(n).padStart(2, '0');
const DAY_LABELS = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];

export function formatWall(instant: number, tz: string, withYear = false) {
  const w = wallTime(instant, tz);
  const date = `${w.year}-${pad(w.month)}-${pad(w.day)}`;
  return `${withYear ? date : date.slice(5)} ${pad(w.hour)}:${pad(w.minute)}`;
}

/** Short human description, e.g. "Every day at 18:00" or "Every 3 minutes". */
export function describeSchedule(spec: ScheduleSpec, tz: string): string {
  switch (spec.type) {
    case 'once':
      return `Once at ${formatWall(spec.at, tz, true)}`;
    case 'interval': {
      const m = spec.everyMinutes;
      if (m % 1440 === 0) return m === 1440 ? 'Every day' : `Every ${m / 1440} days`;
      if (m % 60 === 0) return m === 60 ? 'Every hour' : `Every ${m / 60} hours`;
      return m === 1 ? 'Every minute' : `Every ${m} minutes`;
    }
    case 'cron': {
      const suffix = spec.timezone && spec.timezone !== tz ? ` (${spec.timezone})` : '';
      return describeCron(spec.expression) + suffix;
    }
  }
}

function describeCron(expression: string): string {
  const fields = (MACROS[expression.trim().toLowerCase()] ?? expression.trim()).split(/\s+/);
  const [mi, h, dom, mon, dow] = fields;
  const fixed = (s: string) => /^\d+$/.test(s);
  if (fields.length === 5 && fixed(mi) && fixed(h) && mon === '*') {
    const time = `${pad(Number(h))}:${pad(Number(mi))}`;
    if (dom === '*' && dow === '*') return `Every day at ${time}`;
    if (dom === '*' && (dow === '1-5' || dow.toLowerCase() === 'mon-fri')) return `Weekdays at ${time}`;
    if (dom === '*' && /^[\d,]+$/.test(dow)) {
      const days = [...new Set(dow.split(',').map((d) => Number(d) % 7))].map((d) => DAY_LABELS[d]);
      return `${days.length > 1 ? `${days.slice(0, -1).join(', ')} and ${days[days.length - 1]}` : days[0]} at ${time}`;
    }
    if (fixed(dom) && dow === '*') return `Monthly on day ${dom} at ${time}`;
  }
  if (fields.length === 5 && fixed(mi) && h === '*' && dom === '*' && mon === '*' && dow === '*') return `Every hour at :${pad(Number(mi))}`;
  const everyHours = /^\*\/(\d+)$/.exec(h);
  if (fields.length === 5 && fixed(mi) && everyHours && dom === '*' && mon === '*' && dow === '*') return `Every ${everyHours[1]} hours at :${pad(Number(mi))}`;
  const everyMinutes = /^\*\/(\d+)$/.exec(mi);
  if (fields.length === 5 && everyMinutes && h === '*' && dom === '*' && mon === '*' && dow === '*') return `Every ${everyMinutes[1]} minutes`;
  return `Cron ${expression.trim()}`;
}

/** "in 5 min", "in 2 h", "3 min ago". */
export function relativeTo(instant: number, now: number) {
  const diff = instant - now;
  const abs = Math.abs(diff);
  if (abs < 30_000) return diff >= 0 ? 'now' : 'just now';
  let text: string;
  if (abs < 3600_000) text = `${Math.max(1, Math.round(abs / MINUTE))} min`;
  else if (abs < 48 * 3600_000) text = `${Math.round(abs / 3600_000)} h`;
  else text = `${Math.round(abs / 86400_000)} d`;
  return diff >= 0 ? `in ${text}` : `${text} ago`;
}
