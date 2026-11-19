// GraphQL v4: a small hand-rolled executor for the documents gh and
// github-mcp-server send. It parses one operation (or a batch of them), resolves
// it against the same Store the REST surface uses, and answers {data} or
// {data, errors}. Unknown fields are GraphQL errors on a 200, never an HTTP 400.

import { jsonResult, type HttpRequest, type HttpResult } from './http.ts';
import {
  commentGlobalId,
  decodeGlobalId,
  issueGlobalId,
  pullFiles,
  pullGlobalId,
  pullMergeable,
  refreshPull,
  repoGlobalId,
  squashMerge,
  VIEWER_LOGIN,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

// --------------------------------------------------------------------------------------------
// tokenizer and parser (the subset the suite's documents use)
// --------------------------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'spread' };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let value = '';
      i += 1;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\' && i + 1 < source.length) {
          const esc = source[i + 1] as string;
          if (esc === 'n') value += '\n';
          else if (esc === 't') value += '\t';
          else if (esc === 'r') value += '\r';
          else value += esc;
          i += 2;
        } else {
          value += source[i] as string;
          i += 1;
        }
      }
      i += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      let isFloat = false;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
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
      tokens.push(isFloat ? { kind: 'float', value: source.slice(i, j) } : { kind: 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`Unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

export type GqlValue =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: GqlValue[] }
  | { kind: 'object'; fields: Record<string, GqlValue> };

export interface GqlField {
  kind: 'field';
  name: string;
  alias: string | null;
  args: Record<string, GqlValue>;
  selections: GqlSelection[];
}

export interface GqlFragment {
  kind: 'fragment';
  typeCondition: string | null;
  selections: GqlSelection[];
}

export type GqlSelection = GqlField | GqlFragment;

export interface GqlOperation {
  type: 'query' | 'mutation';
  name: string | null;
  variables: Record<string, GqlValue | undefined>;
  selections: GqlSelection[];
}

class Parser {
  tokens: Token[];
  pos = 0;
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }
  peek(): Token | undefined {
    return this.tokens[this.pos];
  }
  next(): Token {
    const token = this.tokens[this.pos];
    if (!token) throw new Error('Unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }
  expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`Expected ${value} in GraphQL document`);
  }
  acceptPunct(value: string): boolean {
    const token = this.peek();
    if (token && token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }
  expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('Expected a name in GraphQL document');
    return token.value;
  }

  parseDocument(): GqlOperation[] {
    const operations: GqlOperation[] = [];
    while (this.pos < this.tokens.length) {
      operations.push(this.parseOperation());
    }
    return operations;
  }

  parseOperation(): GqlOperation {
    let type: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const token = this.peek();
    if (token && token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
      this.next();
      type = token.value as 'query' | 'mutation';
      const nextToken = this.peek();
      if (nextToken && nextToken.kind === 'name') name = this.next().value as string;
    }
    const variables: Record<string, GqlValue | undefined> = {};
    if (this.acceptPunct('(')) {
      while (!this.acceptPunct(')')) {
        this.expectPunct('$');
        const varName = this.expectName();
        this.expectPunct(':');
        this.parseType();
        if (this.acceptPunct('=')) variables[varName] = this.parseValue();
        else variables[varName] = undefined;
      }
    }
    // Directives on the operation (none in the suite's documents): skip @name(args).
    while (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '@') {
      this.next();
      this.expectName();
      if (this.acceptPunct('(')) {
        let depth = 1;
        while (depth > 0) {
          const t = this.next();
          if (t.kind === 'punct' && t.value === '(') depth += 1;
          if (t.kind === 'punct' && t.value === ')') depth -= 1;
        }
      }
    }
    const selections = this.parseSelectionSet();
    return { type, name, variables, selections };
  }

  parseType(): void {
    if (this.acceptPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.acceptPunct('!');
  }

  parseSelectionSet(): GqlSelection[] {
    this.expectPunct('{');
    const selections: GqlSelection[] = [];
    while (!this.acceptPunct('}')) {
      selections.push(this.parseSelection());
    }
    return selections;
  }

  parseSelection(): GqlSelection {
    const token = this.peek();
    if (token && token.kind === 'spread') {
      this.next();
      const nextToken = this.peek();
      if (nextToken && nextToken.kind === 'name' && nextToken.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        return { kind: 'fragment', typeCondition, selections: this.parseSelectionSet() };
      }
      // A named fragment spread: the suite never sends one; treat it as an empty fragment.
      if (nextToken && nextToken.kind === 'name') this.next();
      return { kind: 'fragment', typeCondition: null, selections: [] };
    }
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.acceptPunct(':')) {
      alias = first;
      name = this.expectName();
    }
    const args: Record<string, GqlValue> = {};
    if (this.acceptPunct('(')) {
      while (!this.acceptPunct(')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args[argName] = this.parseValue();
      }
    }
    while (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '@') {
      this.next();
      this.expectName();
      if (this.acceptPunct('(')) {
        let depth = 1;
        while (depth > 0) {
          const t = this.next();
          if (t.kind === 'punct' && t.value === '(') depth += 1;
          if (t.kind === 'punct' && t.value === ')') depth -= 1;
        }
      }
    }
    let selections: GqlSelection[] = [];
    const nextToken = this.peek();
    if (nextToken && nextToken.kind === 'punct' && nextToken.value === '{') {
      selections = this.parseSelectionSet();
    }
    return { kind: 'field', name, alias, args, selections };
  }

  parseValue(): GqlValue {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const items: GqlValue[] = [];
      while (!(this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === ']')) {
        items.push(this.parseValue());
      }
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Record<string, GqlValue> = {};
      while (!(this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '}')) {
        const fieldName = this.expectName();
        this.expectPunct(':');
        fields[fieldName] = this.parseValue();
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    throw new Error(`Unexpected token in GraphQL value: ${JSON.stringify(token)}`);
  }
}

// --------------------------------------------------------------------------------------------
// execution
// --------------------------------------------------------------------------------------------

type Variables = Record<string, unknown>;

function resolveValue(value: GqlValue, variables: Variables): unknown {
  switch (value.kind) {
    case 'variable':
      return variables[value.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'list':
      return value.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, field] of Object.entries(value.fields)) out[key] = resolveValue(field, variables);
      return out;
    }
  }
}

function resolveArgs(args: Record<string, GqlValue>, variables: Variables): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) out[key] = resolveValue(value, variables);
  return out;
}

interface GqlContext {
  store: Store;
  errors: Array<{ message: string }>;
}

interface NodeValue {
  __typename: string;
  [key: string]: unknown;
}

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'closedAt'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'createdAt', 'updatedAt', 'author'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private', 'url', 'createdAt'],
  User: ['id', 'login', 'name', 'email'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  IssueComment: ['id', 'body', 'author', 'createdAt'],
  IssueCommentEdge: ['node', 'cursor'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues'],
  __Field: ['name', 'description', 'args', 'type'],
  __EnumValue: ['name', 'description'],
  __Schema: ['queryType', 'mutationType', 'types'],
  __InputValue: ['name', 'description', 'type', 'defaultValue'],
};

const TYPE_ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'CODE', 'COMMIT', 'DISCUSSION', 'MILESTONE', 'PROJECT', 'TOPIC'],
  IssueState: ['OPEN', 'CLOSED'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
};

function typeNode(name: string): NodeValue {
  return { __typename: '__Type', __typeName: name };
}

function encodeCursor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

function issueNode(store: Store, repo: Repo, issue: Issue): NodeValue {
  void store;
  return {
    __typename: 'Issue',
    __repo: repo,
    __issue: issue,
    id: issueGlobalId(repo, issue.number),
    number: issue.number,
    title: issue.title,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    body: issue.body,
  };
}

function pullNode(store: Store, repo: Repo, pull: Pull): NodeValue {
  void store;
  return {
    __typename: 'PullRequest',
    __repo: repo,
    __pull: pull,
    id: pullGlobalId(repo, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED',
    merged: pull.merged,
    mergeable: pullMergeable(repo, pull),
    headRefName: pull.head,
    baseRefName: pull.base,
  };
}

function repoNode(store: Store, repo: Repo): NodeValue {
  void store;
  return {
    __typename: 'Repository',
    __repo: repo,
    id: repoGlobalId(repo),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: { __typename: 'User', login: repo.owner },
    defaultBranchRef: { __typename: 'Ref', name: repo.defaultBranch },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    description: repo.description,
    private: repo.isPrivate,
  };
}

function findRepoById(store: Store, id: string): Repo | null {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.kind !== 'Repository') return null;
  for (const repo of store.repos.values()) if (repo.id === decoded.repoId) return repo;
  return null;
}

function findIssueById(store: Store, id: string): { repo: Repo; issue: Issue } | null {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.kind !== 'Issue') return null;
  for (const repo of store.repos.values()) {
    if (repo.id !== decoded.repoId) continue;
    const issue = repo.issues.find((entry) => entry.number === decoded.number);
    if (issue) return { repo, issue };
  }
  return null;
}

function findPullById(store: Store, id: string): { repo: Repo; pull: Pull } | null {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.kind !== 'PullRequest') return null;
  for (const repo of store.repos.values()) {
    if (repo.id !== decoded.repoId) continue;
    const pull = repo.pulls.find((entry) => entry.number === decoded.number);
    if (pull) return { repo, pull };
  }
  return null;
}

function issuesConnection(ctx: GqlContext, repo: Repo, args: Record<string, unknown>): NodeValue {
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
  const field = typeof orderBy.field === 'string' ? orderBy.field : 'CREATED_AT';
  const direction = typeof orderBy.direction === 'string' ? orderBy.direction : 'ASC';
  let issues = [...repo.issues];
  if (states) {
    const wanted = new Set(states.map((state) => (state === 'OPEN' ? 'open' : state === 'CLOSED' ? 'closed' : state)));
    issues = issues.filter((issue) => wanted.has(issue.state));
  }
  const descending = direction === 'DESC';
  if (field === 'CREATED_AT' || field === 'UPDATED_AT') {
    issues.sort((a, b) => (descending ? b.seq - a.seq : a.seq - b.seq));
  } else if (field === 'COMMENTS') {
    issues.sort((a, b) => (descending ? b.comments.length - a.comments.length : a.comments.length - b.comments.length));
  }
  const first = typeof args.first === 'number' ? args.first : issues.length;
  const afterIndex = decodeCursor(args.after);
  const start = afterIndex === null ? 0 : afterIndex + 1;
  const slice = issues.slice(start, start + Math.max(0, first));
  const nodes = slice.map((issue) => issueNode(ctx.store, repo, issue));
  const endIndex = slice.length > 0 ? start + slice.length - 1 : -1;
  return {
    __typename: 'IssueConnection',
    nodes,
    edges: nodes.map((node, index) => ({ __typename: 'IssueEdge', node, cursor: encodeCursor(start + index) })),
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: start + slice.length < issues.length,
      hasPreviousPage: start > 0,
      startCursor: slice.length > 0 ? encodeCursor(start) : null,
      endCursor: endIndex >= 0 ? encodeCursor(endIndex) : null,
    },
    totalCount: issues.length,
  };
}

function pullsConnection(ctx: GqlContext, repo: Repo, args: Record<string, unknown>): NodeValue {
  const first = typeof args.first === 'number' ? args.first : 100;
  const open = repo.pulls.filter((pull) => pull.state === 'open').sort((a, b) => b.seq - a.seq);
  const slice = open.slice(0, Math.max(0, first));
  const nodes = slice.map((pull) => pullNode(ctx.store, repo, pull));
  return {
    __typename: 'PullRequestConnection',
    nodes,
    edges: nodes.map((node, index) => ({ __typename: 'PullRequestEdge', node, cursor: encodeCursor(index) })),
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: slice.length < open.length,
      hasPreviousPage: false,
      startCursor: slice.length > 0 ? encodeCursor(0) : null,
      endCursor: slice.length > 0 ? encodeCursor(slice.length - 1) : null,
    },
    totalCount: open.length,
  };
}

function resolveField(
  ctx: GqlContext,
  parentType: string,
  parent: NodeValue | null,
  field: GqlField,
  variables: Variables,
): unknown {
  const args = resolveArgs(field.args, variables);
  const known = TYPE_FIELDS[parentType];
  if (known && !known.includes(field.name)) {
    ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${parentType}".` });
    return undefined;
  }

  if (parentType === 'Query') {
    if (field.name === 'viewer') {
      return { __typename: 'User', login: VIEWER_LOGIN, id: 1000, name: VIEWER_LOGIN, email: `${VIEWER_LOGIN}@example.invalid` };
    }
    if (field.name === 'repository') {
      const owner = args.owner as string;
      const name = args.name as string;
      if (owner !== VIEWER_LOGIN) return null;
      const repo = ctx.store.getRepo(owner, name);
      return repo ? repoNode(ctx.store, repo) : null;
    }
    if (field.name === 'node') {
      const id = args.id as string;
      if (typeof id !== 'string') return null;
      const decoded = decodeGlobalId(id);
      if (!decoded) return null;
      if (decoded.kind === 'Repository') {
        const repo = findRepoById(ctx.store, id);
        return repo ? repoNode(ctx.store, repo) : null;
      }
      if (decoded.kind === 'Issue') {
        const found = findIssueById(ctx.store, id);
        return found ? issueNode(ctx.store, found.repo, found.issue) : null;
      }
      if (decoded.kind === 'PullRequest') {
        const found = findPullById(ctx.store, id);
        return found ? pullNode(ctx.store, found.repo, found.pull) : null;
      }
      return null;
    }
    if (field.name === '__type') {
      const name = args.name as string;
      if (typeof name !== 'string') return null;
      if (TYPE_FIELDS[name] || TYPE_ENUM_VALUES[name]) return typeNode(name);
      return null;
    }
    if (field.name === '__schema') {
      return { __typename: '__Schema', queryType: typeNode('Query'), mutationType: typeNode('Mutation'), types: [] };
    }
    ctx.errors.push({ message: `Cannot query field "${field.name}" on type "Query".` });
    return undefined;
  }

  if (parentType === 'Mutation') {
    if (field.name === 'createIssue') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = typeof input.repositoryId === 'string' ? findRepoById(ctx.store, input.repositoryId) : null;
      if (!repo) {
        ctx.errors.push({ message: 'Could not resolve to a Repository with the id provided.' });
        return null;
      }
      const title = typeof input.title === 'string' ? input.title : '';
      const body = typeof input.body === 'string' ? input.body : '';
      const issue: Issue = { number: repo.nextIssue, title, body, state: 'open', labels: [], comments: [], seq: repo.nextIssue };
      repo.nextIssue += 1;
      repo.issues.push(issue);
      return { __typename: 'CreateIssuePayload', issue: issueNode(ctx.store, repo, issue) };
    }
    if (field.name === 'closeIssue') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = typeof input.issueId === 'string' ? findIssueById(ctx.store, input.issueId) : null;
      if (!found) {
        ctx.errors.push({ message: 'Could not resolve to an Issue with the id provided.' });
        return null;
      }
      found.issue.state = 'closed';
      return { __typename: 'CloseIssuePayload', issue: issueNode(ctx.store, found.repo, found.issue) };
    }
    if (field.name === 'createPullRequest') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = typeof input.repositoryId === 'string' ? findRepoById(ctx.store, input.repositoryId) : null;
      if (!repo) {
        ctx.errors.push({ message: 'Could not resolve to a Repository with the id provided.' });
        return null;
      }
      const head = typeof input.headRefName === 'string' ? input.headRefName : '';
      const base = typeof input.baseRefName === 'string' ? input.baseRefName : repo.defaultBranch;
      const title = typeof input.title === 'string' ? input.title : '';
      const body = typeof input.body === 'string' ? input.body : '';
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (!headSha || !baseSha) {
        ctx.errors.push({ message: 'Could not resolve the head or base ref.' });
        return null;
      }
      const pull: Pull = {
        number: repo.nextPull, title, body, state: 'open', head, base, headSha, baseSha,
        merged: false, mergedAt: null, mergeCommitSha: null, seq: repo.nextPull,
      };
      repo.nextPull += 1;
      repo.pulls.push(pull);
      return { __typename: 'CreatePullRequestPayload', pullRequest: pullNode(ctx.store, repo, pull) };
    }
    if (field.name === 'mergePullRequest') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = typeof input.pullRequestId === 'string' ? findPullById(ctx.store, input.pullRequestId) : null;
      if (!found) {
        ctx.errors.push({ message: 'Could not resolve to a PullRequest with the id provided.' });
        return null;
      }
      refreshPull(found.repo, found.pull);
      const result = squashMerge(ctx.store, found.repo, found.pull);
      if (!result.ok) {
        ctx.errors.push({ message: result.message });
        return null;
      }
      return { __typename: 'MergePullRequestPayload', pullRequest: pullNode(ctx.store, found.repo, found.pull) };
    }
    if (field.name === 'addComment') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = typeof input.subjectId === 'string' ? findIssueById(ctx.store, input.subjectId) : null;
      if (!found) {
        ctx.errors.push({ message: 'Could not resolve to an Issue with the id provided.' });
        return null;
      }
      const body = typeof input.body === 'string' ? input.body : '';
      const comment = { id: found.repo.nextComment, body, seq: found.repo.nextComment };
      found.repo.nextComment += 1;
      found.issue.comments.push(comment);
      return {
        __typename: 'AddCommentPayload',
        commentEdge: {
          __typename: 'IssueCommentEdge',
          node: {
            __typename: 'IssueComment',
            id: commentGlobalId(found.repo, found.issue.number, comment.id),
            body: comment.body,
          },
          cursor: encodeCursor(comment.seq),
        },
      };
    }
    ctx.errors.push({ message: `Cannot query field "${field.name}" on type "Mutation".` });
    return undefined;
  }

  if (!parent) return undefined;
  const repo = (parent as NodeValue).__repo as Repo | undefined;

  if (parentType === 'Repository' && repo) {
    if (field.name === 'issue') {
      const number = args.number as number;
      const issue = repo.issues.find((entry) => entry.number === number);
      return issue ? issueNode(ctx.store, repo, issue) : null;
    }
    if (field.name === 'issues') return issuesConnection(ctx, repo, args);
    if (field.name === 'pullRequests') return pullsConnection(ctx, repo, args);
    if (field.name === 'pullRequest') {
      const number = args.number as number;
      const pull = repo.pulls.find((entry) => entry.number === number);
      return pull ? pullNode(ctx.store, repo, pull) : null;
    }
    return (parent as Record<string, unknown>)[field.name];
  }

  if (parentType === 'PullRequest' && repo) {
    const pull = (parent as NodeValue).__pull as Pull;
    if (field.name === 'files') {
      refreshPull(repo, pull);
      const files = pullFiles(repo, pull).map((file) => ({
        __typename: 'PullRequestChangedFile',
        path: file.filename,
        additions: file.additions,
        deletions: file.deletions,
        changeType: file.status === 'added' ? 'ADDED' : 'MODIFIED',
      }));
      const first = typeof args.first === 'number' ? args.first : files.length;
      const nodes = files.slice(0, Math.max(0, first));
      return {
        __typename: 'PullRequestChangedFileConnection',
        nodes,
        edges: nodes.map((node, index) => ({ __typename: 'PullRequestChangedFileEdge', node, cursor: encodeCursor(index) })),
        pageInfo: { __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
        totalCount: files.length,
      };
    }
    return (parent as Record<string, unknown>)[field.name];
  }

  if (parentType === '__Type' && parent) {
    const typeName = (parent as NodeValue).__typeName as string;
    if (field.name === 'fields') {
      const names = TYPE_FIELDS[typeName] ?? [];
      return names.map((name) => ({ __typename: '__Field', name, description: null, args: [], type: null }));
    }
    if (field.name === 'enumValues') {
      const names = TYPE_ENUM_VALUES[typeName] ?? [];
      return names.map((name) => ({ __typename: '__EnumValue', name, description: null }));
    }
    if (field.name === 'name') return typeName;
    if (field.name === 'kind') return TYPE_ENUM_VALUES[typeName] ? 'ENUM' : 'OBJECT';
    return null;
  }

  if (parentType === 'IssueCommentEdge' || parentType === 'IssueEdge' || parentType === 'PullRequestEdge') {
    return (parent as Record<string, unknown>)[field.name];
  }

  return (parent as Record<string, unknown>)[field.name];
}

