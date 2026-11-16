// The MCP endpoint: JSON-RPC 2.0 over the Streamable HTTP transport at /mcp. It speaks the
// current revision (2026-07-28: `server/discover`, no handshake, no session) and the older
// handshake revisions through `initialize`, and its tools act on the same store as the REST
// surface — an issue created here is the same issue REST reads back, id unchanged.

import { VIEWER } from './identity.ts';
import {
  createIssueRecord,
  createPullRecord,
  mergePullRequest,
  openPullFor,
  store,
  type Repo,
} from './store.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';

export interface McpReply {
  status: number;
  body: string;
}

const SERVER_INFO = { name: 'gitforge-core', version: '1.0.0' } as const;
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;

const PARSE_ERROR = -32700;
const INVALID_PARAMS = -32602;
const METHOD_NOT_FOUND = -32601;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rpcResult(id: unknown, result: unknown): McpReply {
  return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result }) };
}

function rpcError(id: unknown, code: number, message: string): McpReply {
  return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }) };
}

// ---------------------------------------------------------------------------------------------
// The tool list (built once: two tools/list calls answer byte for byte the same)
// ---------------------------------------------------------------------------------------------

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const stringProp = (description: string): { type: string; description: string } => ({ type: 'string', description });

export const TOOLS: readonly ToolDefinition[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: stringProp('The repository name.'),
        description: stringProp('A short description of the repository.'),
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner login.'),
        repo: stringProp('The repository name.'),
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner login.'),
        repo: stringProp('The repository name.'),
        title: stringProp('The issue title.'),
        body: stringProp('The issue body.'),
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List a repository\u2019s issues, optionally filtered by state (open, closed or all).',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner login.'),
        repo: stringProp('The repository name.'),
        state: stringProp('The issue state to list: open, closed or all.'),
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner login.'),
        repo: stringProp('The repository name.'),
        title: stringProp('The pull request title.'),
        body: stringProp('The pull request body.'),
        head: stringProp('The head branch to merge from.'),
        base: stringProp('The base branch to merge into.'),
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request (squash) into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner login.'),
        repo: stringProp('The repository name.'),
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

// ---------------------------------------------------------------------------------------------
// Tool handlers: each answers a value (serialized into the result) or throws a ToolFailure.
// ---------------------------------------------------------------------------------------------

class ToolFailure extends Error {}

function repoFor(owner: unknown, repo: unknown): Repo {
  if (typeof owner !== 'string' || typeof repo !== 'string') throw new ToolFailure('owner and repo are required.');
  const found = owner === VIEWER.login ? store.repo(owner, repo) : undefined;
  if (found === undefined) throw new ToolFailure(`Repository ${owner}/${repo} not found.`);
  return found;
}

