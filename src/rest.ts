// The REST v3 surface: repositories, contents, git data (refs), branches, commits, labels,
// issues, comments and pull requests, answered the way api.github.com answers them — JSON
// everywhere, a `message` on every error, Link headers on paginated lists, and the
// ownership rule that a repository under another login is a 404, never a 403.

import { parseCommit } from './gitcore.ts';
import { USERS, VIEWER, userByLogin, type ForgeUser } from './identity.ts';
import {
  addCommentRecord,
  commitChanges,
  createIssueRecord,
  createPullRecord,
  isoOf,
  mergePullRequest,
  nodeId,
  openPullFor,
  pullChangedFiles,
  store,
  type Issue,
  type IssueComment,
  type PullRequest,
  type Repo,
} from './store.ts';

export interface RestReply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

const notFound = (): RestReply => ({ status: 404, body: { message: 'Not Found' } });
const unprocessable = (message: string): RestReply => ({ status: 422, body: { message } });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === 'string' ? value : undefined;
}

// ---------------------------------------------------------------------------------------------
// Serializers
// ---------------------------------------------------------------------------------------------

export function userJson(user: ForgeUser): Record<string, unknown> {
  return {
    login: user.login,
    id: user.id,
    node_id: nodeId('User', user.id),
    type: 'User',
    name: user.name,
    email: user.email,
    site_admin: false,
  };
}

