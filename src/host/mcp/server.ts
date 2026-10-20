import type http from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { HOST_VERSION } from '../../shared/types.js';
import { errorMessage, log } from '../log.js';
import { browserInstructions } from './instructions.js';
import type { BrowserTools, ToolContext } from './tools.js';

export const MCP_SERVER_NAME = 'browser';

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

/** Stateless Streamable-HTTP MCP endpoint: every POST gets a fresh server bound to the shared tools. */
export async function handleMcp(req: http.IncomingMessage, res: http.ServerResponse, tools: BrowserTools) {
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
  const server = new Server(
    { name: 'bettercodex-browser', version: HOST_VERSION },
    { capabilities: { tools: {} }, instructions: browserInstructions() },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools.list() as any }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const ctx = contextFrom(request.params._meta);
    const started = Date.now();
    const result = await tools.call(request.params.name, request.params.arguments, ctx);
    log.debug(`tool ${request.params.name} thread=${ctx.threadId} ${Date.now() - started}ms${result.isError ? ' (error)' : ''}`);
    return result as any;
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
