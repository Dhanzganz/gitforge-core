// The HTTP server: one process serving git smart HTTP at /{owner}/{repo}.git, the REST v3
// API under /api/v3, GraphQL at /api/graphql and MCP at /mcp, all over the one store in
// store.ts. The lifecycle in main.ts binds the port; this file is only the surface.
//
// Cross-cutting rules the suite checks, kept here so every surface inherits them:
//   - API replies are application/json, never HTML, and carry X-GitHub-Request-Id.
//   - A request with no Authorization header is a 401 on every API surface.
//   - A malformed JSON body is a 400 with a {message} body, never a crash.
//   - A repository under another login is a 404 (the ownership rule), on every surface.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { VIEWER } from './src/identity.ts';
import { store } from './src/store.ts';
import { handleRest, type RestReply } from './src/rest.ts';
import { infoRefs, receivePack, uploadPack } from './src/smart.ts';
import { handleGraphQL } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Readonly<Record<string, string>> = {}): void {
  if (status === 204 || body === undefined) {
    res.writeHead(status, { 'x-github-request-id': store.nextRequestId(), ...extra });
    res.end();
    return;
  }
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': store.nextRequestId(),
    ...extra,
  });
  res.end(text);
}

function sendRest(res: ServerResponse, reply: RestReply): void {
  sendJson(res, reply.status, reply.body, reply.headers ?? {});
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

function hasAuth(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  return typeof header === 'string' && header.trim() !== '';
}

/** The request's origin for absolute Link URLs, from its own Host header. */
function originOf(req: IncomingMessage): string {
  const host = req.headers.host ?? '127.0.0.1';
  return `http://${host}`;
}

async function handleApiV3(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (!hasAuth(req)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return;
  }
  const raw = await readBody(req);
  let body: unknown = undefined;
  if (raw.length > 0) {
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      sendJson(res, 400, { message: 'Problems parsing JSON' });
      return;
    }
  }
  const segments = url.pathname
    .replace(/^\/api\/v3\/?/, '')
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) => decodeURIComponent(segment));
  const reply = handleRest({
    method: req.method ?? 'GET',
    segments,
    query: url.searchParams,
    body,
    origin: originOf(req),
    path: url.pathname,
  });
  sendRest(res, reply);
}

async function handleGraphQLRoute(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!hasAuth(req)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const raw = await readBody(req);
  let body: unknown;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(res, 400, { message: 'Problems parsing JSON' });
    return;
  }
  const reply = handleGraphQL(body);
  sendJson(res, reply.status, reply.body);
}

async function handleMcpRoute(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === 'DELETE') {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return;
  }
  if (!hasAuth(req)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return;
  }
  const raw = await readBody(req);
  const reply = handleMcp(raw.toString('utf8'));
  res.writeHead(reply.status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(reply.body) });
  res.end(reply.body);
}

/** The git smart-HTTP routes: /{owner}/{repo}.git/{info/refs,git-upload-pack,git-receive-pack}. */
async function handleGit(req: IncomingMessage, res: ServerResponse, url: URL, segments: string[]): Promise<boolean> {
  if (segments.length < 3) return false;
  const owner = segments[0] as string;
  const repoGit = segments[1] as string;
  const action = segments.slice(2).join('/');
  if (!repoGit.endsWith('.git')) return false;
  const repo = owner === VIEWER.login ? store.repo(owner, repoGit.slice(0, -4)) : undefined;
  if (action === 'info/refs') {
    if (repo === undefined) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('repository not found');
      return true;
    }
    const reply = infoRefs(repo, url.searchParams.get('service') ?? '', req.headers['git-protocol'] ?? null);
    res.writeHead(reply.status, { 'content-type': reply.contentType, 'content-length': reply.body.length });
    res.end(reply.body);
    return true;
  }
  if (action === 'git-upload-pack' || action === 'git-receive-pack') {
    if (repo === undefined) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('repository not found');
      return true;
    }
    const raw = await readBody(req);
    const reply = action === 'git-upload-pack' ? uploadPack(repo, raw) : receivePack(repo, raw);
    res.writeHead(reply.status, { 'content-type': reply.contentType, 'content-length': reply.body.length });
    res.end(reply.body);
    return true;
  }
  return false;
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://entry');
        const path = url.pathname;
        const method = req.method ?? 'GET';
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          await handleApiV3(req, res, url);
          return;
        }
        if (path === '/api/graphql') {
          await handleGraphQLRoute(req, res);
          return;
        }
        if (path === '/mcp') {
          await handleMcpRoute(req, res);
          return;
        }
        const segments = path.split('/').filter((segment) => segment !== '').map((segment) => decodeURIComponent(segment));
        if (await handleGit(req, res, url, segments)) return;
        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        // A request must never take the server down: answer 500 JSON and keep serving.
        process.stderr.write(`[forge] request failed: ${err instanceof Error ? err.message : String(err)}\n`);
        if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
        else res.end();
      }
    })();
  });
}
