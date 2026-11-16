// The forge's store: everything lives in memory, in plain Maps, owned by one Store instance.
//
// In-memory is a deliberate design choice for this forge: a trial's state is born empty, is
// driven hard for a few minutes (thousands of issue reads, hundreds of pushes, fifty
// concurrent clones), and is never needed again. Maps answer in O(1), nothing touches a
// disk, and the four timed workloads stay fast because of it.
//
// Determinism: the store keeps a synthetic clock — a counter that starts at the deployment
// epoch and advances one second per timestamped event — so two runs that take the same
// requests produce the same bytes. No wall clock is ever read.

import {
  buildCommit,
  buildTree,
  hashObject,
  parseCommit,
  parseTag,
  parseTree,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
} from './gitcore.ts';
import { VIEWER, type ForgeUser } from './identity.ts';

/** 2025-01-01T00:00:00Z: the synthetic clock's first second. */
export const CLOCK_EPOCH_SEC = 1_735_689_600;

export interface Label {
  name: string;
  color: string;
}

export interface IssueComment {
  globalId: number;
  body: string;
  authorLogin: string;
  createdTick: number;
}

export interface Issue {
  globalId: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labelNames: string[];
  authorLogin: string;
  comments: IssueComment[];
  createdTick: number;
}

export interface PullRequest {
  globalId: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergeCommitSha: string | null;
  mergedTick: number | null;
  headRef: string;
  baseRef: string;
  authorLogin: string;
  createdTick: number;
}

export interface Repo {
  dbId: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  issueSeq: number;
  pulls: Map<number, PullRequest>;
  pullSeq: number;
  /** Issues and pull requests share one number sequence per repository, as on GitHub. */
  numberSeq: number;
  createdTick: number;
}

/** The whole forge: repositories by "owner/name", plus the id and clock counters. */
export class Store {
  readonly repos = new Map<string, Repo>();
  /** Repository keys in creation order (the viewer's list order). */
  readonly repoOrder: string[] = [];
  private repoSeq = 5000;
  private issueSeq = 0;
  private commentSeq = 0;
  private pullSeq = 0;
  private tick = 0;
  private requestSeq = 0;

  /** The next synthetic-clock second (seconds since the epoch, then ISO). */
  nextTick(): number {
    const tick = this.tick;
    this.tick += 1;
    return tick;
  }

  /** A request id for the X-GitHub-Request-Id header: present on every reply, never empty. */
  nextRequestId(): string {
    this.requestSeq += 1;
    return `gitforge-${this.requestSeq.toString(16).padStart(8, '0')}`;
  }

  createRepo(owner: string, name: string, init: { description?: string; isPrivate?: boolean; defaultBranch?: string }): Repo {
    const repo: Repo = {
      dbId: this.repoSeq++,
      owner,
      name,
      description: init.description ?? '',
      isPrivate: init.isPrivate ?? false,
      defaultBranch: init.defaultBranch ?? 'main',
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      issueSeq: 0,
      pulls: new Map(),
      pullSeq: 0,
      numberSeq: 0,
      createdTick: this.nextTick(),
    };
    const key = repoKey(owner, name);
    this.repos.set(key, repo);
    this.repoOrder.push(key);
    return repo;
  }

  repo(owner: string, name: string): Repo | undefined {
    return this.repos.get(repoKey(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    const key = repoKey(owner, name);
    if (!this.repos.delete(key)) return false;
    const index = this.repoOrder.indexOf(key);
    if (index >= 0) this.repoOrder.splice(index, 1);
    return true;
  }

  /** Every repository a login owns, in creation order. */
  reposOf(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const key of this.repoOrder) {
      const repo = this.repos.get(key);
      if (repo && repo.owner === owner) out.push(repo);
    }
    return out;
  }

  nextIssueGlobalId(): number {
    this.issueSeq += 1;
    return this.issueSeq;
  }

  nextCommentGlobalId(): number {
    this.commentSeq += 1;
    return this.commentSeq;
  }

  nextPullGlobalId(): number {
    this.pullSeq += 1;
    return this.pullSeq;
  }
}

export function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

/** An ISO timestamp for a synthetic tick. */
export function isoOf(tick: number): string {
  return new Date((CLOCK_EPOCH_SEC + tick) * 1000).toISOString();
}

/** The single store this process serves. */
export const store = new Store();

// ---------------------------------------------------------------------------------------------
// Global (Relay) node ids: opaque, stable, and never the plain database id.
// ---------------------------------------------------------------------------------------------

export type NodeKind = 'Repository' | 'Issue' | 'PullRequest' | 'IssueComment' | 'User';

export function nodeId(kind: NodeKind, key: string | number): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64');
}

