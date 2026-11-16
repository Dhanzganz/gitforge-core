// Git smart HTTP: the ref advertisements (protocol v0 and v2), ls-refs, upload-pack fetch
// (full, incremental and shallow, over v2 sections or the v0 sideband stream) and
// receive-pack push with report-status. The dialect spoken here is the one real git and
// the suite's in-process client share: pkt-line framing everywhere, capability lists on
// the advertisement, and per-ref ok/ng answers on a push.

import {
  decodePktLines,
  encodePktLine,
  isObjectId,
  parseCommit,
  parseTag,
  pktDelim,
  pktFlush,
  readPack,
  writePack,
  ZERO_OID,
  type GitObject,
} from './gitcore.ts';
import { isAncestor, peelToCommit, type Repo } from './store.ts';

export const FORGE_AGENT = 'gitforge-core/1.0.0';

export interface SmartReply {
  status: number;
  contentType: string;
  body: Buffer;
}

const UPLOAD_CAPS_V0 = (repo: Repo): string =>
  `multi_ack_detailed side-band-64k thin-pack ofs-delta shallow agent=${FORGE_AGENT} symref=HEAD:refs/heads/${repo.defaultBranch} object-format=sha1`;
const RECEIVE_CAPS = `report-status side-band-64k delete-refs ofs-delta agent=${FORGE_AGENT}`;

/** Every ref a repo advertises, sorted by name, with HEAD resolved separately. */
export function sortedRefs(repo: Repo): Array<[string, string]> {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

/** The commit an annotated tag peels to, or null for a lightweight tag / non-tag. */
function peeledOf(repo: Repo, oid: string): string | null {
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'tag') return null;
  return peelToCommit(repo, oid);
}

