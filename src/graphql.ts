// The GraphQL v4 surface: a small but real GraphQL implementation — lexer, parser and a
// schema-driven executor — covering the documents gh and github-mcp-server send: viewer and
// repository reads, issue and pull-request connections with cursor pagination, the create /
// close / merge mutations, Relay node ids, operation batching, and the __type introspection
// probes those clients feature-detect with. Unknown fields answer the way GitHub answers:
// HTTP 200 with an errors array naming the field.

import { VIEWER, userByLogin } from './identity.ts';
import {
  addCommentRecord,
  createIssueRecord,
  createPullRecord,
  decodeNodeId,
  isoOf,
  issueNodeId,
  mergePullRequest,
  nodeId,
  openPullFor,
  pullChangedFiles,
  pullMergeable,
  pullNodeId,
  store,
  type Issue,
  type IssueComment,
  type PullRequest,
  type Repo,
} from './store.ts';

// ---------------------------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'punct'; value: string }
  | { kind: 'spread' }
  | { kind: 'eof' };

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < source.length) {
    const c = source[i] as string;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '\ufeff') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'spread' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        const text = end < 0 ? source.slice(i + 3) : source.slice(i + 3, end);
        tokens.push({ kind: 'string', value: text });
        i = end < 0 ? source.length : end + 3;
        continue;
      }
      let j = i + 1;
      let text = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const escaped = source[j + 1] as string;
          if (escaped === 'n') text += '\n';
          else if (escaped === 't') text += '\t';
          else if (escaped === 'r') text += '\r';
          else if (escaped === 'u' && /^[0-9a-fA-F]{4}$/.test(source.slice(j + 2, j + 6))) {
            text += String.fromCharCode(Number.parseInt(source.slice(j + 2, j + 6), 16));
            j += 4;
          } else text += escaped;
          j += 2;
        } else {
          text += source[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: text });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      let isFloat = false;
      if (source[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      const text = source.slice(i, j);
      tokens.push(isFloat ? { kind: 'float', value: Number.parseFloat(text) } : { kind: 'int', value: Number.parseInt(text, 10) });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < source.length && isNameChar(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)} in the GraphQL document`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// ---------------------------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------------------------

export type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'enum'; value: string }
  | { kind: 'null' }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

export interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selectionSet: SelectionNode[] | null;
}

export type SelectionNode =
  | FieldNode
  | { kind: 'inline'; typeCondition: string | null; selectionSet: SelectionNode[] }
  | { kind: 'spread'; name: string };

export interface OperationNode {
  type: 'query' | 'mutation';
  name: string | null;
  selectionSet: SelectionNode[];
}

export interface FragmentNode {
  typeCondition: string;
  selectionSet: SelectionNode[];
}

export interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, FragmentNode>;
}

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    const token = this.tokens[this.pos] as Token;
    this.pos += 1;
    return token;
  }

  private atPunct(value: string): boolean {
    const token = this.peek();
    return token.kind === 'punct' && token.value === value;
  }

  private expectPunct(value: string): void {
    if (!this.atPunct(value)) throw new Error(`expected "${value}" in the GraphQL document`);
    this.pos += 1;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name in the GraphQL document');
    return token.value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.peek().kind !== 'eof') {
      if (this.atPunct('{')) {
        operations.push({ type: 'query', name: null, selectionSet: this.parseSelectionSet() });
        continue;
      }
      const keyword = this.expectName();
      if (keyword === 'query' || keyword === 'mutation') {
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.expectName();
        if (this.atPunct('(')) this.parseVariableDefinitions();
        this.skipDirectives();
        operations.push({ type: keyword, name, selectionSet: this.parseSelectionSet() });
      } else if (keyword === 'fragment') {
        const fragmentName = this.expectName();
        const on = this.expectName();
        if (on !== 'on') throw new Error('fragment definition is missing "on"');
        const typeCondition = this.expectName();
        this.skipDirectives();
        fragments.set(fragmentName, { typeCondition, selectionSet: this.parseSelectionSet() });
      } else {
        throw new Error(`unexpected definition "${keyword}"`);
      }
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): void {
    this.expectPunct('(');
    while (!this.atPunct(')')) {
      this.expectPunct('$');
      this.expectName();
      this.expectPunct(':');
      this.parseType();
      if (this.atPunct('=')) {
        this.next();
        this.parseValue();
      }
      this.skipDirectives();
    }
    this.expectPunct(')');
  }

  private parseType(): void {
    if (this.atPunct('[')) {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.atPunct('!')) this.next();
  }

  private skipDirectives(): void {
    while (this.atPunct('@')) {
      this.next();
      this.expectName();
      if (this.atPunct('(')) {
        this.next();
        while (!this.atPunct(')')) {
          this.expectName();
          this.expectPunct(':');
          this.parseValue();
        }
        this.expectPunct(')');
      }
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.atPunct('}')) selections.push(this.parseSelection());
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.peek().kind === 'spread') {
      this.next();
      if (this.peek().kind === 'name' && (this.peek() as { value: string }).value !== 'on') {
        return { kind: 'spread', name: this.expectName() };
      }
      let typeCondition: string | null = null;
      if (this.peek().kind === 'name') {
        this.expectName(); // 'on'
        typeCondition = this.expectName();
      }
      this.skipDirectives();
      return { kind: 'inline', typeCondition, selectionSet: this.parseSelectionSet() };
    }
    let name = this.expectName();
    let alias: string | null = null;
    if (this.atPunct(':')) {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (this.atPunct('(')) {
      this.next();
      while (!this.atPunct(')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    this.skipDirectives();
    const selectionSet = this.atPunct('{') ? this.parseSelectionSet() : null;
    return { kind: 'field', alias, name, args, selectionSet };
  }

  private parseValue(): ValueNode {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '$') {
      this.next();
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.kind === 'string') {
      this.next();
      return { kind: 'string', value: token.value };
    }
    if (token.kind === 'int') {
      this.next();
      return { kind: 'int', value: token.value };
    }
    if (token.kind === 'float') {
      this.next();
      return { kind: 'float', value: token.value };
    }
    if (token.kind === 'name') {
      this.next();
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      this.next();
      const values: ValueNode[] = [];
      while (!this.atPunct(']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      this.next();
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!this.atPunct('}')) {
        const fieldName = this.expectName();
        this.expectPunct(':');
        fields.push({ name: fieldName, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    throw new Error('unexpected value in the GraphQL document');
  }
}

export function parseGraphQL(source: string): DocumentNode {
  return new Parser(lex(source)).parseDocument();
}

// ---------------------------------------------------------------------------------------------
// The schema: field tables double as the introspection source and the validation table.
// ---------------------------------------------------------------------------------------------

interface FieldInfo {
  type: string;
  list?: boolean;
}

interface TypeInfo {
  kind: 'OBJECT' | 'ENUM';
  fields?: Record<string, FieldInfo>;
  values?: string[];
}

const SCALARS = new Set(['String', 'Int', 'Float', 'Boolean', 'ID']);

const SCHEMA: Record<string, TypeInfo> = {
  Query: {
    kind: 'OBJECT',
    fields: {
      viewer: { type: 'User' },
      repository: { type: 'Repository' },
      node: { type: 'Node' },
      __type: { type: '__Type' },
      __schema: { type: '__Schema' },
    },
  },
  Mutation: {
    kind: 'OBJECT',
    fields: {
      createIssue: { type: 'CreateIssuePayload' },
      closeIssue: { type: 'CloseIssuePayload' },
      createPullRequest: { type: 'CreatePullRequestPayload' },
      mergePullRequest: { type: 'MergePullRequestPayload' },
      addComment: { type: 'AddCommentPayload' },
    },
  },
  Node: { kind: 'OBJECT', fields: { id: { type: 'ID' } } },
  User: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID' },
      login: { type: 'String' },
      name: { type: 'String' },
      email: { type: 'String' },
      url: { type: 'String' },
    },
  },
  Repository: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID' },
      databaseId: { type: 'Int' },
      name: { type: 'String' },
      nameWithOwner: { type: 'String' },
      owner: { type: 'User' },
      description: { type: 'String' },
      isPrivate: { type: 'Boolean' },
      viewerPermission: { type: 'RepositoryPermission' },
      hasIssuesEnabled: { type: 'Boolean' },
      defaultBranchRef: { type: 'Ref' },
      issue: { type: 'Issue' },
      issues: { type: 'IssueConnection' },
      pullRequest: { type: 'PullRequest' },
      pullRequests: { type: 'PullRequestConnection' },
      url: { type: 'String' },
      createdAt: { type: 'String' },
      updatedAt: { type: 'String' },
    },
  },
  Ref: {
    kind: 'OBJECT',
    fields: {
      name: { type: 'String' },
      prefix: { type: 'String' },
    },
  },
  Issue: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID' },
      number: { type: 'Int' },
      title: { type: 'String' },
      state: { type: 'IssueState' },
      body: { type: 'String' },
      author: { type: 'User' },
      repository: { type: 'Repository' },
      url: { type: 'String' },
      createdAt: { type: 'String' },
      updatedAt: { type: 'String' },
    },
  },
  IssueConnection: {
    kind: 'OBJECT',
    fields: {
      nodes: { type: 'Issue', list: true },
      pageInfo: { type: 'PageInfo' },
      totalCount: { type: 'Int' },
    },
  },
  PageInfo: {
    kind: 'OBJECT',
    fields: {
      hasNextPage: { type: 'Boolean' },
      hasPreviousPage: { type: 'Boolean' },
      startCursor: { type: 'String' },
      endCursor: { type: 'String' },
    },
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID' },
      number: { type: 'Int' },
      title: { type: 'String' },
      body: { type: 'String' },
      state: { type: 'PullRequestState' },
      merged: { type: 'Boolean' },
      mergeable: { type: 'MergeableState' },
      headRefName: { type: 'String' },
      baseRefName: { type: 'String' },
      files: { type: 'PullRequestChangedFileConnection' },
      author: { type: 'User' },
      repository: { type: 'Repository' },
      url: { type: 'String' },
      createdAt: { type: 'String' },
      updatedAt: { type: 'String' },
    },
  },
  PullRequestConnection: {
    kind: 'OBJECT',
    fields: {
      nodes: { type: 'PullRequest', list: true },
      pageInfo: { type: 'PageInfo' },
      totalCount: { type: 'Int' },
    },
  },
  PullRequestChangedFileConnection: {
    kind: 'OBJECT',
    fields: {
      nodes: { type: 'PullRequestChangedFile', list: true },
      totalCount: { type: 'Int' },
    },
  },
  PullRequestChangedFile: {
    kind: 'OBJECT',
    fields: {
      path: { type: 'String' },
      additions: { type: 'Int' },
      deletions: { type: 'Int' },
    },
  },
  IssueComment: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID' },
      body: { type: 'String' },
      author: { type: 'User' },
      createdAt: { type: 'String' },
    },
  },
  CreateIssuePayload: { kind: 'OBJECT', fields: { issue: { type: 'Issue' }, clientMutationId: { type: 'String' } } },
  CloseIssuePayload: { kind: 'OBJECT', fields: { issue: { type: 'Issue' }, clientMutationId: { type: 'String' } } },
  CreatePullRequestPayload: { kind: 'OBJECT', fields: { pullRequest: { type: 'PullRequest' }, clientMutationId: { type: 'String' } } },
  MergePullRequestPayload: { kind: 'OBJECT', fields: { pullRequest: { type: 'PullRequest' }, clientMutationId: { type: 'String' } } },
  AddCommentPayload: { kind: 'OBJECT', fields: { commentEdge: { type: 'CommentEdge' }, clientMutationId: { type: 'String' } } },
  CommentEdge: { kind: 'OBJECT', fields: { node: { type: 'IssueComment' }, cursor: { type: 'String' } } },
  __Type: {
    kind: 'OBJECT',
    fields: {
      name: { type: 'String' },
      kind: { type: 'String' },
      description: { type: 'String' },
      fields: { type: '__Field', list: true },
      enumValues: { type: '__EnumValue', list: true },
      possibleTypes: { type: '__Type', list: true },
      inputFields: { type: '__InputValue', list: true },
      ofType: { type: '__Type' },
      interfaces: { type: '__Type', list: true },
    },
  },
  __Field: {
    kind: 'OBJECT',
    fields: {
      name: { type: 'String' },
      description: { type: 'String' },
      args: { type: '__InputValue', list: true },
      type: { type: '__Type' },
      isDeprecated: { type: 'Boolean' },
      deprecationReason: { type: 'String' },
    },
  },
  __EnumValue: {
    kind: 'OBJECT',
    fields: {
      name: { type: 'String' },
      description: { type: 'String' },
      isDeprecated: { type: 'Boolean' },
      deprecationReason: { type: 'String' },
    },
  },
  __InputValue: {
    kind: 'OBJECT',
    fields: {
      name: { type: 'String' },
      description: { type: 'String' },
      type: { type: '__Type' },
      defaultValue: { type: 'String' },
    },
  },
  __Schema: {
    kind: 'OBJECT',
    fields: {
      types: { type: '__Type', list: true },
      queryType: { type: '__Type' },
      mutationType: { type: '__Type' },
      directives: { type: '__Directive', list: true },
    },
  },
  __Directive: { kind: 'OBJECT', fields: { name: { type: 'String' }, description: { type: 'String' } } },
  IssueState: { kind: 'ENUM', values: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', values: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', values: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  PullRequestMergeMethod: { kind: 'ENUM', values: ['MERGE', 'SQUASH', 'REBASE'] },
  RepositoryPermission: { kind: 'ENUM', values: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  IssueOrderField: { kind: 'ENUM', values: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  OrderDirection: { kind: 'ENUM', values: ['ASC', 'DESC'] },
  SearchType: { kind: 'ENUM', values: ['ISSUE', 'REPOSITORY', 'USER'] },
};

// ---------------------------------------------------------------------------------------------
// Sources: the values resolvers walk. Each is a plain record tagged with its GraphQL type.
// ---------------------------------------------------------------------------------------------

type Source = Record<string, unknown> & { __type: string };

const userSource = (login: string): Source => {
  const user = userByLogin(login) ?? VIEWER;
  return { __type: 'User', login: user.login, id: nodeId('User', user.id), name: user.name, email: user.email, url: `https://gitforge.local/${user.login}` };
};
const repoSource = (repo: Repo): Source => ({ __type: 'Repository', repo });
const issueSource = (repo: Repo, issue: Issue): Source => ({ __type: 'Issue', repo, issue });
const pullSource = (repo: Repo, pull: PullRequest): Source => ({ __type: 'PullRequest', repo, pull });
const commentSource = (repo: Repo, issue: Issue, comment: IssueComment): Source => ({ __type: 'IssueComment', repo, issue, comment });
const typeSource = (name: string): Source => ({ __type: '__Type', name });