function executeSelectionSet(
  ctx: GqlContext,
  parentType: string,
  parent: NodeValue | null,
  selections: GqlSelection[],
  variables: Variables,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.typeCondition !== null && parent !== null && parent.__typename !== selection.typeCondition) continue;
      if (selection.typeCondition !== null && parent === null) continue;
      const fragmentOut = executeSelectionSet(ctx, parentType, parent, selection.selections, variables);
      Object.assign(out, fragmentOut);
      continue;
    }
    const field = selection;
    const responseKey = field.alias ?? field.name;
    // __typename is always available.
    if (field.name === '__typename') {
      out[responseKey] = parentType;
      continue;
    }
    const value = resolveField(ctx, parentType, parent, field, variables);
    if (value === undefined) continue;
    if (value === null) {
      out[responseKey] = null;
      continue;
    }
    if (Array.isArray(value)) {
      if (field.selections.length === 0) {
        out[responseKey] = value;
        continue;
      }
      out[responseKey] = value.map((item) => {
        if (item !== null && typeof item === 'object' && '__typename' in (item as Record<string, unknown>)) {
          const node = item as NodeValue;
          return executeSelectionSet(ctx, node.__typename, node, field.selections, variables);
        }
        return item;
      });
      continue;
    }
    if (typeof value !== 'object') {
      out[responseKey] = value;
      continue;
    }
    const node = value as NodeValue;
    const childType = node.__typename ?? parentType;
    if (field.selections.length === 0) {
      out[responseKey] = value;
      continue;
    }
    out[responseKey] = executeSelectionSet(ctx, childType, node, field.selections, variables);
  }
  return out;
}