export function repoJson(repo: Repo): Record<string, unknown> {
  const owner = userByLogin(repo.owner) ?? VIEWER;
  return {
    id: repo.dbId,
    node_id: nodeId('Repository', repo.dbId),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(owner),
    private: repo.isPrivate,
    description: repo.description,
    fork: false,
    created_at: isoOf(repo.createdTick),
    updated_at: isoOf(repo.createdTick),
    pushed_at: isoOf(repo.createdTick),
    default_branch: repo.defaultBranch,
    visibility: repo.isPrivate ? 'private' : 'public',
    html_url: `https://gitforge.local/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

function labelJson(repo: Repo, name: string): Record<string, unknown> {
  const label = repo.labels.get(name);
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) % 1_000_000_000;
  return {
    id: hash + 1,
    node_id: nodeId('Repository', `${repo.dbId}:label:${name}`),
    name,
    color: label?.color ?? 'ededed',
    default: false,
    description: null,
  };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  const author = userByLogin(issue.authorLogin) ?? VIEWER;
  return {
    id: issue.globalId,
    node_id: nodeId('Issue', `${repo.dbId}:${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    labels: issue.labelNames.map((name) => labelJson(repo, name)),
    user: userJson(author),
    assignees: [],
    comments: issue.comments.length,
    created_at: isoOf(issue.createdTick),
    updated_at: isoOf(issue.createdTick),
    closed_at: null,
    html_url: `https://gitforge.local/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

export function commentJson(repo: Repo, issue: Issue, comment: IssueComment): Record<string, unknown> {
  const author = userByLogin(comment.authorLogin) ?? VIEWER;
  return {
    id: comment.globalId,
    node_id: nodeId('IssueComment', comment.globalId),
    body: comment.body,
    user: userJson(author),
    created_at: isoOf(comment.createdTick),
    updated_at: isoOf(comment.createdTick),
    html_url: `https://gitforge.local/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.globalId}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.globalId}`,
  };
}

export function pullJson(repo: Repo, pull: PullRequest): Record<string, unknown> {
  const author = userByLogin(pull.authorLogin) ?? VIEWER;
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? null;
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? null;
  return {
    id: pull.globalId,
    node_id: nodeId('PullRequest', `${repo.dbId}:${pull.number}`),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    merged: pull.merged,
    merged_at: pull.mergedTick === null ? null : isoOf(pull.mergedTick),
    merge_commit_sha: pull.mergeCommitSha,
    user: userJson(author),
    head: {
      ref: pull.headRef,
      sha: headSha,
      label: `${repo.owner}:${pull.headRef}`,
      repo: repoJson(repo),
    },
    base: {
      ref: pull.baseRef,
      sha: baseSha,
      label: `${repo.owner}:${pull.baseRef}`,
      repo: repoJson(repo),
    },
    created_at: isoOf(pull.createdTick),
    updated_at: isoOf(pull.createdTick),
    html_url: `https://gitforge.local/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

// ---------------------------------------------------------------------------------------------
// Pagination (GitHub's Link header shape: absolute URLs on the request's own origin)
// ---------------------------------------------------------------------------------------------

export interface Page {
  items: unknown[];
  headers: Record<string, string>;
}

export function paginate(items: readonly unknown[], query: URLSearchParams, origin: string, path: string): Page {
  const perPageRaw = Number.parseInt(query.get('per_page') ?? '', 10);
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30;
  const pageRaw = Number.parseInt(query.get('page') ?? '', 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (items.length > 0 && totalPages > 1) {
    const urlFor = (p: number): string => {
      const params = new URLSearchParams(query);
      params.set('per_page', String(perPage));
      params.set('page', String(p));
      return `${origin}${path}?${params.toString()}`;
    };
    const links: string[] = [];
    if (page < totalPages) {
      links.push(`<${urlFor(page + 1)}>; rel="next"`);
      links.push(`<${urlFor(totalPages)}>; rel="last"`);
    }
    if (page > 1) {
      links.push(`<${urlFor(1)}>; rel="first"`);
      links.push(`<${urlFor(page - 1)}>; rel="prev"`);
    }
    if (links.length > 0) headers.link = links.join(', ');
  }
  return { items: slice, headers };
}

// ---------------------------------------------------------------------------------------------
// The router
// ---------------------------------------------------------------------------------------------

export interface RestRequest {
  method: string;
  /** Path segments after /api/v3. */
  segments: string[];
  query: URLSearchParams;
  body: unknown;
  /** The request's origin (scheme://host) for absolute Link URLs. */
  origin: string;
  /** The path the client asked for, for Link URLs. */
  path: string;
}

export function handleRest(request: RestRequest): RestReply {
  const { method, segments } = request;
  if (segments.length === 0) {
    if (method !== 'GET') return notFound();
    return {
      status: 200,
      body: {
        current_user_url: '/api/v3/user',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        issue_url: '/api/v3/repos/{owner}/{repo}/issues',
        rate_limit_url: '/api/v3/rate_limit',
      },
      headers: { 'x-oauth-scopes': 'repo, read:org' },
    };
  }
  if (segments[0] === 'meta' && segments.length === 1) {
    if (method !== 'GET') return notFound();
    return { status: 200, body: { installed_version: '1.0.0', verifiable_password_authentication: false } };
  }
  if (segments[0] === 'user') return handleUser(request);
  if (segments[0] === 'repos' && segments.length >= 3) return handleRepo(request);
  return notFound();
}

function handleUser(request: RestRequest): RestReply {
  const { method, segments } = request;
  if (segments.length === 1) {
    if (method !== 'GET') return notFound();
    return { status: 200, body: userJson(VIEWER) };
  }
  if (segments[1] === 'repos' && segments.length === 2) {
    if (method === 'GET') {
      const repos = store.reposOf(VIEWER.login).map((repo) => repoJson(repo));
      const page = paginate(repos, request.query, request.origin, request.path);
      return { status: 200, body: page.items, headers: page.headers };
    }
    if (method === 'POST') return createRepo(request);
  }
  return notFound();
}

function createRepo(request: RestRequest): RestReply {
  const body = isRecord(request.body) ? request.body : {};
  const name = stringField(body, 'name');
  if (name === undefined || name === '') return unprocessable('Repository creation failed.');
  if (store.repo(VIEWER.login, name) !== undefined) {
    return {
      status: 422,
      body: {
        message: 'Repository creation failed.',
        errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }],
      },
    };
  }
  const repo = store.createRepo(VIEWER.login, name, {
    description: stringField(body, 'description') ?? '',
    isPrivate: body.private === true,
    defaultBranch: stringField(body, 'default_branch') ?? 'main',
  });
  if (body.auto_init === true) {
    const changes = new Map<string, Buffer | null>([['README.md', Buffer.from(`# ${name}\n`, 'utf8')]]);
    commitChanges(repo, repo.defaultBranch, changes, 'Initial commit', store.nextTick());
  }
  return { status: 201, body: repoJson(repo) };
}

/** Resolve the repo a /repos/{owner}/{repo}/... route names, applying the ownership rule. */
function resolveRepo(request: RestRequest): Repo | null {
  const owner = request.segments[1] as string;
  const name = request.segments[2] as string;
  if (owner !== VIEWER.login) return null;
  return store.repo(owner, name) ?? null;
}

function handleRepo(request: RestRequest): RestReply {
  const { method, segments } = request;
  const repo = resolveRepo(request);
  if (segments.length === 3) {
    if (repo === null) return notFound();
    if (method === 'GET') return { status: 200, body: repoJson(repo) };
    if (method === 'PATCH') {
      const body = isRecord(request.body) ? request.body : {};
      const description = stringField(body, 'description');
      if (description !== undefined) repo.description = description;
      if (typeof body.private === 'boolean') repo.isPrivate = body.private;
      return { status: 200, body: repoJson(repo) };
    }
    if (method === 'DELETE') {
      store.deleteRepo(repo.owner, repo.name);
      return { status: 204 };
    }
    return notFound();
  }
  if (repo === null) return notFound();
  const section = segments[3] as string;
  const rest = segments.slice(4);
  switch (section) {
    case 'branches':
      return handleBranches(request, repo, rest);
    case 'commits':
      return handleCommits(request, repo);
    case 'git':
      return handleGitData(request, repo, rest);
    case 'contents':
      return handleContents(request, repo, rest);
    case 'labels':
      return handleLabels(request, repo, rest);
    case 'issues':
      return handleIssues(request, repo, rest);
    case 'pulls':
      return handlePulls(request, repo, rest);
    default:
      return notFound();
  }
}

// ---------------------------------------------------------------------------------------------
// Branches and commits
// ---------------------------------------------------------------------------------------------

function branchTip(repo: Repo, branch: string): string | undefined {
  return repo.refs.get(`refs/heads/${branch}`);
}

function handleBranches(request: RestRequest, repo: Repo, rest: string[]): RestReply {
  if (request.method !== 'GET') return notFound();
  if (rest.length === 0) {
    const branches: unknown[] = [];
    for (const [ref, sha] of repo.refs) {
      if (!ref.startsWith('refs/heads/')) continue;
      branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false });
    }
    branches.sort((a, b) => ((a as { name: string }).name < (b as { name: string }).name ? -1 : 1));
    return { status: 200, body: branches };
  }
  const name = rest.join('/');
  const sha = branchTip(repo, name);
  if (sha === undefined) return notFound();
  return { status: 200, body: { name, commit: { sha }, protected: false } };
}