function repoByDbId(dbId: number): Repo | undefined {
  for (const repo of store.repos.values()) if (repo.dbId === dbId) return repo;
  return undefined;
}

/** Resolve a Relay node id to its source, or null when it names nothing the forge holds. */
function nodeSource(id: string): Source | null {
  const decoded = decodeNodeId(id);
  if (decoded === null) return null;
  if (decoded.kind === 'Repository') {
    const repo = repoByDbId(Number.parseInt(decoded.key, 10));
    return repo ? repoSource(repo) : null;
  }
  if (decoded.kind === 'Issue' || decoded.kind === 'PullRequest') {
    const [dbIdText, numberText] = decoded.key.split(':');
    const repo = repoByDbId(Number.parseInt(dbIdText ?? '', 10));
    if (!repo) return null;
    const number = Number.parseInt(numberText ?? '', 10);
    if (decoded.kind === 'Issue') {
      const issue = repo.issues.get(number);
      return issue ? issueSource(repo, issue) : null;
    }
    const pull = repo.pulls.get(number);
    return pull ? pullSource(repo, pull) : null;
  }
  if (decoded.kind === 'User') {
    const user = userByLogin(VIEWER.login);
    return user ? userSource(user.login) : null;
  }
  if (decoded.kind === 'IssueComment') {
    const globalId = Number.parseInt(decoded.key, 10);
    for (const repo of store.repos.values()) {
      for (const issue of repo.issues.values()) {
        const comment = issue.comments.find((candidate) => candidate.globalId === globalId);
        if (comment) return commentSource(repo, issue, comment);
      }
    }
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Connections and cursors
// ---------------------------------------------------------------------------------------------

function encodeCursor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: string): number {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number.parseInt(match[1] as string, 10) : -1;
  } catch {
    return -1;
  }
}