export function issueNodeId(repoDbId: number, number: number): string {
  return nodeId('Issue', `${repoDbId}:${number}`);
}

export function pullNodeId(repoDbId: number, number: number): string {
  return nodeId('PullRequest', `${repoDbId}:${number}`);
}

export interface DecodedNodeId {
  kind: string;
  key: string;
}

export function decodeNodeId(id: string): DecodedNodeId | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { kind: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Object and tree helpers over one repository.
// ---------------------------------------------------------------------------------------------

/** Store an object in a repo (idempotent) and answer its id. */
export function putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export function getCommit(repo: Repo, oid: string): ReturnType<typeof parseCommit> | null {
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'commit') return null;
  return parseCommit(object.data);
}

/** Peel an object id to the commit it names (through annotated tags), or null. */
export function peelToCommit(repo: Repo, oid: string): string | null {
  let current = oid;
  for (let depth = 0; depth < 16; depth += 1) {
    const object = repo.objects.get(current);
    if (!object) return null;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      current = parseTag(object.data).object;
      continue;
    }
    return null;
  }
  return null;
}

export interface FlatEntry {
  mode: string;
  oid: string;
}

/** Flatten a tree (recursively) into a path -> entry map. */
export function flattenTree(repo: Repo, treeOid: string, prefix = '', out = new Map<string, FlatEntry>()): Map<string, FlatEntry> {
  const object = repo.objects.get(treeOid);
  if (!object || object.type !== 'tree') return out;
  for (const entry of parseTree(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(repo, entry.oid, path, out);
    else out.set(path, { mode: entry.mode, oid: entry.oid });
  }
  return out;
}

/** The flat path map of a commit's tree (empty for an unknown commit). */
export function commitFiles(repo: Repo, commitOid: string): Map<string, FlatEntry> {
  const commit = getCommit(repo, commitOid);
  if (!commit) return new Map();
  return flattenTree(repo, commit.tree);
}

/** Build (and store) nested trees from a flat path map; answers the root tree id. */
export function buildTreeFromFlat(repo: Repo, flat: Map<string, FlatEntry>): string {
  interface Node {
    files: Map<string, FlatEntry>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, entry] of flat) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const segment = segments[i] as string;
      let next = node.dirs.get(segment);
      if (!next) {
        next = { files: new Map(), dirs: new Map() };
        node.dirs.set(segment, next);
      }
      node = next;
    }
    node.files.set(segments[segments.length - 1] as string, entry);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return putObject(repo, 'tree', buildTree(entries));
  };
  return build(root);
}

/** The identity server-side commits carry (the token owner's provisioned account). */
export function identityLine(user: ForgeUser): string {
  return `${user.name} <${user.email}>`;
}

/**
 * Commit a set of file changes onto a branch: `changes` maps a path to its new blob bytes,
 * or null to delete it. Creates the branch (as a root commit) when it does not exist yet and
 * the repo has no commit to start from; when the branch does not exist but the default branch
 * does, the new branch starts from the default branch's tip. Answers the new commit id.
 */
export function commitChanges(
  repo: Repo,
  branch: string,
  changes: ReadonlyMap<string, Buffer | null>,
  message: string,
  tick: number,
): string {
  const ref = `refs/heads/${branch}`;
  let parent = repo.refs.get(ref) ?? null;
  if (parent === null && branch !== repo.defaultBranch) {
    parent = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  }
  const flat = parent === null ? new Map<string, FlatEntry>() : commitFiles(repo, parent);
  for (const [path, bytes] of changes) {
    if (bytes === null) flat.delete(path);
    else flat.set(path, { mode: '100644', oid: putObject(repo, 'blob', bytes) });
  }
  const tree = buildTreeFromFlat(repo, flat);
  const commit = buildCommit({
    tree,
    parents: parent === null ? [] : [parent],
    message,
    author: identityLine(VIEWER),
    committer: identityLine(VIEWER),
    timestamp: CLOCK_EPOCH_SEC + tick,
  });
  const oid = putObject(repo, 'commit', commit);
  repo.refs.set(ref, oid);
  return oid;
}