const AUTHOR_LINE = /^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/;

function identJson(line: string): { name: string; email: string; date: string } {
  const match = AUTHOR_LINE.exec(line);
  if (!match) return { name: line, email: '', date: isoOf(0) };
  const seconds = Number.parseInt(match[3] as string, 10);
  return { name: match[1] as string, email: match[2] as string, date: new Date(seconds * 1000).toISOString() };
}

export function commitJson(repo: Repo, oid: string): Record<string, unknown> | null {
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'commit') return null;
  const commit = parseCommit(object.data);
  return {
    sha: oid,
    node_id: nodeId('Repository', `${repo.dbId}:commit:${oid}`),
    commit: {
      author: identJson(commit.author),
      committer: identJson(commit.committer),
      message: commit.message,
      tree: { sha: commit.tree },
    },
    author: null,
    committer: null,
    parents: commit.parents.map((parent) => ({ sha: parent })),
  };
}

function handleCommits(request: RestRequest, repo: Repo): RestReply {
  if (request.method !== 'GET') return notFound();
  const shaParam = request.query.get('sha');
  let start: string | undefined;
  if (shaParam === null || shaParam === '') {
    start = branchTip(repo, repo.defaultBranch);
  } else if (/^[0-9a-f]{40}$/.test(shaParam)) {
    start = repo.objects.has(shaParam) ? shaParam : undefined;
  } else {
    start = branchTip(repo, shaParam) ?? repo.refs.get(shaParam);
  }
  if (start === undefined) return { status: 200, body: [] };
  // Ancestry walk, newest first, following parents in order without repeats.
  const seen = new Set<string>();
  const order: string[] = [];
  const walk = (oid: string): void => {
    if (seen.has(oid)) return;
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') return;
    seen.add(oid);
    order.push(oid);
    for (const parent of parseCommit(object.data).parents) walk(parent);
  };
  walk(start);
  const commits = order.map((oid) => commitJson(repo, oid)).filter((entry) => entry !== null);
  const page = paginate(commits, request.query, request.origin, request.path);
  return { status: 200, body: page.items, headers: page.headers };
}

