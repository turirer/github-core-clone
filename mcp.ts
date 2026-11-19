// Model Context Protocol endpoint at /mcp (Streamable HTTP, JSON bodies).
// Speaks the modern 2026-07-28 era (server/discover, no handshake) and also
// answers the legacy initialize handshake. Tools act on the same Store as REST.

import { emptyResult, isRecord, jsonResult, type HttpRequest, type HttpResult } from './http.ts';
import {
  pullMergeable,
  refreshPull,
  squashMerge,
  VIEWER_LOGIN,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

const SERVER_NAME = 'forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
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
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
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
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: repo.id * 100000 + issue.number,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: repo.id * 100000 + pull.number,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: pullMergeable(repo, pull) === 'MERGEABLE',
    head: { ref: pull.head, sha: pull.headSha },
    base: { ref: pull.base, sha: pull.baseSha },
  };
}

interface ToolOutcome {
  ok: boolean;
  value: Record<string, unknown>;
}

function toolError(message: string): ToolOutcome {
  return { ok: false, value: { error: message } };
}

function dispatchTool(store: Store, name: string, args: Record<string, unknown>): ToolOutcome {
  const owner = typeof args.owner === 'string' ? args.owner : '';
  const repoName = typeof args.repo === 'string' ? args.repo : '';
  const lookup = (): Repo | null => {
    if (owner !== VIEWER_LOGIN) return null;
    return store.getRepo(owner, repoName) ?? null;
  };

  if (name === 'create_repo') {
    const repoNameArg = typeof args.name === 'string' ? args.name.trim() : '';
    if (repoNameArg === '') return toolError('name is required');
    const description = typeof args.description === 'string' ? args.description : '';
    const isPrivate = args.private === true;
    const existing = store.getRepo(VIEWER_LOGIN, repoNameArg);
    if (existing) return { ok: true, value: repoJson(existing) };
    const repo = store.createRepo(VIEWER_LOGIN, repoNameArg, description, isPrivate);
    if (!repo) return toolError('Repository already exists');
    return { ok: true, value: repoJson(repo) };
  }

  if (name === 'get_repo') {
    const repo = lookup();
    if (!repo) return toolError(`Repository ${owner}/${repoName} was not found`);
    return { ok: true, value: repoJson(repo) };
  }

  if (name === 'create_issue') {
    const repo = lookup();
    if (!repo) return toolError(`Repository ${owner}/${repoName} was not found`);
    const title = typeof args.title === 'string' ? args.title : '';
    if (title === '') return toolError('title is required');
    const body = typeof args.body === 'string' ? args.body : '';
    const issue: Issue = { number: repo.nextIssue, title, body, state: 'open', labels: [], comments: [], seq: repo.nextIssue };
    repo.nextIssue += 1;
    repo.issues.push(issue);
    return { ok: true, value: issueJson(repo, issue) };
  }

  if (name === 'list_issues') {
    const repo = lookup();
    if (!repo) return toolError(`Repository ${owner}/${repoName} was not found`);
    const state = typeof args.state === 'string' ? args.state : 'open';
    let issues = [...repo.issues];
    if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
    else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
    issues.sort((a, b) => b.seq - a.seq);
    return { ok: true, value: { issues: issues.map((issue) => issueJson(repo, issue)) } };
  }

  if (name === 'create_pull_request') {
    const repo = lookup();
    if (!repo) return toolError(`Repository ${owner}/${repoName} was not found`);
    const title = typeof args.title === 'string' ? args.title : '';
    const head = typeof args.head === 'string' ? args.head : '';
    const base = typeof args.base === 'string' ? args.base : repo.defaultBranch;
    const body = typeof args.body === 'string' ? args.body : '';
    if (title === '' || head === '' || base === '') return toolError('title, head and base are required');
    const headSha = repo.refs.get(`refs/heads/${head}`);
    const baseSha = repo.refs.get(`refs/heads/${base}`);
    if (!headSha) return toolError(`head branch ${head} does not exist`);
    if (!baseSha) return toolError(`base branch ${base} does not exist`);
    const pull: Pull = {
      number: repo.nextPull, title, body, state: 'open', head, base, headSha, baseSha,
      merged: false, mergedAt: null, mergeCommitSha: null, seq: repo.nextPull,
    };
    repo.nextPull += 1;
    repo.pulls.push(pull);
    return { ok: true, value: pullJson(repo, pull) };
  }

  if (name === 'merge_pull_request') {
    const repo = lookup();
    if (!repo) return toolError(`Repository ${owner}/${repoName} was not found`);
    const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
    if (!Number.isInteger(number)) return toolError('pull_number is required');
    const pull = repo.pulls.find((entry) => entry.number === number);
    if (!pull) return toolError(`Pull request #${number} was not found`);
    refreshPull(repo, pull);
    const result = squashMerge(store, repo, pull);
    if (!result.ok) return toolError(result.message);
    return { ok: true, value: { merged: true, number, sha: result.sha, state: 'closed' } };
  }

  return toolError(`Unknown tool ${name}`);
}

function rpcResult(id: unknown, result: unknown): HttpResult {
  return jsonResult(200, { jsonrpc: '2.0', id, result });
}

function rpcError(id: unknown, code: number, message: string): HttpResult {
  return jsonResult(200, { jsonrpc: '2.0', id, error: { code, message } });
}

/** Handle POST /mcp. `authed` is false when no valid bearer token was presented. */
export function handleMcp(store: Store, req: HttpRequest, authed: boolean): HttpResult {
  if (req.method === 'DELETE') return emptyResult(200);
  if (req.method !== 'POST') return jsonResult(405, { message: 'Method Not Allowed' });
  if (!authed) return jsonResult(401, { message: 'Requires authentication' });

  let body: unknown;
  try {
    body = JSON.parse(req.body.toString('utf8')) as unknown;
  } catch {
    return jsonResult(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  if (!isRecord(body)) {
    return jsonResult(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  const id = body.id ?? null;
  const method = typeof body.method === 'string' ? body.method : '';
  const params = isRecord(body.params) ? body.params : {};

  // Notifications carry no id: acknowledge with 202 and no body.
  if (body.id === undefined) {
    if (method.startsWith('notifications/')) return emptyResult(202);
    return rpcError(null, -32600, 'Invalid Request');
  }

  if (method === 'server/discover') {
    return rpcResult(id, {
      supportedVersions: SUPPORTED_VERSIONS,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions: 'A GitHub-compatible git forge: create repositories, issues and pull requests.',
    });
  }

  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const negotiated = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
    return rpcResult(id, {
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }

  if (method === 'tools/list') {
    return rpcResult(id, { tools: TOOLS });
  }

  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
    const tool = TOOLS.find((entry) => entry.name === name);
    if (!tool) return rpcError(id, -32602, `Unknown tool ${name}`);
    const required = (tool.inputSchema.required ?? []) as string[];
    const missing = required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
    if (missing.length > 0) {
      return rpcResult(id, {
        content: [{ type: 'text', text: `Missing required argument(s): ${missing.join(', ')}` }],
        isError: true,
      });
    }
    const outcome = dispatchTool(store, name, args);
    const text = JSON.stringify(outcome.value);
    return rpcResult(id, {
      content: [{ type: 'text', text }],
      structuredContent: outcome.value,
      isError: !outcome.ok,
    });
  }

  if (method === 'ping') {
    return rpcResult(id, {});
  }

  return rpcError(id, -32601, `Method not found: ${method}`);
}
