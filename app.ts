// The forge's HTTP server: one process, Node 22 stdlib only.
// Dispatch: /healthz, git smart HTTP, GraphQL, MCP, REST v3, then a JSON 404.
// Every reply carries X-GitHub-Request-Id; every REST reply is application/json.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGit, type GitRequest } from './git.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';
import { Store } from './store.ts';
import type { HttpRequest, HttpResult } from './http.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

/** The bearer <redacted> the trial hands the entry (MAKEFUN_SHOP_TOKEN). */
function expectedToken(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}

/** True when the request carries the trial's bearer token (or any bearer token when none is configured). */
function isAuthed(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  const match = /^Bearer (.+)$/.exec(header);
  if (!match) return false;
  const expected = expectedToken();
  if (expected === '') return true;
  return match[1] === expected;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

let requestCounter = 0;

function sendResult(res: ServerResponse, result: HttpResult): void {
  requestCounter += 1;
  const headers: Record<string, string> = {
    'content-type': result.contentType,
    'x-github-request-id': `forge-${requestCounter}`,
    ...(result.headers ?? {}),
  };
  if (result.status === 204 || result.body.length === 0) {
    res.writeHead(result.status, headers);
    res.end();
    return;
  }
  headers['content-length'] = String(result.body.length);
  res.writeHead(result.status, headers);
  res.end(result.body);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  requestCounter += 1;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': `forge-${requestCounter}`,
  });
  res.end(text);
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const store = new Store();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      let url: URL;
      try {
        url = new URL(req.url ?? '/', 'http://entry');
      } catch {
        sendJson(res, 400, { message: 'Bad Request' });
        return;
      }
      const pathname = url.pathname;
      const method = req.method ?? 'GET';
      const authed = isAuthed(req);

      // The env's boot probe: 200 {"ok":true}.
      if (method === 'GET' && pathname === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }

      let body: Buffer;
      try {
        body = await readBody(req);
      } catch {
        sendJson(res, 413, { message: 'Request body too large' });
        return;
      }

      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === 'string') headers[key.toLowerCase()] = value;
      }
      const httpReq: HttpRequest = {
        method,
        pathname,
        query: url.searchParams,
        headers,
        body,
        authed,
      };
      const origin = `http://${req.headers.host ?? '127.0.0.1'}`;

      try {
        // Git smart HTTP: /{owner}/{repo}.git/...
        if (pathname.includes('.git/')) {
          if (!authed) {
            sendJson(res, 401, { message: 'Requires authentication' });
            return;
          }
          const result = handleGit(store, httpReq as GitRequest);
          if (result) {
            sendResult(res, result);
            return;
          }
        }

        // GraphQL v4.
        if (pathname === '/api/graphql') {
          if (method !== 'POST') {
            sendJson(res, 405, { message: 'Method Not Allowed' });
            return;
          }
          sendResult(res, handleGraphQL(store, httpReq, authed));
          return;
        }

        // MCP.
        if (pathname === '/mcp') {
          sendResult(res, handleMcp(store, httpReq, authed));
          return;
        }

        // REST v3.
        if (pathname.startsWith('/api/v3')) {
          const publicRoot = method === 'GET' && (pathname === '/api/v3' || pathname === '/api/v3/' || pathname === '/api/v3/meta');
          if (!publicRoot && !authed) {
            sendJson(res, 401, { message: 'Requires authentication' });
            return;
          }
          const result = handleRest(store, httpReq, origin);
          if (result) {
            sendResult(res, result);
            return;
          }
        }

        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        process.stderr.write(`[entry] handler error: ${err instanceof Error ? err.message : String(err)}\n`);
        if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
      }
    })();
  });
}