// ---------------------------------------------------------------------------------------------
// Git data: refs
// ---------------------------------------------------------------------------------------------

function refJson(repo: Repo, ref: string): Record<string, unknown> {
  const sha = repo.refs.get(ref) as string;
  const object = repo.objects.get(sha);
  return { ref, node_id: nodeId('Repository', `${repo.dbId}:ref:${ref}`), object: { sha, type: object?.type ?? 'commit' } };
}

function handleGitData(request: RestRequest, repo: Repo, rest: string[]): RestReply {
  const { method } = request;
  if (rest[0] === 'refs' || rest[0] === 'ref') {
    const tail = rest.slice(1);
    if (tail.length === 0) {
      if (method === 'GET') {
        const refs = [...repo.refs.keys()].sort().map((ref) => refJson(repo, ref));
        return { status: 200, body: refs };
      }
      if (method === 'POST') {
        const body = isRecord(request.body) ? request.body : {};
        const ref = stringField(body, 'ref');
        const sha = stringField(body, 'sha');
        if (ref === undefined || sha === undefined || !ref.startsWith('refs/')) return unprocessable('Invalid ref or sha.');
        if (!repo.objects.has(sha)) return unprocessable('Object does not exist.');
        repo.refs.set(ref, sha);
        return { status: 201, body: refJson(repo, ref) };
      }
      return notFound();
    }
    const joined = tail.join('/');
    const ref = joined.startsWith('refs/') ? joined : `refs/${joined}`;
    if (method === 'GET') {
      if (!repo.refs.has(ref)) return notFound();
      return { status: 200, body: refJson(repo, ref) };
    }
    if (method === 'DELETE') {
      if (!repo.refs.delete(ref)) return notFound();
      return { status: 204 };
    }
    return notFound();
  }
  return notFound();
}

// ---------------------------------------------------------------------------------------------
// Contents
// ---------------------------------------------------------------------------------------------

import { flattenTree, getCommit } from './store.ts';
import { hashObject, parseTree } from './gitcore.ts';

interface TreeLookup {
  kind: 'file' | 'dir' | 'missing';
  oid: string;
  size: number;
}

/** Resolve a path inside a tree: a file (blob), a directory (subtree), or nothing. */
function lookupPath(repo: Repo, treeOid: string, segments: readonly string[]): TreeLookup {
  let current = treeOid;
  for (let i = 0; i < segments.length; i += 1) {
    const object = repo.objects.get(current);
    if (!object || object.type !== 'tree') return { kind: 'missing', oid: '', size: 0 };
    const entry = parseTree(object.data).find((candidate) => candidate.name === segments[i]);
    if (!entry) return { kind: 'missing', oid: '', size: 0 };
    if (i === segments.length - 1) {
      if (entry.mode === '40000') return { kind: 'dir', oid: entry.oid, size: 0 };
      const blob = repo.objects.get(entry.oid);
      return { kind: 'file', oid: entry.oid, size: blob?.data.length ?? 0 };
    }
    if (entry.mode !== '40000') return { kind: 'missing', oid: '', size: 0 };
    current = entry.oid;
  }
  return { kind: 'dir', oid: current, size: 0 };
}