interface ConnectionResult {
  nodes: Source[];
  pageInfo: Source;
  totalCount: number;
}

/** Slice one page out of an ordered list, Relay style (first/after). */
function pageOf(items: Source[], args: Record<string, unknown>): ConnectionResult {
  const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : items.length;
  let start = 0;
  if (typeof args.after === 'string') start = decodeCursor(args.after) + 1;
  const nodes = items.slice(start, start + first);
  const endIndex = start + nodes.length - 1;
  const pageInfo: Source = {
    __type: 'PageInfo',
    hasNextPage: endIndex < items.length - 1,
    hasPreviousPage: start > 0,
    startCursor: nodes.length > 0 ? encodeCursor(start) : null,
    endCursor: nodes.length > 0 ? encodeCursor(endIndex) : null,
  };
  return { nodes, pageInfo, totalCount: items.length };
}

function issuesConnection(repo: Repo, args: Record<string, unknown>): Source {
  let issues = [...repo.issues.values()];
  const states = Array.isArray(args.states) ? (args.states as unknown[]).map((state) => String(state)) : null;
  if (states !== null && states.length > 0) {
    issues = issues.filter((issue) => states.includes(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
  }
  const orderBy = (args.orderBy ?? null) as { field?: string; direction?: string } | null;
  const descending = orderBy?.direction === 'DESC';
  issues.sort((a, b) => (descending ? b.number - a.number : a.number - b.number));
  const page = pageOf(issues.map((issue) => issueSource(repo, issue)), args);
  return { __type: 'IssueConnection', ...page };
}

function pullsConnection(repo: Repo, args: Record<string, unknown>): Source {
  let pulls = [...repo.pulls.values()];
  const states = Array.isArray(args.states) ? (args.states as unknown[]).map((state) => String(state)) : ['OPEN'];
  pulls = pulls.filter((pull) => {
    const state = pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
    return states.includes(state);
  });
  pulls.sort((a, b) => a.number - b.number);
  const page = pageOf(pulls.map((pull) => pullSource(repo, pull)), args);
  return { __type: 'PullRequestConnection', ...page };
}

// ---------------------------------------------------------------------------------------------
// Field resolvers
// ---------------------------------------------------------------------------------------------

interface ExecContext {
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentNode>;
  errors: Array<{ message: string }>;
}

function repoOf(source: Source): Repo {
  return source.repo as Repo;
}

function resolveField(source: Source, field: string, args: Record<string, unknown>, ctx: ExecContext): unknown {
  switch (source.__type) {
    case 'Query':
      return resolveQuery(field, args, ctx);
    case 'Mutation':
      return resolveMutation(field, args, ctx);
    case 'User':
      return source[field] ?? null;
    case 'Repository':
      return resolveRepository(source, field, args);
    case 'Issue': {
      const repo = repoOf(source);
      const issue = source.issue as Issue;
      switch (field) {
        case 'id': return issueNodeId(repo.dbId, issue.number);
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'state': return issue.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'body': return issue.body;
        case 'author': return userSource(issue.authorLogin);
        case 'repository': return repoSource(repo);
        case 'url': return `https://gitforge.local/${repo.owner}/${repo.name}/issues/${issue.number}`;
        case 'createdAt': return isoOf(issue.createdTick);
        case 'updatedAt': return isoOf(issue.createdTick);
        default: return null;
      }
    }
    case 'PullRequest': {
      const repo = repoOf(source);
      const pull = source.pull as PullRequest;
      switch (field) {
        case 'id': return pullNodeId(repo.dbId, pull.number);
        case 'number': return pull.number;
        case 'title': return pull.title;
        case 'body': return pull.body;
        case 'state': return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'merged': return pull.merged;
        case 'mergeable': return pull.merged ? 'UNKNOWN' : pullMergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
        case 'headRefName': return pull.headRef;
        case 'baseRefName': return pull.baseRef;
        case 'files': {
          const files = pullChangedFiles(repo, pull).map((file) => ({
            __type: 'PullRequestChangedFile',
            path: file.filename,
            additions: file.additions,
            deletions: file.deletions,
          }));
          const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : files.length;
          return { __type: 'PullRequestChangedFileConnection', nodes: files.slice(0, first), totalCount: files.length };
        }
        case 'author': return userSource(pull.authorLogin);
        case 'repository': return repoSource(repo);
        case 'url': return `https://gitforge.local/${repo.owner}/${repo.name}/pull/${pull.number}`;
        case 'createdAt': return isoOf(pull.createdTick);
        case 'updatedAt': return isoOf(pull.createdTick);
        default: return null;
      }
    }
    case 'IssueComment': {
      const comment = source.comment as IssueComment;
      switch (field) {
        case 'id': return nodeId('IssueComment', comment.globalId);
        case 'body': return comment.body;
        case 'author': return userSource(comment.authorLogin);
        case 'createdAt': return isoOf(comment.createdTick);
        default: return null;
      }
    }
    case 'Ref':
      return field === 'name' ? source.name : field === 'prefix' ? 'refs/heads/' : null;
    case 'IssueConnection':
    case 'PullRequestConnection':
      if (field === 'nodes') return source.nodes;
      if (field === 'pageInfo') return source.pageInfo;
      if (field === 'totalCount') return source.totalCount;
      return null;
    case 'PullRequestChangedFileConnection':
      if (field === 'nodes') return source.nodes;
      if (field === 'totalCount') return source.totalCount;
      return null;
    case 'PullRequestChangedFile':
      return source[field] ?? null;
    case 'PageInfo':
      return source[field] ?? null;
    case 'CreateIssuePayload':
    case 'CloseIssuePayload':
      return field === 'issue' ? source.issue ?? null : null;
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload':
      return field === 'pullRequest' ? source.pull ?? null : null;
    case 'AddCommentPayload':
      return field === 'commentEdge' ? source.commentEdge ?? null : null;
    case 'CommentEdge':
      if (field === 'node') return source.node ?? null;
      return null;
    case '__Type':
      return resolveTypeField(source, field);
    case '__Field':
      return field === 'name' ? source.name : field === 'args' ? [] : field === 'isDeprecated' ? false : null;
    case '__EnumValue':
      return field === 'name' ? source.name : field === 'isDeprecated' ? false : null;
    case '__Schema':
      if (field === 'types') return Object.keys(SCHEMA).map((name) => typeSource(name));
      if (field === 'queryType') return typeSource('Query');
      if (field === 'mutationType') return typeSource('Mutation');
      if (field === 'directives') return [];
      return null;
    default:
      return null;
  }
}

function resolveTypeField(source: Source, field: string): unknown {
  const name = source.name as string;
  const info = SCHEMA[name];
  switch (field) {
    case 'name': return name;
    case 'kind': return info ? (info.kind === 'ENUM' ? 'ENUM' : 'OBJECT') : 'OBJECT';
    case 'fields': {
      if (!info || info.kind !== 'OBJECT' || !info.fields) return null;
      return Object.keys(info.fields).map((fieldName) => ({ __type: '__Field', name: fieldName }));
    }
    case 'enumValues': {
      if (!info || info.kind !== 'ENUM' || !info.values) return null;
      return info.values.map((value) => ({ __type: '__EnumValue', name: value }));
    }
    case 'interfaces': return [];
    default: return null;
  }
}

function resolveRepository(source: Source, field: string, args: Record<string, unknown>): unknown {
  const repo = repoOf(source);
  switch (field) {
    case 'id': return nodeId('Repository', repo.dbId);
    case 'databaseId': return repo.dbId;
    case 'name': return repo.name;
    case 'nameWithOwner': return `${repo.owner}/${repo.name}`;
    case 'owner': return userSource(repo.owner);
    case 'description': return repo.description;
    case 'isPrivate': return repo.isPrivate;
    case 'viewerPermission': return repo.owner === VIEWER.login ? 'ADMIN' : 'READ';
    case 'hasIssuesEnabled': return true;
    case 'defaultBranchRef': {
      const ref = `refs/heads/${repo.defaultBranch}`;
      return repo.refs.has(ref) ? { __type: 'Ref', name: repo.defaultBranch } : null;
    }
    case 'issue': {
      const number = typeof args.number === 'number' ? args.number : Number.NaN;
      const issue = repo.issues.get(number);
      return issue ? issueSource(repo, issue) : null;
    }
    case 'issues': return issuesConnection(repo, args);
    case 'pullRequest': {
      const number = typeof args.number === 'number' ? args.number : Number.NaN;
      const pull = repo.pulls.get(number);
      return pull ? pullSource(repo, pull) : null;
    }
    case 'pullRequests': return pullsConnection(repo, args);
    case 'url': return `https://gitforge.local/${repo.owner}/${repo.name}`;
    case 'createdAt': return isoOf(repo.createdTick);
    case 'updatedAt': return isoOf(repo.createdTick);
    default: return null;
  }
}

function resolveQuery(field: string, args: Record<string, unknown>, ctx: ExecContext): unknown {
  void ctx;
  switch (field) {
    case 'viewer': return userSource(VIEWER.login);
    case 'repository': {
      const owner = typeof args.owner === 'string' ? args.owner : '';
      const name = typeof args.name === 'string' ? args.name : '';
      const repo = store.repo(owner, name);
      return repo ? repoSource(repo) : null;
    }
    case 'node': {
      const id = typeof args.id === 'string' ? args.id : '';
      return nodeSource(id);
    }
    case '__type': {
      const name = typeof args.name === 'string' ? args.name : '';
      return SCHEMA[name] !== undefined ? typeSource(name) : null;
    }
    case '__schema': return { __type: '__Schema' };
    default: return null;
  }
}

function repoFromNodeId(id: unknown, ctx: ExecContext): Repo | null {
  if (typeof id !== 'string') {
    ctx.errors.push({ message: 'A repository id is required.' });
    return null;
  }
  const decoded = decodeNodeId(id);
  const repo = decoded?.kind === 'Repository' ? repoByDbId(Number.parseInt(decoded.key, 10)) : undefined;
  if (!repo) {
    ctx.errors.push({ message: 'Could not resolve the repository.' });
    return null;
  }
  return repo;
}

function resolveMutation(field: string, args: Record<string, unknown>, ctx: ExecContext): unknown {
  const input = (args.input ?? {}) as Record<string, unknown>;
  switch (field) {
    case 'createIssue': {
      const repo = repoFromNodeId(input.repositoryId, ctx);
      if (!repo) return null;
      const issue = createIssueRecord(store, repo, {
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
        authorLogin: VIEWER.login,
      });
      return { __type: 'CreateIssuePayload', issue: issueSource(repo, issue) };
    }
    case 'closeIssue': {
      const target = typeof input.issueId === 'string' ? nodeSource(input.issueId) : null;
      if (!target || target.__type !== 'Issue') {
        ctx.errors.push({ message: 'Could not resolve the issue.' });
        return null;
      }
      const issue = target.issue as Issue;
      issue.state = 'closed';
      return { __type: 'CloseIssuePayload', issue: target };
    }
    case 'createPullRequest': {
      const repo = repoFromNodeId(input.repositoryId, ctx);
      if (!repo) return null;
      const head = typeof input.headRefName === 'string' ? input.headRefName : '';
      const base = typeof input.baseRefName === 'string' ? input.baseRefName : '';
      if (repo.refs.get(`refs/heads/${head}`) === undefined || repo.refs.get(`refs/heads/${base}`) === undefined) {
        ctx.errors.push({ message: 'The head or base branch does not exist.' });
        return null;
      }
      if (openPullFor(repo, head, base) !== undefined) {
        ctx.errors.push({ message: 'A pull request already exists for this head and base.' });
        return null;
      }
      const pull = createPullRecord(store, repo, {
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
        headRef: head,
        baseRef: base,
        authorLogin: VIEWER.login,
      });
      return { __type: 'CreatePullRequestPayload', pull: pullSource(repo, pull) };
    }
    case 'mergePullRequest': {
      const target = typeof input.pullRequestId === 'string' ? nodeSource(input.pullRequestId) : null;
      if (!target || target.__type !== 'PullRequest') {
        ctx.errors.push({ message: 'Could not resolve the pull request.' });
        return null;
      }
      const repo = target.repo as Repo;
      const pull = target.pull as PullRequest;
      const method = typeof input.mergeMethod === 'string' ? input.mergeMethod : 'SQUASH';
      const result = mergePullRequest(repo, pull, method === 'MERGE' ? 'merge' : 'squash', store.nextTick());
      if (!result.ok) {
        ctx.errors.push({ message: 'Pull request is not mergeable.' });
        return null;
      }
      return { __type: 'MergePullRequestPayload', pull: target };
    }
    case 'addComment': {
      const target = typeof input.subjectId === 'string' ? nodeSource(input.subjectId) : null;
      if (!target || target.__type !== 'Issue') {
        ctx.errors.push({ message: 'Could not resolve the comment subject.' });
        return null;
      }
      const repo = target.repo as Repo;
      const issue = target.issue as Issue;
      const comment = addCommentRecord(store, issue, typeof input.body === 'string' ? input.body : '', VIEWER.login);
      return {
        __type: 'AddCommentPayload',
        commentEdge: { __type: 'CommentEdge', node: commentSource(repo, issue, comment) },
      };
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------------------------
// The executor
// ---------------------------------------------------------------------------------------------

function evalValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable': return variables[node.name];
    case 'string': return node.value;
    case 'int': return node.value;
    case 'float': return node.value;
    case 'boolean': return node.value;
    case 'enum': return node.value;
    case 'null': return null;
    case 'list': return node.values.map((value) => evalValue(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = evalValue(field.value, variables);
      return out;
    }
  }
}

function evalArgs(fieldNode: FieldNode, ctx: ExecContext): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const arg of fieldNode.args) {
    const value = evalValue(arg.value, ctx.variables);
    if (value !== undefined) args[arg.name] = value;
  }
  return args;
}

function completeValue(info: FieldInfo, raw: unknown, selectionSet: SelectionNode[] | null, ctx: ExecContext): unknown {
  if (raw === null || raw === undefined) return null;
  if (info.list) {
    const items = Array.isArray(raw) ? raw : [raw];
    return items.map((item) => completeValue({ type: info.type }, item, selectionSet, ctx));
  }
  if (SCALARS.has(info.type) || SCHEMA[info.type]?.kind === 'ENUM') return raw;
  const source = raw as Source;
  return executeSelectionSet(info.type, source, selectionSet ?? [], ctx);
}

function executeSelectionSet(declaredType: string, source: Source, selections: SelectionNode[], ctx: ExecContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const concreteType = source.__type;
  for (const selection of selections) {
    if (selection.kind === 'inline' || selection.kind === 'spread') {
      const fragment = selection.kind === 'inline'
        ? { typeCondition: selection.typeCondition, selectionSet: selection.selectionSet }
        : ctx.fragments.get(selection.name);
      if (!fragment) continue;
      const condition = fragment.typeCondition;
      if (condition !== null && condition !== concreteType && condition !== declaredType) continue;
      Object.assign(out, executeSelectionSet(declaredType, source, fragment.selectionSet, ctx));
      continue;
    }
    const key = selection.alias ?? selection.name;
    if (selection.name === '__typename') {
      out[key] = concreteType;
      continue;
    }
    const fieldInfo = SCHEMA[concreteType]?.fields?.[selection.name] ?? SCHEMA[declaredType]?.fields?.[selection.name];
    if (fieldInfo === undefined) {
      ctx.errors.push({ message: `Field '${selection.name}' doesn't exist on type '${concreteType}'` });
      out[key] = null;
      continue;
    }
    const raw = resolveField(source, selection.name, evalArgs(selection, ctx), ctx);
    out[key] = completeValue(fieldInfo, raw, selection.selectionSet, ctx);
  }
  return out;
}

function executeOperation(document: DocumentNode, operation: OperationNode, variables: Record<string, unknown>): Record<string, unknown> {
  const ctx: ExecContext = { variables, fragments: document.fragments, errors: [] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const root: Source = { __type: rootType };
  const data = executeSelectionSet(rootType, root, operation.selectionSet, ctx);
  const response: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) response.errors = ctx.errors;
  return response;
}

// ---------------------------------------------------------------------------------------------
// The HTTP handler
// ---------------------------------------------------------------------------------------------

export interface GraphQLReply {
  status: number;
  body: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function executeOne(body: Record<string, unknown>): Record<string, unknown> {
  const query = typeof body.query === 'string' ? body.query : '';
  if (query === '') return { errors: [{ message: 'A query is required.' }] };
  let variables: Record<string, unknown> = {};
  if (isRecord(body.variables)) variables = body.variables;
  else if (typeof body.variables === 'string') {
    try {
      const parsed: unknown = JSON.parse(body.variables);
      if (isRecord(parsed)) variables = parsed;
    } catch {
      // Variables that do not parse are treated as absent; the document decides the outcome.
    }
  }
  let document: DocumentNode;
  try {
    document = parseGraphQL(query);
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : 'Could not parse the document.' }] };
  }
  if (document.operations.length === 0) return { errors: [{ message: 'The document holds no operation.' }] };
  const operationName = typeof body.operationName === 'string' ? body.operationName : null;
  const operation = document.operations.find((candidate) => candidate.name === operationName) ?? document.operations[0] as OperationNode;
  try {
    return executeOperation(document, operation, variables);
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'Execution failed.' }] };
  }
}

/**
 * POST /api/graphql: one operation document, or a JSON array of them (operation batching,
 * answered with an array of results in order). Executed documents answer 200, with an
 * `errors` array when a field or a mutation could not be resolved.
 */
export function handleGraphQL(body: unknown): GraphQLReply {
  if (Array.isArray(body)) {
    const results = body.map((entry) => (isRecord(entry) ? executeOne(entry) : { errors: [{ message: 'Invalid operation.' }] }));
    return { status: 200, body: results };
  }
  if (!isRecord(body)) return { status: 200, body: { errors: [{ message: 'Invalid request body.' }] } };
  return { status: 200, body: executeOne(body) };
}