function toolResult(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function callTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (name) {
    case 'create_repo': {
      const repoName = args.name;
      if (typeof repoName !== 'string' || repoName === '') throw new ToolFailure('name is required.');
      if (store.repo(VIEWER.login, repoName) !== undefined) throw new ToolFailure(`Repository ${repoName} already exists.`);
      const repo = store.createRepo(VIEWER.login, repoName, {
        description: typeof args.description === 'string' ? args.description : '',
        isPrivate: args.private === true,
      });
      return toolResult(repoJson(repo));
    }
    case 'get_repo': {
      return toolResult(repoJson(repoFor(args.owner, args.repo)));
    }
    case 'create_issue': {
      const repo = repoFor(args.owner, args.repo);
      const issue = createIssueRecord(store, repo, {
        title: args.title as string,
        body: typeof args.body === 'string' ? args.body : '',
        authorLogin: VIEWER.login,
      });
      return toolResult(issueJson(repo, issue));
    }
    case 'list_issues': {
      const repo = repoFor(args.owner, args.repo);
      const state = typeof args.state === 'string' ? args.state : 'open';
      let issues = [...repo.issues.values()];
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      issues.sort((a, b) => a.number - b.number);
      return toolResult(issues.map((issue) => issueJson(repo, issue)));
    }
    case 'create_pull_request': {
      const repo = repoFor(args.owner, args.repo);
      const head = args.head as string;
      const base = args.base as string;
      if (repo.refs.get(`refs/heads/${head}`) === undefined) throw new ToolFailure(`Head branch "${head}" does not exist.`);
      if (repo.refs.get(`refs/heads/${base}`) === undefined) throw new ToolFailure(`Base branch "${base}" does not exist.`);
      if (openPullFor(repo, head, base) !== undefined) throw new ToolFailure('A pull request already exists for this head and base.');
      const pull = createPullRecord(store, repo, {
        title: args.title as string,
        body: typeof args.body === 'string' ? args.body : '',
        headRef: head,
        baseRef: base,
        authorLogin: VIEWER.login,
      });
      return toolResult(pullJson(repo, pull));
    }
    case 'merge_pull_request': {
      const repo = repoFor(args.owner, args.repo);
      const raw = args.pull_number;
      const number = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number.parseInt(raw, 10) : Number.NaN;
      const pull = Number.isFinite(number) ? repo.pulls.get(number) : undefined;
      if (pull === undefined) throw new ToolFailure(`Pull request #${String(raw)} not found.`);
      if (pull.state !== 'open') throw new ToolFailure(`Pull request #${pull.number} is not open.`);
      const result = mergePullRequest(repo, pull, 'squash', store.nextTick());
      if (!result.ok) throw new ToolFailure(`Pull request #${pull.number} is not mergeable.`);
      return toolResult(pullJson(repo, pull));
    }
    default:
      throw new ToolFailure(`Unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------------------------------------
// The JSON-RPC dispatcher
// ---------------------------------------------------------------------------------------------

function discoverResult(): Record<string, unknown> {
  return {
    resultType: 'complete',
    supportedVersions: [...SUPPORTED_VERSIONS],
    capabilities: { tools: {} },
    serverInfo: { ...SERVER_INFO },
    _meta: { 'io.modelcontextprotocol/serverInfo': { ...SERVER_INFO } },
  };
}

function handleOne(request: Record<string, unknown>): McpReply {
  const id = request.id;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = isRecord(request.params) ? request.params : {};
  const isNotification = id === undefined;

  switch (method) {
    case 'server/discover':
      return rpcResult(id, discoverResult());
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const negotiated = (SUPPORTED_VERSIONS as readonly string[]).includes(offered) ? offered : '2025-11-25';
      return rpcResult(id, {
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: { ...SERVER_INFO },
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const tool = TOOLS.find((candidate) => candidate.name === name);
      if (tool === undefined) return rpcError(id, INVALID_PARAMS, `Unknown tool: ${name}`);
      const args = isRecord(params.arguments) ? params.arguments : {};
      const missing = tool.inputSchema.required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
      if (missing.length > 0) return rpcError(id, INVALID_PARAMS, `Missing required argument(s): ${missing.join(', ')}`);
      try {
        return rpcResult(id, callTool(name, args));
      } catch (err) {
        if (err instanceof ToolFailure) {
          return rpcResult(id, { content: [{ type: 'text', text: err.message }], isError: true });
        }
        throw err;
      }
    }
    default:
      if (isNotification || method.startsWith('notifications/')) return { status: 202, body: '' };
      return rpcError(id, METHOD_NOT_FOUND, `Method not found: ${method}`);
  }
}

/**
 * Handle one POST /mcp body. A body that is not JSON is the transport's parse error:
 * HTTP 400 with JSON-RPC -32700. A JSON array is a batch and answers an array, in order.
 */
export function handleMcp(bodyText: string): McpReply {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return {
      status: 400,
      body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: PARSE_ERROR, message: 'Parse error' } }),
    };
  }
  if (Array.isArray(parsed)) {
    const replies: unknown[] = [];
    for (const entry of parsed) {
      if (!isRecord(entry)) {
        replies.push({ jsonrpc: '2.0', id: null, error: { code: INVALID_PARAMS, message: 'Invalid request' } });
        continue;
      }
      const reply = handleOne(entry);
      if (reply.body !== '') replies.push(JSON.parse(reply.body));
    }
    return { status: 200, body: JSON.stringify(replies) };
  }
  if (!isRecord(parsed)) {
    return {
      status: 400,
      body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: PARSE_ERROR, message: 'Parse error' } }),
    };
  }
  return handleOne(parsed);
}