/** The commit a contents call works on: a branch name's tip, or a sha, defaulting to the default branch. */
function contentsTip(repo: Repo, refParam: string | null): string | null {
  if (refParam === null || refParam === '') return branchTip(repo, repo.defaultBranch) ?? null;
  if (/^[0-9a-f]{40}$/.test(refParam) && repo.objects.has(refParam)) return refParam;
  return branchTip(repo, refParam) ?? null;
}

function handleContents(request: RestRequest, repo: Repo, rest: string[]): RestReply {
  const { method, query } = request;
  const path = rest.join('/');
  const segments = path === '' ? [] : path.split('/');
  if (method === 'GET') {
    const tip = contentsTip(repo, query.get('ref'));
    if (tip === null) {
      // An unborn repository has an empty root and nothing else.
      if (segments.length === 0) return { status: 200, body: [] };
      return notFound();
    }
    const commit = getCommit(repo, tip);
    if (!commit) return notFound();
    const found = segments.length === 0 ? { kind: 'dir' as const, oid: commit.tree, size: 0 } : lookupPath(repo, commit.tree, segments);
    if (found.kind === 'missing') return notFound();
    if (found.kind === 'file') {
      const blob = repo.objects.get(found.oid);
      const bytes = blob?.data ?? Buffer.alloc(0);
      return {
        status: 200,
        body: {
          type: 'file',
          encoding: 'base64',
          name: segments[segments.length - 1],
          path,
          sha: found.oid,
          size: bytes.length,
          content: bytes.toString('base64'),
        },
      };
    }
    const treeObject = repo.objects.get(found.oid);
    if (!treeObject || treeObject.type !== 'tree') return notFound();
    const entries = parseTree(treeObject.data).map((entry) => {
      const childPath = path === '' ? entry.name : `${path}/${entry.name}`;
      const isDir = entry.mode === '40000';
      const blob = isDir ? null : repo.objects.get(entry.oid);
      return {
        type: isDir ? 'dir' : 'file',
        name: entry.name,
        path: childPath,
        sha: entry.oid,
        size: isDir ? 0 : (blob?.data.length ?? 0),
      };
    });
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));
    return { status: 200, body: entries };
  }
  if (method === 'PUT' || method === 'DELETE') {
    const body = isRecord(request.body) ? request.body : {};
    const message = stringField(body, 'message') ?? (method === 'PUT' ? 'Update file' : 'Delete file');
    const branch = stringField(body, 'branch') ?? repo.defaultBranch;
    const tip = branchTip(repo, branch) ?? (branch === repo.defaultBranch ? null : (branchTip(repo, repo.defaultBranch) ?? null));
    const flat = tip === null ? new Map<string, { mode: string; oid: string }>() : flattenTree(repo, (getCommit(repo, tip)?.tree as string) ?? '');
    const existing = flat.get(path);
    if (method === 'DELETE') {
      if (existing === undefined) return notFound();
      const sha = stringField(body, 'sha');
      if (sha !== undefined && sha !== existing.oid) return { status: 409, body: { message: 'sha does not match the current blob' } };
      const commitSha = commitChanges(repo, branch, new Map([[path, null]]), message, store.nextTick());
      return { status: 200, body: { content: null, commit: { sha: commitSha, message } } };
    }
    const contentBase64 = stringField(body, 'content');
    if (contentBase64 === undefined) return unprocessable('content is required.');
    const bytes = Buffer.from(contentBase64.replace(/\s+/g, ''), 'base64');
    const sha = stringField(body, 'sha');
    if (existing !== undefined && sha !== undefined && sha !== existing.oid) {
      return { status: 409, body: { message: 'sha does not match the current blob' } };
    }
    if (existing !== undefined && sha === undefined) {
      return { status: 409, body: { message: 'sha is required to update an existing file' } };
    }
    const commitSha = commitChanges(repo, branch, new Map([[path, bytes]]), message, store.nextTick());
    const blobOid = hashObject('blob', bytes);
    return {
      status: existing === undefined ? 201 : 200,
      body: {
        content: {
          type: 'file',
          encoding: 'base64',
          name: segments[segments.length - 1],
          path,
          sha: blobOid,
          size: bytes.length,
          content: bytes.toString('base64'),
        },
        commit: { sha: commitSha, message },
      },
    };
  }
  return notFound();
}

