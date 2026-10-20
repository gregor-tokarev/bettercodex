import vm from 'node:vm';
import util from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import * as acorn from 'acorn';

export interface ReplImage {
  data: string;
  mimeType: string;
}

export interface ReplOutput {
  text: string;
  images: ReplImage[];
  error: boolean;
}

const OUTPUT_LIMIT = 60_000;

type Node = acorn.Node & Record<string, any>;

/**
 * Rewrites a cell so its top-level declarations become globals of the REPL context.
 * That makes `const tab = …` survive into the next call and lets the same name be
 * declared again, like a browser console. The last expression becomes the result.
 */
export function transformCell(code: string): string {
  let ast: Node;
  try {
    ast = acorn.parse(code, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
    }) as Node;
  } catch {
    // Let V8 report the syntax error with its own message.
    return `(async () => {\n${code}\n})()`;
  }
  const src = (n: Node) => code.slice(n.start, n.end);
  const hoisted: string[] = [];
  const out: string[] = [];
  const body: Node[] = ast.body;
  body.forEach((stmt, index) => {
    const last = index === body.length - 1;
    switch (stmt.type) {
      case 'VariableDeclaration': {
        const parts = stmt.declarations.map((d: Node) => {
          const init = d.init ? src(d.init) : 'undefined';
          return `(${src(d.id)} = ${init});`;
        });
        out.push(parts.join(' '));
        break;
      }
      case 'FunctionDeclaration':
        hoisted.push(`${stmt.id.name} = ${src(stmt)};`);
        break;
      case 'ClassDeclaration':
        out.push(`${stmt.id.name} = ${src(stmt)};`);
        break;
      case 'ImportDeclaration': {
        const spec = JSON.stringify(stmt.source.value);
        const mod = `(await import(${spec}))`;
        for (const s of stmt.specifiers as Node[]) {
          if (s.type === 'ImportDefaultSpecifier') out.push(`${s.local.name} = ${mod}.default;`);
          else if (s.type === 'ImportNamespaceSpecifier') out.push(`${s.local.name} = ${mod};`);
          else out.push(`${s.local.name} = ${mod}[${JSON.stringify(s.imported.name ?? s.imported.value)}];`);
        }
        if (!stmt.specifiers.length) out.push(`await import(${spec});`);
        break;
      }
      case 'ExportNamedDeclaration':
      case 'ExportDefaultDeclaration':
        out.push(src(stmt.declaration ?? stmt).replace(/^export\s+(default\s+)?/, ''));
        break;
      case 'ExpressionStatement':
        out.push(last ? `return (${src(stmt.expression)});` : src(stmt));
        break;
      default:
        out.push(src(stmt));
    }
  });
  return `(async () => {\n${hoisted.join('\n')}\n${out.join('\n')}\n})()`;
}

function detectImage(value: unknown): ReplImage | null {
  if (!(value instanceof Uint8Array) || value.length < 8) return null;
  const b = value;
  if (b[0] === 0xff && b[1] === 0xd8) return { data: Buffer.from(b).toString('base64'), mimeType: 'image/jpeg' };
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { data: Buffer.from(b).toString('base64'), mimeType: 'image/png' };
  if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45) return { data: Buffer.from(b).toString('base64'), mimeType: 'image/webp' };
  return null;
}

export function toImage(value: unknown, mimeType?: string): ReplImage {
  if (typeof value === 'string') {
    const m = /^data:([^;]+);base64,(.*)$/s.exec(value);
    if (m) return { mimeType: m[1], data: m[2] };
    if (fs.existsSync(value)) return toImage(fs.readFileSync(value), mimeType ?? guessMime(value));
    return { data: value, mimeType: mimeType ?? 'image/png' };
  }
  const detected = detectImage(value);
  if (detected) return detected;
  if (value instanceof Uint8Array) return { data: Buffer.from(value).toString('base64'), mimeType: mimeType ?? 'image/png' };
  throw new Error('display() expects image bytes, a data URL or a file path');
}

function guessMime(file: string) {
  const ext = path.extname(file).toLowerCase();
  return ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'image/png';
}

function format(value: unknown) {
  if (typeof value === 'string') return value;
  return util.inspect(value, { depth: 4, maxArrayLength: 200, maxStringLength: 20_000, breakLength: 120 });
}

/** A persistent JavaScript context per thread with Playwright handles injected as globals. */
export class ReplSession {
  readonly context: vm.Context;
  private output: string[] = [];
  private images: ReplImage[] = [];
  private queue: Promise<unknown> = Promise.resolve();

  constructor(globals: Record<string, unknown>) {
    const sandboxConsole = {
      log: (...args: unknown[]) => this.print(util.format(...args)),
      info: (...args: unknown[]) => this.print(util.format(...args)),
      debug: (...args: unknown[]) => this.print(util.format(...args)),
      warn: (...args: unknown[]) => this.print(`[warn] ${util.format(...args)}`),
      error: (...args: unknown[]) => this.print(`[error] ${util.format(...args)}`),
      dir: (value: unknown) => this.print(format(value)),
      table: (value: unknown) => this.print(format(value)),
    };
    this.context = vm.createContext({
      console: sandboxConsole,
      Buffer,
      URL,
      URLSearchParams,
      TextEncoder,
      TextDecoder,
      AbortController,
      fetch,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      setImmediate,
      structuredClone,
      path,
      sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
      print: (...args: unknown[]) => this.print(args.map(format).join(' ')),
      display: (value: unknown, mimeType?: string) => {
        this.images.push(toImage(value, mimeType));
      },
      ...globals,
    });
  }

  private print(text: string) {
    this.output.push(text);
  }

  /** Lets host-side helpers (like screenshot()) attach an image to the running cell. */
  attachImage(image: ReplImage) {
    this.images.push(image);
  }

  run(code: string, timeoutMs: number, beforeRun?: () => Promise<void>): Promise<ReplOutput> {
    const task = async (): Promise<ReplOutput> => {
      this.output = [];
      this.images = [];
      let error = false;
      try {
        await beforeRun?.();
        const script = new vm.Script(transformCell(code), {
          filename: 'cell.js',
          importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
        });
        const promise = script.runInContext(this.context, { timeout: Math.min(timeoutMs, 30_000), displayErrors: true });
        let timer: NodeJS.Timeout | undefined;
        const value = await Promise.race([
          promise,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms (work started by this cell may still be running)`)), timeoutMs);
          }),
        ]).finally(() => clearTimeout(timer));
        if (value !== undefined) {
          const image = detectImage(value);
          if (image) this.images.push(image);
          else this.output.push(format(value));
        }
      } catch (err) {
        error = true;
        const e = err as Error;
        const stack = (e?.stack ?? String(err))
          .split('\n')
          .filter((line) => !line.includes('node:internal') && !line.includes('/host.mjs'))
          .join('\n');
        this.output.push(stack);
      }
      let text = this.output.join('\n');
      if (text.length > OUTPUT_LIMIT) text = `${text.slice(0, OUTPUT_LIMIT)}\n… (output truncated, ${text.length - OUTPUT_LIMIT} more characters)`;
      return { text, images: this.images.slice(), error };
    };
    const result = this.queue.then(task, task);
    this.queue = result.catch(() => {});
    return result;
  }
}