/** The v0 advertisement body for either service. */
export function advertiseV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_CAPS_V0(repo) : RECEIVE_CAPS;
  const parts: Buffer[] = [encodePktLine(`# service=${service}\n`), pktFlush()];
  const refs = sortedRefs(repo);
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headRef);
  if (refs.length === 0) {
    parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\u0000${caps}\n`));
    parts.push(pktFlush());
    return Buffer.concat(parts);
  }
  parts.push(encodePktLine(`${headOid ?? ZERO_OID} HEAD\u0000${caps}\n`));
  for (const [name, oid] of refs) {
    parts.push(encodePktLine(`${oid} ${name}\n`));
    const peeled = peeledOf(repo, oid);
    if (peeled !== null) parts.push(encodePktLine(`${peeled} ${name}^{}\n`));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** The v2 capability advertisement (upload-pack only; receive-pack is v0 only). */
export function advertiseV2(repo: Repo): Buffer {
  void repo;
  const lines = [
    'version 2',
    `agent=${FORGE_AGENT}`,
    'object-format=sha1',
    'fetch=shallow wait-for-done',
    'ls-refs=unborn',
  ];
  const parts: Buffer[] = [encodePktLine('# service=git-upload-pack\n'), pktFlush()];
  for (const line of lines) parts.push(encodePktLine(`${line}\n`));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

export function infoRefs(repo: Repo, service: string, gitProtocol: string | null): SmartReply {
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    return { status: 400, contentType: 'text/plain', body: Buffer.from('unknown service') };
  }
  const wantsV2 = gitProtocol !== null && /(?:^|[\s,])version=2(?:\s|,|$)/.test(gitProtocol);
  if (service === 'git-upload-pack' && wantsV2) {
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: advertiseV2(repo) };
  }
  return {
    status: 200,
    contentType: `application/x-${service}-advertisement`,
    body: advertiseV0(repo, service),
  };
}

// ---------------------------------------------------------------------------------------------
// ls-refs (protocol v2)
// ---------------------------------------------------------------------------------------------

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

export function lsRefs(repo: Repo, args: LsRefsArgs): Buffer {
  const matches = (name: string): boolean =>
    args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headRef);
  if (matches('HEAD')) {
    if (headOid !== undefined) {
      const suffix = args.symrefs ? ` symref-target:${headRef}` : '';
      parts.push(encodePktLine(`${headOid} HEAD${suffix}\n`));
    } else if (args.unborn) {
      const suffix = args.symrefs ? ` symref-target:${headRef}` : '';
      parts.push(encodePktLine(`unborn HEAD${suffix}\n`));
    } else {
      const suffix = args.symrefs ? ` symref-target:${headRef}` : '';
      parts.push(encodePktLine(`${ZERO_OID} HEAD${suffix}\n`));
    }
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (!matches(name)) continue;
    let line = `${oid} ${name}`;
    if (args.peel) {
      const peeled = peeledOf(repo, oid);
      if (peeled !== null) line += ` peeled:${peeled}`;
    }
    parts.push(encodePktLine(`${line}\n`));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// Object collection for a pack
// ---------------------------------------------------------------------------------------------

/**
 * Every object reachable from `roots`. When a commit is in `stopAtCommits` it is included
 * but its parents are not followed (the shallow boundary the client already holds).
 */
export function collectObjects(repo: Repo, roots: Iterable<string>, stopAtCommits?: ReadonlySet<string>): Map<string, GitObject> {
  const out = new Map<string, GitObject>();
  const stack: string[] = [...roots];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (out.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object) continue;
    out.set(oid, object);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      stack.push(commit.tree);
      if (!stopAtCommits?.has(oid)) for (const parent of commit.parents) stack.push(parent);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTreeEntries(repo, oid)) stack.push(entry);
    }
  }
  return out;
}

function parseTreeEntries(repo: Repo, treeOid: string): string[] {
  const object = repo.objects.get(treeOid);
  if (!object || object.type !== 'tree') return [];
  const entries: string[] = [];
  let offset = 0;
  const buffer = object.data;
  while (offset < buffer.length) {
    const nul = buffer.indexOf(0x00, offset);
    entries.push(buffer.subarray(nul + 1, nul + 21).toString('hex'));
    offset = nul + 21;
  }
  return entries;
}

/** Commits whose shortest distance from any tip is < depth (tips are distance 0). */
function commitsWithinDepth(repo: Repo, tips: readonly string[], depth: number): Set<string> {
  const distance = new Map<string, number>();
  const queue: Array<[string, number]> = tips.map((tip) => [tip, 0]);
  while (queue.length > 0) {
    const [oid, depthHere] = queue.shift() as [string, number];
    const known = distance.get(oid);
    if (known !== undefined && known <= depthHere) continue;
    distance.set(oid, depthHere);
    if (depthHere + 1 >= depth) continue;
    const commit = repo.objects.get(oid);
    if (!commit || commit.type !== 'commit') continue;
    for (const parent of parseCommit(commit.data).parents) queue.push([parent, depthHere + 1]);
  }
  return new Set([...distance.entries()].filter(([, d]) => d < depth).map(([oid]) => oid));
}

/** Chunk pack bytes into sideband band-1 pkt-lines (band 2/3 stay unused: no progress, no errors). */
function sidebandPackets(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const CHUNK = 65520 - 4 - 1;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  return parts;
}

// ---------------------------------------------------------------------------------------------
// upload-pack: ls-refs and fetch
// ---------------------------------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen: number | null;
  done: boolean;
}

function parseFetchArgs(lines: readonly string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], deepen: null, done: false };
  for (const line of lines) {
    const text = line.replace(/\n$/, '');
    if (text.startsWith('want ')) args.wants.push(text.slice(5).trim().split(' ')[0] as string);
    else if (text.startsWith('have ')) args.haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) args.shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) args.deepen = Number.parseInt(text.slice(7), 10);
    else if (text === 'done') args.done = true;
  }
  return args;
}

interface FetchPlan {
  pack: Buffer;
  acks: string[];
  nak: boolean;
  shallowLines: string[];
  unshallowLines: string[];
  shallowInvolved: boolean;
}

/** Work out which objects a fetch sends, and the shallow bookkeeping that goes with them. */
function planFetch(repo: Repo, args: FetchArgs): FetchPlan {
  const wantCommits: string[] = [];
  for (const want of args.wants) {
    const commit = peelToCommit(repo, want);
    if (commit !== null) wantCommits.push(commit);
  }
  const haveSet = new Set(args.haves);
  const shallowSet = new Set(args.shallow);
  const acks = args.haves.filter((have) => repo.objects.has(have));
  const nak = args.haves.length > 0 && acks.length === 0;

  let packObjects: Map<string, GitObject>;
  const shallowLines: string[] = [];
  const unshallowLines: string[] = [];
  const shallowInvolved = args.deepen !== null || args.shallow.length > 0;

  if (args.deepen !== null && Number.isFinite(args.deepen)) {
    const include = commitsWithinDepth(repo, wantCommits, args.deepen);
    // What the client already holds: the closure of its haves and its shallow boundary,
    // never descending below a shallow commit (a shallow have is held, its parents are not).
    const exclude = collectObjects(repo, [...args.haves, ...args.shallow], shallowSet);
    packObjects = new Map();
    const includeObjects = collectObjects(repo, [...include, ...args.wants], shallowBoundaryOf(repo, include));
    for (const [oid, object] of includeObjects) {
      if (!exclude.has(oid)) packObjects.set(oid, object);
    }
    const boundary = new Set<string>();
    for (const oid of include) {
      const commit = repo.objects.get(oid);
      if (!commit || commit.type !== 'commit') continue;
      const parents = parseCommit(commit.data).parents;
      if (parents.length > 0 && parents.some((parent) => !include.has(parent))) boundary.add(oid);
    }
    for (const oid of boundary) shallowLines.push(oid);
    for (const oid of shallowSet) {
      if (!include.has(oid)) {
        if (!shallowLines.includes(oid)) shallowLines.push(oid);
      } else if (!boundary.has(oid)) {
        unshallowLines.push(oid);
      }
    }
  } else {
    const wanted = collectObjects(repo, args.wants);
    const excluded = collectObjects(repo, args.haves);
    packObjects = new Map();
    for (const [oid, object] of wanted) if (!excluded.has(oid)) packObjects.set(oid, object);
    void haveSet;
  }
  return { pack: writePack(packObjects.values()), acks, nak, shallowLines, unshallowLines, shallowInvolved };
}

/** The stop-at set for a shallow include set: its boundary commits. */
function shallowBoundaryOf(repo: Repo, include: ReadonlySet<string>): Set<string> {
  const boundary = new Set<string>();
  for (const oid of include) {
    const commit = repo.objects.get(oid);
    if (!commit || commit.type !== 'commit') continue;
    const parents = parseCommit(commit.data).parents;
    if (parents.some((parent) => !include.has(parent))) boundary.add(oid);
  }
  return boundary;
}

/**
 * Fetch replies are a pure function of the request and the object graph, and objects are
 * content-addressed and immutable: the same want/have/shallow/deepen request always earns
 * the same bytes, however many pushes land in between. Memoize them (bounded per repo) —
 * fifty concurrent clones of one tip then cost one pack build and fifty buffer writes.
 */
const fetchReplyCache = new WeakMap<Repo, Map<string, Buffer>>();

function cachedFetchReply(repo: Repo, variant: 'v2' | 'v0', args: FetchArgs, build: () => Buffer): Buffer {
  const key = `${variant}|${args.wants.join(',')}|${args.haves.join(',')}|${args.shallow.join(',')}|${args.deepen ?? ''}`;
  let cache = fetchReplyCache.get(repo);
  if (cache === undefined) {
    cache = new Map();
    fetchReplyCache.set(repo, cache);
  }
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const reply = build();
  if (cache.size >= 128) cache.clear();
  cache.set(key, reply);
  return reply;
}

/** A v2 fetch response: acknowledgments, shallow-info, then the packfile in sideband packets. */
function fetchV2Reply(repo: Repo, args: FetchArgs): Buffer {
  return cachedFetchReply(repo, 'v2', args, () => buildFetchV2Reply(repo, args));
}

function buildFetchV2Reply(repo: Repo, args: FetchArgs): Buffer {
  const plan = planFetch(repo, args);
  const parts: Buffer[] = [];
  if (args.haves.length > 0) {
    parts.push(encodePktLine('acknowledgments\n'));
    if (plan.nak) parts.push(encodePktLine('NAK\n'));
    for (const ack of plan.acks) parts.push(encodePktLine(`ACK ${ack}\n`));
    parts.push(pktDelim());
  }
  if (plan.shallowInvolved) {
    parts.push(encodePktLine('shallow-info\n'));
    for (const oid of plan.shallowLines) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallowLines) parts.push(encodePktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim());
  }
  parts.push(encodePktLine('packfile\n'));
  parts.push(...sidebandPackets(plan.pack));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** A v0 fetch response: shallow lines and NAK/ACK as plain pkt-lines, then the sideband pack. */
function fetchV0Reply(repo: Repo, args: FetchArgs): Buffer {
  return cachedFetchReply(repo, 'v0', args, () => buildFetchV0Reply(repo, args));
}

function buildFetchV0Reply(repo: Repo, args: FetchArgs): Buffer {
  const plan = planFetch(repo, args);
  const parts: Buffer[] = [];
  for (const oid of plan.shallowLines) parts.push(encodePktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallowLines) parts.push(encodePktLine(`unshallow ${oid}\n`));
  if (plan.nak || plan.acks.length === 0) parts.push(encodePktLine('NAK\n'));
  else for (const ack of plan.acks) parts.push(encodePktLine(`ACK ${ack}\n`));
  parts.push(...sidebandPackets(plan.pack));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** POST git-upload-pack: a v2 command request, or a v0 want/have exchange. */
export function uploadPack(repo: Repo, body: Buffer): SmartReply {
  const bad = (status: number, text: string): SmartReply => ({ status, contentType: 'text/plain', body: Buffer.from(text) });
  const { packets } = decodePktLines(body);
  const firstData = packets.find((packet) => packet.kind === 'data');
  if (!firstData || firstData.kind !== 'data') return bad(400, 'malformed pkt-line request');
  const firstLine = firstData.payload.toString('utf8');
  if (firstLine.startsWith('want ')) {
    const lines = packets.filter((p) => p.kind === 'data').map((p) => (p.kind === 'data' ? p.payload.toString('utf8') : ''));
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: fetchV0Reply(repo, parseFetchArgs(lines)) };
  }
  if (!firstLine.startsWith('command=')) return bad(400, 'unknown upload-pack request');
  // Split header lines (before the first delim) from argument lines (after it).
  const headerLines: string[] = [];
  const argLines: string[] = [];
  let afterDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    (afterDelim ? argLines : headerLines).push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  const command = (headerLines[0] ?? '').replace(/^command=/, '');
  if (command === 'ls-refs') {
    const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
    for (const line of argLines) {
      if (line === 'peel') args.peel = true;
      else if (line === 'symrefs') args.symrefs = true;
      else if (line === 'unborn') args.unborn = true;
      else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
    }
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: lsRefs(repo, args) };
  }
  if (command === 'fetch') {
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: fetchV2Reply(repo, parseFetchArgs(argLines)) };
  }
  return bad(400, `unknown command ${command}`);
}

// ---------------------------------------------------------------------------------------------
// receive-pack (protocol v0): command list + pack, report-status back
// ---------------------------------------------------------------------------------------------

interface PushCommandLine {
  oldOid: string;
  newOid: string;
  ref: string;
}

/**
 * POST git-receive-pack. The body is a pkt-line command list, a flush, and the packfile the
 * commands carry (absent for a delete-only push). Objects land in the store first; then each
 * ref update is validated in order (create, delete, fast-forward only) and answered with one
 * report-status line. A refused ref never blocks the others.
 */
export function receivePack(repo: Repo, body: Buffer): SmartReply {
  const bad = (status: number, text: string): SmartReply => ({ status, contentType: 'text/plain', body: Buffer.from(text) });
  const { packets, next } = decodePktLines(body);
  const commands: PushCommandLine[] = [];
  let capabilities = new Set<string>();
  let sawFlush = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      sawFlush = true;
      break;
    }
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\u0000');
    if (nul >= 0) {
      capabilities = new Set(line.slice(nul + 1).split(' ').filter(Boolean));
      line = line.slice(0, nul);
    }
    const parts = line.split(' ');
    if (parts.length !== 3 || !isObjectId(parts[0] as string) || !isObjectId(parts[1] as string)) {
      return bad(400, 'malformed receive-pack command');
    }
    commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
  }
  if (!sawFlush && commands.length === 0) return bad(400, 'malformed receive-pack body');
  const packBytes = body.subarray(next);

  let unpackError: string | null = null;
  if (packBytes.length > 0) {
    try {
      const objects = readPack(packBytes, (oid) => repo.objects.get(oid));
      for (const [oid, object] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      unpackError = err instanceof Error ? err.message.replace(/\s+/g, ' ') : 'unpack failed';
    }
  }

  const reportLines: string[] = [`unpack ${unpackError === null ? 'ok' : unpackError}\n`];
  for (const command of commands) {
    const verdict = applyPushCommand(repo, command, unpackError === null);
    reportLines.push(verdict === 'ok' ? `ok ${command.ref}\n` : `ng ${command.ref} ${verdict}\n`);
  }

  const reportParts: Buffer[] = reportLines.map((line) => encodePktLine(line));
  reportParts.push(pktFlush());
  const report = Buffer.concat(reportParts);
  let responseBody = report;
  if (capabilities.has('side-band-64k')) {
    responseBody = Buffer.concat(sidebandPackets(report));
  }
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: responseBody };
}

/**
 * Validate and apply one push command. Answers 'ok' or the refusal reason (the exact string
 * "non-fast-forward" for a non-fast-forward update, as the protocol and the suite require).
 * When the pack failed to unpack, nothing is applied.
 */
function applyPushCommand(repo: Repo, command: PushCommandLine, unpackOk: boolean): string {
  if (!unpackOk) return 'unpacker error';
  const { oldOid, newOid, ref } = command;
  if (!ref.startsWith('refs/') || ref.includes('..') || ref.includes(' ')) return 'invalid ref name';
  const current = repo.refs.get(ref) ?? ZERO_OID;
  if (newOid === ZERO_OID) {
    // A delete: the ref must be where the command says it is.
    if (current === ZERO_OID) return 'reference does not exist';
    if (current !== oldOid) return 'stale info';
    repo.refs.delete(ref);
    return 'ok';
  }
  const object = repo.objects.get(newOid);
  if (!object) return 'missing object';
  if (oldOid === ZERO_OID) {
    if (current !== ZERO_OID) return 'reference already exists';
    repo.refs.set(ref, newOid);
    return 'ok';
  }
  if (current !== oldOid) return 'stale info';
  if (ref.startsWith('refs/heads/')) {
    const newCommit = peelToCommit(repo, newOid);
    const oldCommit = peelToCommit(repo, oldOid);
    if (newCommit !== null && oldCommit !== null && !isAncestor(repo, oldCommit, newCommit)) {
      return 'non-fast-forward';
    }
  }
  repo.refs.set(ref, newOid);
  return 'ok';
}