// ---------------------------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------------------------

function handleLabels(request: RestRequest, repo: Repo, rest: string[]): RestReply {
  const { method } = request;
  if (rest.length === 0) {
    if (method === 'GET') {
      return { status: 200, body: [...repo.labels.keys()].map((name) => labelJson(repo, name)) };
    }
    if (method === 'POST') {
      const body = isRecord(request.body) ? request.body : {};
      const name = stringField(body, 'name');
      if (name === undefined || name === '') return unprocessable('name is required.');
      if (repo.labels.has(name)) return unprocessable('Validation Failed: label already exists.');
      const color = (stringField(body, 'color') ?? 'ededed').replace(/^#/, '').toLowerCase();
      repo.labels.set(name, { name, color });
      return { status: 201, body: labelJson(repo, name) };
    }
  }
  return notFound();
}

// ---------------------------------------------------------------------------------------------
// Issues and comments
// ---------------------------------------------------------------------------------------------

/** The label names an issue-create body names (strings, or {name} objects), or null when malformed. */
function labelNamesOf(body: Record<string, unknown>): string[] | null {
  const labels = body.labels;
  if (labels === undefined) return [];
  if (!Array.isArray(labels)) return null;
  const names: string[] = [];
  for (const entry of labels) {
    if (typeof entry === 'string') names.push(entry);
    else if (isRecord(entry) && typeof entry.name === 'string') names.push(entry.name);
    else return null;
  }
  return names;
}

function handleIssues(request: RestRequest, repo: Repo, rest: string[]): RestReply {
  const { method, query } = request;
  if (rest.length === 0) {
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let issues = [...repo.issues.values()];
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      const direction = query.get('direction') ?? 'desc';
      issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      const page = paginate(issues.map((issue) => issueJson(repo, issue)), query, request.origin, request.path);
      return { status: 200, body: page.items, headers: page.headers };
    }
    if (method === 'POST') {
      const body = isRecord(request.body) ? request.body : {};
      const title = stringField(body, 'title');
      if (title === undefined) return unprocessable('title is required.');
      const labelNames = labelNamesOf(body);
      if (labelNames === null) return unprocessable('labels are malformed.');
      for (const name of labelNames) {
        if (!repo.labels.has(name)) return unprocessable(`Label "${name}" does not exist.`);
      }
      const issue = createIssueRecord(store, repo, {
        title,
        body: stringField(body, 'body') ?? '',
        labelNames,
        authorLogin: VIEWER.login,
      });
      return { status: 201, body: issueJson(repo, issue) };
    }
    return notFound();
  }
  const number = Number.parseInt(rest[0] as string, 10);
  const issue = Number.isFinite(number) ? repo.issues.get(number) : undefined;
  if (rest.length === 1) {
    if (issue === undefined) return notFound();
    if (method === 'GET') return { status: 200, body: issueJson(repo, issue) };
    if (method === 'PATCH') {
      const body = isRecord(request.body) ? request.body : {};
      const state = stringField(body, 'state');
      if (state === 'open' || state === 'closed') issue.state = state;
      const title = stringField(body, 'title');
      if (title !== undefined) issue.title = title;
      const text = stringField(body, 'body');
      if (text !== undefined) issue.body = text;
      const labelNames = labelNamesOf(body);
      if (labelNames !== null) {
        for (const name of labelNames) {
          if (!repo.labels.has(name)) return unprocessable(`Label "${name}" does not exist.`);
        }
        issue.labelNames = labelNames;
      }
      return { status: 200, body: issueJson(repo, issue) };
    }
    return notFound();
  }
  if (rest.length === 2 && rest[1] === 'comments') {
    if (issue === undefined) return notFound();
    if (method === 'GET') {
      return { status: 200, body: issue.comments.map((comment) => commentJson(repo, issue, comment)) };
    }
    if (method === 'POST') {
      const body = isRecord(request.body) ? request.body : {};
      const text = stringField(body, 'body');
      if (text === undefined) return unprocessable('body is required.');
      const comment = addCommentRecord(store, issue, text, VIEWER.login);
      return { status: 201, body: commentJson(repo, issue, comment) };
    }
  }
  return notFound();
}