/** Every ancestor of a commit (including itself), breadth-first. */
export function ancestorsOf(repo: Repo, tip: string): Map<string, number> {
  const distance = new Map<string, number>();
  const queue: Array<[string, number]> = [[tip, 0]];
  while (queue.length > 0) {
    const [oid, depth] = queue.shift() as [string, number];
    if (distance.has(oid)) continue;
    distance.set(oid, depth);
    const commit = getCommit(repo, oid);
    if (!commit) continue;
    for (const parent of commit.parents) queue.push([parent, depth + 1]);
  }
  return distance;
}

/** True when `ancestor` is `tip` itself or one of its ancestors (depth-first, early exit). */
export function isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
  const seen = new Set<string>();
  const stack: string[] = [tip];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const commit = getCommit(repo, oid);
    if (!commit) continue;
    for (const parent of commit.parents) stack.push(parent);
  }
  return false;
}

/** The best common ancestor of two commits, or null when they share no history. */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const ancestorsA = ancestorsOf(repo, a);
  const ancestorsB = ancestorsOf(repo, b);
  let best: string | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const [oid, depthA] of ancestorsA) {
    const depthB = ancestorsB.get(oid);
    if (depthB === undefined) continue;
    const score = depthA + depthB;
    if (score < bestScore) {
      bestScore = score;
      best = oid;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------------------------
// Pull-request merging and file diffs (shared by REST, GraphQL and MCP).
// ---------------------------------------------------------------------------------------------

function sameEntry(a: FlatEntry | undefined, b: FlatEntry | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.oid === b.oid && a.mode === b.mode;
}

export interface ThreeWayResult {
  conflict: boolean;
  flat: Map<string, FlatEntry>;
}

/**
 * A file-level three-way merge: the changes the head made since the merge base, applied onto
 * the base branch's current tree. A path both sides changed differently is a conflict.
 */
export function threeWayMerge(repo: Repo, baseTip: string, headTip: string): ThreeWayResult {
  const base = mergeBase(repo, baseTip, headTip);
  const baseFlat = commitFiles(repo, baseTip);
  const headFlat = commitFiles(repo, headTip);
  const mbFlat = base === null ? new Map<string, FlatEntry>() : commitFiles(repo, base);
  const out = new Map<string, FlatEntry>();
  const paths = new Set<string>([...baseFlat.keys(), ...headFlat.keys(), ...mbFlat.keys()]);
  for (const path of paths) {
    const b = baseFlat.get(path);
    const h = headFlat.get(path);
    const m = mbFlat.get(path);
    let result: FlatEntry | undefined;
    if (sameEntry(h, m)) result = b;
    else if (sameEntry(b, m)) result = h;
    else if (sameEntry(h, b)) result = h;
    else return { conflict: true, flat: out };
    if (result !== undefined) out.set(path, result);
  }
  return { conflict: false, flat: out };
}

export interface MergeResult {
  ok: boolean;
  conflict: boolean;
  sha: string | null;
}

/**
 * Merge a pull request into its base branch. `squash` lands one commit holding the merged
 * tree; `merge` lands a two-parent commit with the same tree. The pull record is updated to
 * closed/merged with the merge commit's id.
 */
export function mergePullRequest(repo: Repo, pull: PullRequest, method: 'squash' | 'merge', tick: number): MergeResult {
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  if (baseTip === undefined || headTip === undefined) return { ok: false, conflict: true, sha: null };
  const merged = threeWayMerge(repo, baseTip, headTip);
  if (merged.conflict) return { ok: false, conflict: true, sha: null };
  const tree = buildTreeFromFlat(repo, merged.flat);
  const message = method === 'squash' ? `${pull.title}\n\n${pull.body}\n` : `Merge pull request #${pull.number} from ${pull.headRef}\n`;
  const commit = buildCommit({
    tree,
    parents: method === 'squash' ? [baseTip] : [baseTip, headTip],
    message,
    author: identityLine(VIEWER),
    committer: identityLine(VIEWER),
    timestamp: CLOCK_EPOCH_SEC + tick,
  });
  const sha = putObject(repo, 'commit', commit);
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergeCommitSha = sha;
  pull.mergedTick = tick;
  return { ok: true, conflict: false, sha };
}

/** True when the pull request would merge cleanly right now. */
export function pullMergeable(repo: Repo, pull: PullRequest): boolean {
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  if (baseTip === undefined || headTip === undefined) return false;
  return !threeWayMerge(repo, baseTip, headTip).conflict;
}

export interface ChangedFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

function lineCount(bytes: Buffer): number {
  if (bytes.length === 0) return 0;
  let count = 0;
  for (const byte of bytes) if (byte === 0x0a) count += 1;
  return bytes[bytes.length - 1] === 0x0a ? count : count + 1;
}

function splitLines(bytes: Buffer): string[] {
  const text = bytes.toString('utf8');
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** The length of the longest common subsequence of two line lists (files here are small). */
function lcsLength(a: string[], b: string[]): number {
  const dp = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = 0;
    for (let j = 1; j <= b.length; j += 1) {
      const above = dp[j] as number;
      if (a[i - 1] === b[j - 1]) dp[j] = diagonal + 1;
      else dp[j] = Math.max(dp[j] as number, dp[j - 1] as number);
      diagonal = above;
    }
  }
  return dp[b.length] as number;
}

/** The files a pull request changes: the head's tree against the merge base's tree. */
export function pullChangedFiles(repo: Repo, pull: PullRequest): ChangedFile[] {
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  if (baseTip === undefined || headTip === undefined) return [];
  const base = mergeBase(repo, baseTip, headTip);
  const fromFlat = base === null ? new Map<string, FlatEntry>() : commitFiles(repo, base);
  const toFlat = commitFiles(repo, headTip);
  const files: ChangedFile[] = [];
  const paths = new Set<string>([...fromFlat.keys(), ...toFlat.keys()]);
  for (const path of paths) {
    const from = fromFlat.get(path);
    const to = toFlat.get(path);
    if (sameEntry(from, to)) continue;
    const fromBytes = from ? (repo.objects.get(from.oid)?.data ?? Buffer.alloc(0)) : null;
    const toBytes = to ? (repo.objects.get(to.oid)?.data ?? Buffer.alloc(0)) : null;
    if (from === undefined && toBytes !== null) {
      const additions = lineCount(toBytes);
      files.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (to === undefined && fromBytes !== null) {
      const deletions = lineCount(fromBytes);
      files.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (fromBytes !== null && toBytes !== null) {
      const fromLines = splitLines(fromBytes);
      const toLines = splitLines(toBytes);
      const common = lcsLength(fromLines, toLines);
      const additions = toLines.length - common;
      const deletions = fromLines.length - common;
      files.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  files.sort((x, y) => (x.filename < y.filename ? -1 : 1));
  return files;
}

// ---------------------------------------------------------------------------------------------
// Domain operations the three API surfaces (REST, GraphQL, MCP) share, so an object created
// over one surface is the same object over the others, ids and numbers alike.
// ---------------------------------------------------------------------------------------------

/** Create an issue on a repo: the next shared number, a fresh global id, state open. */
export function createIssueRecord(
  storeRef: Store,
  repo: Repo,
  input: { title: string; body: string; labelNames?: readonly string[]; authorLogin: string },
): Issue {
  repo.numberSeq += 1;
  const issue: Issue = {
    globalId: storeRef.nextIssueGlobalId(),
    number: repo.numberSeq,
    title: input.title,
    body: input.body,
    state: 'open',
    labelNames: [...(input.labelNames ?? [])],
    authorLogin: input.authorLogin,
    comments: [],
    createdTick: storeRef.nextTick(),
  };
  repo.issues.set(issue.number, issue);
  return issue;
}

/** Create a pull request record (the caller validates the branches first). */
export function createPullRecord(
  storeRef: Store,
  repo: Repo,
  input: { title: string; body: string; headRef: string; baseRef: string; authorLogin: string },
): PullRequest {
  repo.numberSeq += 1;
  const pull: PullRequest = {
    globalId: storeRef.nextPullGlobalId(),
    number: repo.numberSeq,
    title: input.title,
    body: input.body,
    state: 'open',
    merged: false,
    mergeCommitSha: null,
    mergedTick: null,
    headRef: input.headRef,
    baseRef: input.baseRef,
    authorLogin: input.authorLogin,
    createdTick: storeRef.nextTick(),
  };
  repo.pulls.set(pull.number, pull);
  return pull;
}

/** Add a comment to an issue. */
export function addCommentRecord(storeRef: Store, issue: Issue, body: string, authorLogin: string): IssueComment {
  const comment: IssueComment = {
    globalId: storeRef.nextCommentGlobalId(),
    body,
    authorLogin,
    createdTick: storeRef.nextTick(),
  };
  issue.comments.push(comment);
  return comment;
}

/** An open pull request for the same head and base, when one exists (creation refuses it). */
export function openPullFor(repo: Repo, headRef: string, baseRef: string): PullRequest | undefined {
  for (const pull of repo.pulls.values()) {
    if (pull.state === 'open' && pull.headRef === headRef && pull.baseRef === baseRef) return pull;
  }
  return undefined;
}
