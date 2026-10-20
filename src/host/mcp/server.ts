import type http from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { HOST_VERSION } from '../../shared/types.js';
import { errorMessage, log } from '../log.js';
import type { ToolContext, ToolResult } from './tools.js';

export const MCP_SERVER_NAME = 'browser';
export const SCHEDULER_SERVER_NAME = 'scheduler';

/** One MCP server the host offers to Codex threads (the browser, the scheduler). */
export interface ToolServer {
  name: string;
  instructions(): string;
  list(): unknown[];
  call(name: string, args: unknown, ctx: ToolContext): Promise<ToolResult>;
}

/** Codex attaches the calling thread to every tool call's `_meta`. */
function contextFrom(meta: any): ToolContext {
  const turn = meta?.['x-codex-turn-metadata'];
  const turnMeta = typeof turn === 'string' ? safeJson(turn) : turn;
  const threadId = meta?.threadId ?? turnMeta?.thread_id ?? turnMeta?.session_id ?? 'unassigned';
  return { threadId: String(threadId), turnId: turnMeta?.turn_id ?? null, sandboxMode: turnMeta?.sandbox_mode ?? null };
}

function safeJson(s: string) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/**
 * Tool calls in flight, by turn. Codex does not cancel the calls of a turn it stops (their requests
 * stay open), so they are ended here once Codex reports the turn over.
 */
export class TurnCalls {
  private calls = new Map<string, Set<AbortController>>();

  /** A signal for one call that aborts when the request goes away or its turn ends. */
  track(turnId: string | null, request: AbortSignal) {
    const call = new AbortController();
    const abort = () => call.abort();
    if (request.aborted) call.abort();
    request.addEventListener('abort', abort, { once: true });
    if (turnId) {
      let set = this.calls.get(turnId);
      if (!set) this.calls.set(turnId, (set = new Set()));
      set.add(call);
    }
    const done = () => {
      request.removeEventListener('abort', abort);
      const set = turnId ? this.calls.get(turnId) : undefined;
      set?.delete(call);
      if (set && !set.size) this.calls.delete(turnId!);
    };
    return { signal: call.signal, done };
  }

  ended(turnId: string) {
    const set = this.calls.get(turnId);
    this.calls.delete(turnId);
    for (const call of set ?? []) call.abort();
  }

  endAll() {
    for (const turnId of [...this.calls.keys()]) this.ended(turnId);
  }
}

/** Stateless Streamable-HTTP MCP endpoint: every POST gets a fresh server bound to the shared tools. */
export async function handleMcp(req: http.IncomingMessage, res: http.ServerResponse, tools: ToolServer, turns: TurnCalls) {
  if (req.method !== 'POST') {
    res.writeHead(405, { Allow: 'POST' }).end();
    return;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  let body: unknown;
  try {
    body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
  } catch {
    res.writeHead(400).end('invalid json');
    return;
  }
  const server = new Server({ name: `bettercodex-${tools.name}`, version: HOST_VERSION }, { capabilities: { tools: {} }, instructions: tools.instructions() });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools.list() as any }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const meta = contextFrom(request.params._meta);
    const call = turns.track(meta.turnId, extra.signal);
    const started = Date.now();
    try {
      const result = await tools.call(request.params.name, request.params.arguments, { ...meta, signal: call.signal });
      log.debug(`tool ${request.params.name} thread=${meta.threadId} ${Date.now() - started}ms${result.isError ? ' (error)' : ''}`);
      return result as any;
    } finally {
      call.done();
    }
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (err) {
    log.error('mcp request failed', errorMessage(err));
    if (!res.headersSent) res.writeHead(500).end();
  }
}