// ---------------------------------------------------------------------------------------------
// Pull requests
// ---------------------------------------------------------------------------------------------

function handlePulls(request: RestRequest, repo: Repo, rest: string[]): RestReply {
  const { method, query } = request;
  if (rest.length === 0) {
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let pulls = [...repo.pulls.values()];
      if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
      else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
      pulls.sort((a, b) => b.number - a.number);
      const page = paginate(pulls.map((pull) => pullJson(repo, pull)), query, request.origin, request.path);
      return { status: 200, body: page.items, headers: page.headers };
    }
    if (method === 'POST') {
      const body = isRecord(request.body) ? request.body : {};
      const title = stringField(body, 'title');
      const headRaw = stringField(body, 'head');
      const baseRaw = stringField(body, 'base');
      if (title === undefined || headRaw === undefined || baseRaw === undefined) {
        return unprocessable('title, head and base are required.');
      }
      const head = headRaw.includes(':') ? (headRaw.split(':').pop() as string) : headRaw;
      const base = baseRaw.includes(':') ? (baseRaw.split(':').pop() as string) : baseRaw;
      if (branchTip(repo, head) === undefined) return unprocessable(`Head branch "${head}" does not exist.`);
      if (branchTip(repo, base) === undefined) return unprocessable(`Base branch "${base}" does not exist.`);
      if (openPullFor(repo, head, base) !== undefined) {
        return unprocessable(`A pull request already exists for ${head} into ${base}.`);
      }
      const pull = createPullRecord(store, repo, {
        title,
        body: stringField(body, 'body') ?? '',
        headRef: head,
        baseRef: base,
        authorLogin: VIEWER.login,
      });
      return { status: 201, body: pullJson(repo, pull) };
    }
    return notFound();
  }
  const number = Number.parseInt(rest[0] as string, 10);
  const pull = Number.isFinite(number) ? repo.pulls.get(number) : undefined;
  if (rest.length === 1) {
    if (pull === undefined) return notFound();
    if (method === 'GET') return { status: 200, body: pullJson(repo, pull) };
    return notFound();
  }
  if (rest.length === 2 && rest[1] === 'files' && method === 'GET') {
    if (pull === undefined) return notFound();
    const files = pullChangedFiles(repo, pull).map((file) => ({
      filename: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
    }));
    return { status: 200, body: files };
  }
  if (rest.length === 2 && rest[1] === 'merge' && method === 'PUT') {
    if (pull === undefined) return notFound();
    if (pull.state !== 'open') {
      return { status: 405, body: { message: 'Pull Request is not open.' } };
    }
    const body = isRecord(request.body) ? request.body : {};
    const methodName = stringField(body, 'merge_method') ?? 'squash';
    const result = mergePullRequest(repo, pull, methodName === 'merge' ? 'merge' : 'squash', store.nextTick());
    if (!result.ok || result.sha === null) {
      return { status: 405, body: { message: 'Pull Request is not mergeable.' } };
    }
    return { status: 200, body: { sha: result.sha, merged: true, message: 'Pull Request successfully merged' } };
  }
  return notFound();
}