function executeOperation(store: Store, operation: GqlOperation, variables: Variables): { data: unknown; errors?: Array<{ message: string }> } {
  const ctx: GqlContext = { store, errors: [] };
  const mergedVariables: Variables = { ...variables };
  for (const [name, defaultValue] of Object.entries(operation.variables)) {
    if (mergedVariables[name] === undefined && defaultValue !== undefined) {
      mergedVariables[name] = resolveValue(defaultValue, {});
    }
  }
  const type = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelectionSet(ctx, type, null, operation.selections, mergedVariables);
  if (ctx.errors.length > 0) return { data, errors: ctx.errors };
  return { data };
}

/** Handle POST /api/graphql. `authed` is false when no valid bearer token was presented. */
export function handleGraphQL(store: Store, req: HttpRequest, authed: boolean): HttpResult {
  if (!authed) return jsonResult(401, { message: 'Requires authentication' });
  let body: unknown;
  try {
    body = JSON.parse(req.body.toString('utf8')) as unknown;
  } catch {
    return jsonResult(400, { message: 'Request body must be valid JSON' });
  }
  const runOne = (entry: unknown): { data: unknown; errors?: Array<{ message: string }> } => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return { data: null, errors: [{ message: 'Request body must be a GraphQL operation object' }] };
    }
    const record = entry as Record<string, unknown>;
    const query = record.query;
    if (typeof query !== 'string') return { data: null, errors: [{ message: 'Request body must carry a query string' }] };
    const variables = (record.variables ?? {}) as Variables;
    let operations: GqlOperation[];
    try {
      operations = new Parser(tokenize(query)).parseDocument();
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : 'Could not parse the query' }] };
    }
    const operationName = typeof record.operationName === 'string' ? record.operationName : null;
    let operation = operations[0];
    if (operationName) {
      operation = operations.find((op) => op.name === operationName) ?? operations[0];
    }
    if (!operation) return { data: null, errors: [{ message: 'The document holds no operation' }] };
    return executeOperation(store, operation, variables);
  };
  if (Array.isArray(body)) {
    return jsonResult(200, body.map((entry) => runOne(entry)));
  }
  return jsonResult(200, runOne(body));
}
